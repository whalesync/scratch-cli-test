import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { RoutineRun as PrismaRoutineRun, RoutineRunStep as PrismaRoutineRunStep } from '@prisma/client';
import {
  CreateRoutineFileDto,
  isActiveRoutineRunStatus,
  Job,
  ListRoutineFilesQueryDto,
  ListRoutineFilesResponse,
  PushRoutineFilesBlockedStaleDto,
  PushRoutineFilesDto,
  PushRoutineFilesResponse,
  Routine,
  RoutineFileContent,
  RoutineRun,
  RoutineRunListQueryDto,
  UpdateRoutineFileDto,
  WorkbookId,
} from '@spinner/shared-types';
import { AuditLogService } from 'src/audit/audit-log.service';
import { DbService } from 'src/db/db.service';
import { jobEntityToJob } from 'src/job/entities/job.entity';
import { JobService } from 'src/job/job.service';
import { WSLogger } from 'src/logger';
import { ScheduleService } from 'src/schedule/schedule.service';
import { Actor } from 'src/users/types';
import { RoutineRunEntity } from './entities/routine-run.entity';
import { RoutineEntity } from './entities/routine.entity';
import {
  RoutineDefinitionPushDelete,
  RoutineDefinitionSource,
  RoutineDefinitionStoreService,
} from './routine-definition-store.service';
import { assertValidRoutineFilePath } from './routine-file-path';
import { RoutineGitMirrorService } from './routine-git-mirror.service';
import { RoutineParserService } from './routine-parser.service';
import { RoutineReferenceValidatorService, validateRoutineReferences } from './routine-reference-validator.service';
import { ParsedRoutine, RoutineParseResult } from './routine.types';

/** Cap on runs returned by the list endpoint (newest first). */
const ROUTINE_RUNS_LIST_LIMIT = 100;

/** What {@link RoutineService.upsertRoutineFile} did with the file. */
export type RoutineFileUpsertOutcome = 'created' | 'updated' | 'unchanged';

/**
 * Routine definitions live in Postgres (`RoutineDefinition`, DEV-11399) behind
 * {@link RoutineDefinitionStoreService}; this service adds validation, audit logging, the join with
 * schedules + run history, and the transitional git mirror ({@link RoutineGitMirrorService}) that
 * keeps `routines/*.yaml` in the config repo current for pre-DEV-11399 CLIs. "File" in the method
 * names is the routine's identity (its `routines/<name>.yaml` path), not where it is stored.
 */
@Injectable()
export class RoutineService {
  constructor(
    private readonly db: DbService,
    private readonly routineDefinitionStore: RoutineDefinitionStoreService,
    private readonly routineGitMirror: RoutineGitMirrorService,
    private readonly scheduleService: ScheduleService,
    private readonly parser: RoutineParserService,
    private readonly referenceValidator: RoutineReferenceValidatorService,
    private readonly auditLogService: AuditLogService,
    private readonly jobService: JobService,
  ) {}

  /**
   * Reads every routine definition (running the one-time git import for a workbook that predates
   * the table) and returns the discovered routines (malformed YAML carries a `parseError`), each
   * joined with its ROUTINE Schedule row + latest run. The routine YAML no longer owns the schedule
   * (DEV-10478), so reload performs no schedule writes other than orphan-cleaning ROUTINE schedules
   * whose routine no longer exists. It does NOT execute anything.
   */
  async reloadRoutines(workbookId: WorkbookId, actor: Actor): Promise<Routine[]> {
    const parseResultsByFilePath = await this.readAndParseRoutineFiles(workbookId);

    // The routine YAML no longer owns the cron (DEV-10478) — schedules are created/edited via the
    // Schedule CRUD API. Reload therefore writes no schedules; it only orphan-cleans: a ROUTINE
    // schedule whose routine file is gone is referential garbage and is removed. Files that exist
    // but fail to parse are still "present" and so are NOT orphaned (their schedule is preserved).
    await this.scheduleService.deleteOrphanedRoutineSchedules(workbookId, [...parseResultsByFilePath.keys()]);

    WSLogger.info({
      source: 'RoutineService.reloadRoutines',
      message: `Reloaded ${parseResultsByFilePath.size} routine file(s)`,
      workbookId,
    });
    await this.auditLogService.logEvent({
      actor,
      eventType: 'update',
      message: `Reloaded ${parseResultsByFilePath.size} routine(s)`,
      entityId: workbookId,
      organizationId: actor.organizationId,
    });

    return this.assembleRoutines(workbookId, parseResultsByFilePath);
  }

  /** Lists routines by reading + parsing every stored definition, joined with schedule + latest-run state. Read-only. */
  async listRoutines(workbookId: WorkbookId): Promise<Routine[]> {
    const parseResultsByFilePath = await this.readAndParseRoutineFiles(workbookId);
    return this.assembleRoutines(workbookId, parseResultsByFilePath);
  }

  /**
   * Lists run history for a workbook, newest first, optionally filtered to one routine file. When
   * `includeJobs` is set, each run is loaded with its steps and every step carries its job (the
   * pull/sync/publish job in the `/jobs` wire shape); all step jobs are fetched in a single batch.
   *
   * Every row carries `currentStepSummary` — what an active run is doing right now — so a polling list
   * view doesn't have to fetch each active run's detail on every tick just to read that one string.
   * Terminal runs need no extra query for it (it is null for them), so the common all-finished list
   * still costs exactly the queries it did before.
   */
  async listRuns(workbookId: WorkbookId, query: RoutineRunListQueryDto): Promise<RoutineRun[]> {
    const where = {
      workbookId,
      ...(query.routineFilePath ? { routineFilePath: query.routineFilePath } : {}),
    };

    if (!query.includeJobs) {
      const runs = await this.db.client.routineRun.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: ROUTINE_RUNS_LIST_LIMIT,
      });
      const currentStepSummaryByRunId = await this.deriveCurrentStepSummariesForActiveRuns(runs);
      return runs.map((run) =>
        RoutineRunEntity.from(run, { currentStepSummary: currentStepSummaryByRunId.get(run.id) ?? null }),
      );
    }

    const runs = await this.db.client.routineRun.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: ROUTINE_RUNS_LIST_LIMIT,
      include: { steps: { orderBy: { stepIndex: 'asc' } } },
    });
    const jobsByBullJobId = await this.fetchJobsByBullJobId(runs.flatMap((run) => run.steps));
    return runs.map((run) =>
      RoutineRunEntity.from(run, {
        jobsByBullJobId,
        currentStepSummary: RoutineRunEntity.currentStepSummaryFrom(run, run.steps, jobsByBullJobId),
      }),
    );
  }

  /**
   * Fetches a single run with its per-step detail. 404 if missing or in another workbook. When
   * `includeJobs` is set, each step also carries its job (the `/jobs` wire shape). An ACTIVE run's
   * in-flight step job is loaded either way — `currentStepSummary` is derived from its live progress —
   * but the steps themselves only carry a `job` field when the request asked for it.
   */
  async getRun(workbookId: WorkbookId, runId: string, includeJobs?: boolean): Promise<RoutineRun> {
    const run = await this.db.client.routineRun.findFirst({
      where: { id: runId, workbookId },
      include: { steps: { orderBy: { stepIndex: 'asc' } } },
    });
    if (!run) {
      throw new NotFoundException(`Routine run ${runId} not found`);
    }
    if (!includeJobs) {
      const jobsForCurrentStep = await this.fetchJobForInFlightStep(run, run.steps);
      return RoutineRunEntity.from(run, {
        currentStepSummary: RoutineRunEntity.currentStepSummaryFrom(run, run.steps, jobsForCurrentStep),
      });
    }
    const jobsByBullJobId = await this.fetchJobsByBullJobId(run.steps);
    return RoutineRunEntity.from(run, {
      jobsByBullJobId,
      currentStepSummary: RoutineRunEntity.currentStepSummaryFrom(run, run.steps, jobsByBullJobId),
    });
  }

  /**
   * Resolves `currentStepSummary` for every ACTIVE run in a list, keyed by run id. Finished runs are
   * described by their persisted `resultSummary`, so they are skipped entirely: with no active run
   * this issues no queries at all, and otherwise it costs one steps query plus one batched job-progress
   * query for just the in-flight steps (never every step of every listed run).
   */
  private async deriveCurrentStepSummariesForActiveRuns(runs: PrismaRoutineRun[]): Promise<Map<string, string>> {
    const activeRunIds = runs.filter((run) => isActiveRoutineRunStatus(run.status)).map((run) => run.id);
    if (activeRunIds.length === 0) {
      return new Map();
    }

    const steps = await this.db.client.routineRunStep.findMany({
      where: { runId: { in: activeRunIds } },
      orderBy: { stepIndex: 'asc' },
    });
    const stepsByRunId = new Map<string, PrismaRoutineRunStep[]>();
    for (const step of steps) {
      const stepsForRun = stepsByRunId.get(step.runId) ?? [];
      stepsForRun.push(step);
      stepsByRunId.set(step.runId, stepsForRun);
    }

    const inFlightSteps = runs.flatMap((run) => {
      const inFlightStep = RoutineRunEntity.inFlightStepRowFrom(run, stepsByRunId.get(run.id) ?? []);
      return inFlightStep ? [inFlightStep] : [];
    });
    const jobsByBullJobId = await this.fetchJobsByBullJobId(inFlightSteps);

    const currentStepSummaryByRunId = new Map<string, string>();
    for (const run of runs) {
      const summary = RoutineRunEntity.currentStepSummaryFrom(run, stepsByRunId.get(run.id) ?? [], jobsByBullJobId);
      if (summary) {
        currentStepSummaryByRunId.set(run.id, summary);
      }
    }
    return currentStepSummaryByRunId;
  }

  /**
   * Loads just the job of the step a run is executing right now (empty for a terminal run, or for a
   * step that hasn't been enqueued yet). Lets the run-detail endpoint describe live progress without
   * pulling every step's job — that stays behind `includeJobs`.
   */
  private async fetchJobForInFlightStep(
    run: PrismaRoutineRun,
    steps: PrismaRoutineRunStep[],
  ): Promise<Map<string, Job>> {
    const inFlightStep = RoutineRunEntity.inFlightStepRowFrom(run, steps);
    return this.fetchJobsByBullJobId(inFlightStep ? [inFlightStep] : []);
  }

  /**
   * Batch-loads the jobs for a set of routine steps, keyed by BullMQ job id, in the shared `Job` wire
   * shape. `RoutineRunStep.jobId` holds the BullMQ job id, so this is one `getJobsProgress` query for
   * every step (across all runs when listing). Steps with no job — or whose job has aged out of
   * retention — are simply absent from the map; the entity resolves those to `null`.
   */
  private async fetchJobsByBullJobId(steps: { jobId: string | null }[]): Promise<Map<string, Job>> {
    const bullJobIds = steps.map((step) => step.jobId).filter((jobId): jobId is string => jobId != null);
    if (bullJobIds.length === 0) {
      return new Map();
    }
    const jobEntities = await this.jobService.getJobsProgress(bullJobIds);
    return new Map(
      jobEntities
        .filter((entity) => entity.bullJobId != null)
        .map((entity) => [entity.bullJobId as string, jobEntityToJob(entity)]),
    );
  }

  // ── file editing (create / read / update / delete the raw YAML) ───────────────

  /** Reads the raw YAML text of a single routine file. 404 if it doesn't exist. */
  async getRoutineFileContent(workbookId: WorkbookId, path: string): Promise<RoutineFileContent> {
    assertValidRoutineFilePath(path);
    const definition = await this.routineDefinitionStore.getDefinition(workbookId, path);
    if (definition === null) {
      throw new NotFoundException(`Routine file ${path} not found`);
    }
    return { path, content: definition.content };
  }

  /**
   * Every routine file with its optimistic-concurrency `version` (and, unless `metadataOnly`, its
   * YAML text) — what an API-backed `scratchmd routines pull|status` materializes locally instead
   * of fetching the config git repo.
   */
  async listRoutineFiles(workbookId: WorkbookId, query: ListRoutineFilesQueryDto): Promise<ListRoutineFilesResponse> {
    const definitions = await this.routineDefinitionStore.listDefinitions(workbookId);
    return {
      files: definitions.map((definition) => ({
        path: definition.filePath,
        version: definition.version,
        updatedAt: definition.updatedAt.toISOString(),
        ...(query.metadataOnly ? {} : { content: definition.content }),
      })),
    };
  }

  /**
   * Creates a new routine YAML file. Fails fast: rejects an invalid path (400), a path that
   * already exists (409), or content that doesn't parse/validate (400) — nothing is committed
   * unless the YAML is a valid routine. The schedule is managed separately via the Schedule API.
   */
  async createRoutineFile(
    workbookId: WorkbookId,
    dto: CreateRoutineFileDto,
    actor: Actor,
    options: { source?: RoutineDefinitionSource } = {},
  ): Promise<Routine> {
    assertValidRoutineFilePath(dto.path);

    const existing = await this.routineDefinitionStore.getDefinition(workbookId, dto.path);
    if (existing !== null) {
      throw new ConflictException(`Routine file ${dto.path} already exists`);
    }

    const parseResult = this.parser.parse(dto.content);
    if ('error' in parseResult) {
      throw new BadRequestException(parseResult.error);
    }
    await this.assertRoutineReferencesExist(workbookId, parseResult.routine);

    await this.routineDefinitionStore.upsertDefinition(workbookId, dto.path, dto.content, {
      source: options.source ?? 'web',
      updatedByUserId: actor.userId,
    });
    this.routineGitMirror.mirrorWorkbookRoutinesInBackground(workbookId, actor);

    await this.auditLogService.logEvent({
      actor,
      eventType: 'create',
      message: `Created routine "${parseResult.routine.name}" (${dto.path})`,
      entityId: workbookId,
      organizationId: actor.organizationId,
    });

    return this.buildSingleRoutine(workbookId, dto.path, parseResult);
  }

  /**
   * Replaces the content of an existing routine file. Fails fast: rejects an invalid path (400),
   * a missing file (404), or content that doesn't parse/validate (400). The schedule is managed
   * separately via the Schedule API and is unaffected by editing the routine file.
   */
  async updateRoutineFile(
    workbookId: WorkbookId,
    dto: UpdateRoutineFileDto,
    actor: Actor,
    options: { source?: RoutineDefinitionSource } = {},
  ): Promise<Routine> {
    assertValidRoutineFilePath(dto.path);

    const existing = await this.routineDefinitionStore.getDefinition(workbookId, dto.path);
    if (existing === null) {
      throw new NotFoundException(`Routine file ${dto.path} not found`);
    }

    const parseResult = this.parser.parse(dto.content);
    if ('error' in parseResult) {
      throw new BadRequestException(parseResult.error);
    }
    await this.assertRoutineReferencesExist(workbookId, parseResult.routine);

    await this.routineDefinitionStore.upsertDefinition(workbookId, dto.path, dto.content, {
      source: options.source ?? 'web',
      updatedByUserId: actor.userId,
    });
    this.routineGitMirror.mirrorWorkbookRoutinesInBackground(workbookId, actor);

    await this.auditLogService.logEvent({
      actor,
      eventType: 'update',
      message: `Updated routine "${parseResult.routine.name}" (${dto.path})`,
      entityId: workbookId,
      organizationId: actor.organizationId,
    });

    return this.buildSingleRoutine(workbookId, dto.path, parseResult);
  }

  /**
   * Creates the routine file when absent, replaces it when the stored content differs, and leaves
   * it untouched (no write, no audit event, no mirror) when the stored content is byte-identical.
   * Same validation as create/update: invalid path (400), unparseable YAML (400), dangling
   * references (400). Used by callers that regenerate a routine on every save (the Live Export's
   * generated `run-<syncId>.yaml`, which passes `source: 'generated'`), so a generator improvement
   * reaches existing routines instead of only brand-new ones.
   */
  async upsertRoutineFile(
    workbookId: WorkbookId,
    dto: CreateRoutineFileDto,
    actor: Actor,
    options: { source?: RoutineDefinitionSource } = {},
  ): Promise<{ routine: Routine; outcome: RoutineFileUpsertOutcome }> {
    assertValidRoutineFilePath(dto.path);

    const existing = await this.routineDefinitionStore.getDefinition(workbookId, dto.path);
    if (existing === null) {
      return { routine: await this.createRoutineFile(workbookId, dto, actor, options), outcome: 'created' };
    }
    if (existing.content === dto.content) {
      const parseResult = this.parser.parse(dto.content);
      if ('error' in parseResult) {
        throw new BadRequestException(parseResult.error);
      }
      return { routine: await this.buildSingleRoutine(workbookId, dto.path, parseResult), outcome: 'unchanged' };
    }
    return { routine: await this.updateRoutineFile(workbookId, dto, actor, options), outcome: 'updated' };
  }

  /** Deletes a routine file and its ROUTINE schedule (if any). 404 if the file doesn't exist. */
  async deleteRoutineFile(workbookId: WorkbookId, path: string, actor: Actor): Promise<void> {
    assertValidRoutineFilePath(path);

    const deleted = await this.routineDefinitionStore.deleteDefinition(workbookId, path);
    if (!deleted) {
      throw new NotFoundException(`Routine file ${path} not found`);
    }
    this.routineGitMirror.mirrorWorkbookRoutinesInBackground(workbookId, actor);
    await this.scheduleService.deleteRoutineScheduleByFilePath(workbookId, path);

    await this.auditLogService.logEvent({
      actor,
      eventType: 'delete',
      message: `Deleted routine ${path}`,
      entityId: workbookId,
      organizationId: actor.organizationId,
    });
  }

  /**
   * Batch-pushes routine files from the CLI: a set of upserts (created/edited files) and deletes
   * (removed paths) applied to the routine definitions atomically, then reconciled via Reload
   * Routines. This is the server side of `scratchmd routines push`.
   *
   * Fail-fast at the boundary: every path is bounds-checked and every upsert is parsed +
   * reference-validated BEFORE anything is written, so an invalid push writes nothing. Optimistic
   * concurrency is per file: an upsert/delete carrying `baseVersion` must still match the stored
   * `RoutineDefinition.version` (or `null` for "expect new"), otherwise the whole push is refused
   * with a 409 `blocked_stale` naming the stale files (the CLI prompts a `routines pull` + retry)
   * — a stale push never clobbers newer routines. The pre-DEV-11399 `baseHead` git SHA is ignored
   * (logged) because routine definitions no longer live in git.
   *
   * Unlike the single-file create/update endpoints this uses upsert semantics: a file is created or
   * overwritten either way (no 409-on-exists), and deleting an absent file is a no-op.
   */
  async pushRoutineFiles(
    workbookId: WorkbookId,
    dto: PushRoutineFilesDto,
    actor: Actor,
  ): Promise<PushRoutineFilesResponse> {
    // 1. Validate every path (upserts + deletes) up front; reject a path listed in both.
    const deletes: RoutineDefinitionPushDelete[] = dto.deletes.map((deletion) =>
      typeof deletion === 'string'
        ? { filePath: deletion, baseVersion: undefined }
        : { filePath: deletion.path, baseVersion: deletion.baseVersion },
    );
    for (const upsert of dto.upserts) {
      assertValidRoutineFilePath(upsert.path);
    }
    for (const deletion of deletes) {
      assertValidRoutineFilePath(deletion.filePath);
    }
    const deletePathSet = new Set(deletes.map((deletion) => deletion.filePath));
    const pathsBothUpsertedAndDeleted = dto.upserts
      .map((upsert) => upsert.path)
      .filter((path) => deletePathSet.has(path));
    if (pathsBothUpsertedAndDeleted.length > 0) {
      throw new BadRequestException(
        `routine file path(s) cannot be both upserted and deleted: ${pathsBothUpsertedAndDeleted.join(', ')}`,
      );
    }

    if (dto.baseHead) {
      // A pre-DEV-11399 CLI. Its git-SHA guard has no meaning against Postgres-held definitions
      // (and would false-positive against the lagging mirror), so it is ignored — but counted, so
      // we can see when the old binaries are gone and the mirror can be switched off.
      WSLogger.warn({
        source: 'RoutineService.pushRoutineFiles',
        message: 'Ignoring deprecated baseHead on routines push (pre-DEV-11399 CLI)',
        workbookId,
        userId: actor.userId,
      });
    }

    // 2. Parse + reference-validate every upsert before any write (the server is authoritative on
    //    references — the CLI cannot resolve a workbook's folders/connections).
    for (const upsert of dto.upserts) {
      const parseResult = this.parser.parse(upsert.content);
      if ('error' in parseResult) {
        throw new BadRequestException(`${upsert.path}: ${parseResult.error}`);
      }
      await this.assertRoutineReferencesExist(workbookId, parseResult.routine);
    }

    // 3. Apply atomically under the per-workbook lock; the store checks every baseVersion first
    //    and writes nothing when any is stale.
    const pushResult = await this.routineDefinitionStore.applyPush(workbookId, {
      upserts: dto.upserts.map((upsert) => ({
        filePath: upsert.path,
        content: upsert.content,
        baseVersion: upsert.baseVersion,
      })),
      deletes,
      source: 'cli',
      updatedByUserId: actor.userId,
    });
    if (pushResult.status === 'blocked_stale') {
      const blockedStale: PushRoutineFilesBlockedStaleDto = {
        status: 'blocked_stale',
        staleFiles: pushResult.staleFiles,
        message: `Server routines have changed since your last pull (${pushResult.staleFiles
          .map((staleFile) => staleFile.path)
          .join(', ')}). Run \`scratchmd routines pull\`, then retry the push.`,
      };
      throw new ConflictException(blockedStale);
    }

    // 4. Reconcile all ROUTINE schedules from the just-written definitions, then mirror to git
    //    synchronously so pre-DEV-11399 CLIs get the head they re-materialize to. A mirror failure
    //    must not fail the push — the definitions are already saved — so it degrades to `head: ''`
    //    (the old CLI's "nothing to re-materialize"; it cannot deserialize a null here).
    const routines = await this.reloadRoutines(workbookId, actor);
    let head = '';
    try {
      head = (await this.routineGitMirror.mirrorWorkbookRoutines(workbookId, actor)) ?? '';
    } catch (error) {
      WSLogger.warn({
        source: 'RoutineService.pushRoutineFiles',
        message: 'Routines were saved but mirroring them to the workbook config repo failed',
        workbookId,
        error,
      });
    }

    await this.auditLogService.logEvent({
      actor,
      eventType: 'update',
      message: `Pushed routines: ${pushResult.upsertedFilePaths.length} upsert(s), ${pushResult.deletedFilePaths.length} delete(s)`,
      entityId: workbookId,
      organizationId: actor.organizationId,
    });

    return { files: pushResult.files, head, routines };
  }

  // ── internals ────────────────────────────────────────────────────────────────

  /**
   * Blocks a create/update when a routine references a folder or connection that does not exist in
   * the workbook. Runs after the structural parse succeeds and before the git commit, so nothing is
   * written unless every reference resolves. Joins with "; " to match the structural validator's
   * message format.
   */
  private async assertRoutineReferencesExist(workbookId: WorkbookId, routine: ParsedRoutine): Promise<void> {
    const referenceErrors = await this.referenceValidator.validateRoutine(workbookId, routine);
    if (referenceErrors.length > 0) {
      throw new BadRequestException(referenceErrors.join('; '));
    }
  }

  /**
   * Reads every stored routine definition and parses each. Key = file path. The store runs the
   * one-time git import first, so this is always the COMPLETE set — `reloadRoutines` relies on
   * that to orphan-clean schedules safely.
   */
  private async readAndParseRoutineFiles(workbookId: WorkbookId): Promise<Map<string, RoutineParseResult>> {
    const definitions = await this.routineDefinitionStore.listDefinitions(workbookId);
    const parseResultsByFilePath = new Map<string, RoutineParseResult>();
    for (const definition of definitions) {
      parseResultsByFilePath.set(definition.filePath, this.parser.parse(definition.content));
    }
    return parseResultsByFilePath;
  }

  /** Joins parsed routines with their ROUTINE schedule rows and latest-run summaries. */
  private async assembleRoutines(
    workbookId: WorkbookId,
    parseResultsByFilePath: Map<string, RoutineParseResult>,
  ): Promise<Routine[]> {
    const filePaths = [...parseResultsByFilePath.keys()];

    const schedules = await this.scheduleService.findRoutineSchedules(workbookId);
    const scheduleByFilePath = new Map(schedules.map((schedule) => [schedule.entityId, schedule]));
    const latestRunByFilePath = await this.findLatestRunByFilePath(workbookId, filePaths);
    // Load the workbook's folders + connections ONCE, then reference-check every parsed routine
    // in-memory (no per-routine queries). These surface as non-blocking warnings: a folder can be
    // deleted after a routine was validly saved, and we must not drop the routine from the list.
    const validationContext = await this.referenceValidator.loadContext(workbookId);

    return [...parseResultsByFilePath.entries()].map(([filePath, parseResult]) =>
      RoutineEntity.build({
        filePath,
        parseResult,
        schedule: scheduleByFilePath.get(filePath) ?? null,
        latestRun: latestRunByFilePath.get(filePath) ?? null,
        referenceWarnings:
          'routine' in parseResult ? validateRoutineReferences(parseResult.routine, validationContext) : [],
      }),
    );
  }

  /** Returns the newest RoutineRun for each given routine file path (absent paths omitted). */
  private async findLatestRunByFilePath(
    workbookId: WorkbookId,
    filePaths: string[],
  ): Promise<Map<string, PrismaRoutineRun>> {
    if (filePaths.length === 0) {
      return new Map();
    }
    const runs = await this.db.client.routineRun.findMany({
      where: { workbookId, routineFilePath: { in: filePaths } },
      orderBy: { createdAt: 'desc' },
    });

    const latestByFilePath = new Map<string, PrismaRoutineRun>();
    for (const run of runs) {
      if (!latestByFilePath.has(run.routineFilePath)) {
        latestByFilePath.set(run.routineFilePath, run);
      }
    }
    return latestByFilePath;
  }

  /** Assembles the joined {@link Routine} for one file (schedule + latest run), mirroring `assembleRoutines`. */
  private async buildSingleRoutine(
    workbookId: WorkbookId,
    filePath: string,
    parseResult: RoutineParseResult,
  ): Promise<Routine> {
    const schedules = await this.scheduleService.findRoutineSchedules(workbookId);
    const schedule = schedules.find((candidate) => candidate.entityId === filePath) ?? null;
    const latestRunByFilePath = await this.findLatestRunByFilePath(workbookId, [filePath]);
    return RoutineEntity.build({
      filePath,
      parseResult,
      schedule,
      latestRun: latestRunByFilePath.get(filePath) ?? null,
    });
  }
}
