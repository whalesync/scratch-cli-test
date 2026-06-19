import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { RoutineRun as PrismaRoutineRun } from '@prisma/client';
import {
  CreateRoutineFileDto,
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
import { WSLogger } from 'src/logger';
import { ScheduleService } from 'src/schedule/schedule.service';
import { MAIN_BRANCH, ScratchGitService } from 'src/scratch-git/scratch-git.service';
import { Actor } from 'src/users/types';
import { getWorkbookRepoPath } from 'src/workbook/workbook-repo.service';
import { RoutineRunEntity } from './entities/routine-run.entity';
import { RoutineEntity } from './entities/routine.entity';
import { assertValidRoutineFilePath, ROUTINES_DIRECTORY } from './routine-file-path';
import { RoutineParserService } from './routine-parser.service';
import { RoutineReferenceValidatorService, validateRoutineReferences } from './routine-reference-validator.service';
import { ParsedRoutine, RoutineParseResult } from './routine.types';

/** Cap on runs returned by the list endpoint (newest first). */
const ROUTINE_RUNS_LIST_LIMIT = 100;

@Injectable()
export class RoutineService {
  constructor(
    private readonly db: DbService,
    private readonly scratchGitService: ScratchGitService,
    private readonly scheduleService: ScheduleService,
    private readonly parser: RoutineParserService,
    private readonly referenceValidator: RoutineReferenceValidatorService,
    private readonly auditLogService: AuditLogService,
  ) {}

  /**
   * Reads `routines/*.yaml` from the workbook config repo and returns the discovered routines
   * (malformed files carry a `parseError`), each joined with its ROUTINE Schedule row + latest run.
   * The routine YAML no longer owns the schedule (DEV-10478), so reload performs no schedule writes
   * other than orphan-cleaning ROUTINE schedules whose file no longer exists. It does NOT execute
   * anything.
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

  /** Lists routines by reading + parsing the config repo, joined with schedule + latest-run state. Read-only. */
  async listRoutines(workbookId: WorkbookId): Promise<Routine[]> {
    const parseResultsByFilePath = await this.readAndParseRoutineFiles(workbookId);
    return this.assembleRoutines(workbookId, parseResultsByFilePath);
  }

  /** Lists run history for a workbook, newest first, optionally filtered to one routine file. */
  async listRuns(workbookId: WorkbookId, query: RoutineRunListQueryDto): Promise<RoutineRun[]> {
    const runs = await this.db.client.routineRun.findMany({
      where: {
        workbookId,
        ...(query.routineFilePath ? { routineFilePath: query.routineFilePath } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: ROUTINE_RUNS_LIST_LIMIT,
    });
    return runs.map((run) => RoutineRunEntity.from(run));
  }

  /** Fetches a single run with its per-step detail. 404 if missing or in another workbook. */
  async getRun(workbookId: WorkbookId, runId: string): Promise<RoutineRun> {
    const run = await this.db.client.routineRun.findFirst({
      where: { id: runId, workbookId },
      include: { steps: { orderBy: { stepIndex: 'asc' } } },
    });
    if (!run) {
      throw new NotFoundException(`Routine run ${runId} not found`);
    }
    return RoutineRunEntity.from(run);
  }

  // ── file editing (create / read / update / delete the raw YAML) ───────────────

  /** Reads the raw YAML text of a single routine file. 404 if it doesn't exist. */
  async getRoutineFileContent(workbookId: WorkbookId, path: string): Promise<RoutineFileContent> {
    assertValidRoutineFilePath(path);
    const repoId = await this.resolveConfigRepoId(workbookId);
    const file = await this.scratchGitService.getRepoFile(repoId, MAIN_BRANCH, path);
    if (file === null) {
      throw new NotFoundException(`Routine file ${path} not found`);
    }
    return { path, content: file.content };
  }

  /**
   * Creates a new routine YAML file. Fails fast: rejects an invalid path (400), a path that
   * already exists (409), or content that doesn't parse/validate (400) — nothing is committed
   * unless the YAML is a valid routine. The schedule is managed separately via the Schedule API.
   */
  async createRoutineFile(workbookId: WorkbookId, dto: CreateRoutineFileDto, actor: Actor): Promise<Routine> {
    assertValidRoutineFilePath(dto.path);
    const repoId = await this.resolveConfigRepoId(workbookId);

    const existing = await this.scratchGitService.getRepoFile(repoId, MAIN_BRANCH, dto.path);
    if (existing !== null) {
      throw new ConflictException(`Routine file ${dto.path} already exists`);
    }

    const parseResult = this.parser.parse(dto.content);
    if ('error' in parseResult) {
      throw new BadRequestException(parseResult.error);
    }
    await this.assertRoutineReferencesExist(workbookId, parseResult.routine);

    await this.scratchGitService.commitFilesToBranch(
      repoId,
      MAIN_BRANCH,
      [{ path: dto.path, content: dto.content }],
      `Create routine ${dto.path} (${actor.userId})`,
    );

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
  async updateRoutineFile(workbookId: WorkbookId, dto: UpdateRoutineFileDto, actor: Actor): Promise<Routine> {
    assertValidRoutineFilePath(dto.path);
    const repoId = await this.resolveConfigRepoId(workbookId);

    const existing = await this.scratchGitService.getRepoFile(repoId, MAIN_BRANCH, dto.path);
    if (existing === null) {
      throw new NotFoundException(`Routine file ${dto.path} not found`);
    }

    const parseResult = this.parser.parse(dto.content);
    if ('error' in parseResult) {
      throw new BadRequestException(parseResult.error);
    }
    await this.assertRoutineReferencesExist(workbookId, parseResult.routine);

    await this.scratchGitService.commitFilesToBranch(
      repoId,
      MAIN_BRANCH,
      [{ path: dto.path, content: dto.content }],
      `Update routine ${dto.path} (${actor.userId})`,
    );

    await this.auditLogService.logEvent({
      actor,
      eventType: 'update',
      message: `Updated routine "${parseResult.routine.name}" (${dto.path})`,
      entityId: workbookId,
      organizationId: actor.organizationId,
    });

    return this.buildSingleRoutine(workbookId, dto.path, parseResult);
  }

  /** Deletes a routine file and its ROUTINE schedule (if any). 404 if the file doesn't exist. */
  async deleteRoutineFile(workbookId: WorkbookId, path: string, actor: Actor): Promise<void> {
    assertValidRoutineFilePath(path);
    const repoId = await this.resolveConfigRepoId(workbookId);

    const existing = await this.scratchGitService.getRepoFile(repoId, MAIN_BRANCH, path);
    if (existing === null) {
      throw new NotFoundException(`Routine file ${path} not found`);
    }

    await this.scratchGitService.deleteFilesFromBranch(
      repoId,
      MAIN_BRANCH,
      [path],
      `Delete routine ${path} (${actor.userId})`,
    );
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
   * (removed paths) committed to the config repo `main`, then reconciled via Reload Routines. This
   * is the server side of `scratchmd routines push`.
   *
   * Fail-fast at the boundary: every path is bounds-checked and every upsert is parsed +
   * reference-validated BEFORE anything is written, so an invalid push commits nothing. Optimistic
   * concurrency: when `baseHead` is provided it must still match the repo's current `main` head,
   * otherwise the push is refused with a 409 `blocked_stale` (the CLI prompts a `routines pull` +
   * retry) — a stale push never clobbers newer routines.
   *
   * Unlike the single-file create/update endpoints this uses upsert semantics: a file is created or
   * overwritten either way (no 409-on-exists), and deleting an absent file is a git-level no-op.
   */
  async pushRoutineFiles(
    workbookId: WorkbookId,
    dto: PushRoutineFilesDto,
    actor: Actor,
  ): Promise<PushRoutineFilesResponse> {
    // 1. Validate every path (upserts + deletes) up front; reject a path listed in both.
    for (const upsert of dto.upserts) {
      assertValidRoutineFilePath(upsert.path);
    }
    for (const deletePath of dto.deletes) {
      assertValidRoutineFilePath(deletePath);
    }
    const deletePathSet = new Set(dto.deletes);
    const pathsBothUpsertedAndDeleted = dto.upserts
      .map((upsert) => upsert.path)
      .filter((path) => deletePathSet.has(path));
    if (pathsBothUpsertedAndDeleted.length > 0) {
      throw new BadRequestException(
        `routine file path(s) cannot be both upserted and deleted: ${pathsBothUpsertedAndDeleted.join(', ')}`,
      );
    }

    const repoId = await this.resolveConfigRepoId(workbookId);

    // 2. Parse + reference-validate every upsert before any write (the server is authoritative on
    //    references — the CLI cannot resolve a workbook's folders/connections).
    for (const upsert of dto.upserts) {
      const parseResult = this.parser.parse(upsert.content);
      if ('error' in parseResult) {
        throw new BadRequestException(`${upsert.path}: ${parseResult.error}`);
      }
      await this.assertRoutineReferencesExist(workbookId, parseResult.routine);
    }

    // 3. Optimistic-concurrency guard — refuse before any side effect if `main` moved.
    if (dto.baseHead) {
      const currentRemoteHead = await this.scratchGitService.getBranchHead(repoId, MAIN_BRANCH);
      if (currentRemoteHead && dto.baseHead !== currentRemoteHead) {
        const blockedStale: PushRoutineFilesBlockedStaleDto = {
          status: 'blocked_stale',
          baseHead: dto.baseHead,
          currentRemoteHead,
          message:
            'Server routines have advanced past your local copy. Run `scratchmd routines pull`, then retry the push.',
        };
        throw new ConflictException(blockedStale);
      }
    }

    // 4. Commit upserts then deletes (upserts first so a half-applied push never removes a file a
    //    later step still needs; re-running push re-converges since it is diff-driven). Both calls
    //    are no-ops on an empty list.
    if (dto.upserts.length > 0) {
      await this.scratchGitService.commitFilesToBranch(
        repoId,
        MAIN_BRANCH,
        dto.upserts.map((upsert) => ({ path: upsert.path, content: upsert.content })),
        `Push routines: ${dto.upserts.length} upsert(s) (${actor.userId})`,
      );
    }
    if (dto.deletes.length > 0) {
      await this.scratchGitService.deleteFilesFromBranch(
        repoId,
        MAIN_BRANCH,
        dto.deletes,
        `Push routines: ${dto.deletes.length} delete(s) (${actor.userId})`,
      );
    }

    // 5. Reconcile all ROUTINE schedules from the just-committed files, then read the new head.
    const routines = await this.reloadRoutines(workbookId, actor);
    const head = (await this.scratchGitService.getBranchHead(repoId, MAIN_BRANCH)) ?? '';

    await this.auditLogService.logEvent({
      actor,
      eventType: 'update',
      message: `Pushed routines: ${dto.upserts.length} upsert(s), ${dto.deletes.length} delete(s)`,
      entityId: workbookId,
      organizationId: actor.organizationId,
    });

    return { head, routines };
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

  /** Reads every `.yaml`/`.yml` file under `routines/` and parses each. Key = file path. */
  private async readAndParseRoutineFiles(workbookId: WorkbookId): Promise<Map<string, RoutineParseResult>> {
    const repoId = await this.resolveConfigRepoId(workbookId);
    const entries = await this.scratchGitService.listRepoFiles(repoId, MAIN_BRANCH, ROUTINES_DIRECTORY);

    const yamlFileEntries = entries.filter(
      (entry) => entry.type === 'file' && (entry.path.endsWith('.yaml') || entry.path.endsWith('.yml')),
    );

    const parseResultsByFilePath = new Map<string, RoutineParseResult>();
    for (const entry of yamlFileEntries) {
      const file = await this.scratchGitService.getRepoFile(repoId, MAIN_BRANCH, entry.path);
      if (file === null) {
        // Listed but unreadable (raced deletion) — skip; orphan cleanup handles the schedule.
        continue;
      }
      parseResultsByFilePath.set(entry.path, this.parser.parse(file.content));
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

  /** Resolves the workbook config repo id (`{orgId}/{workbookId}/{workbookId}`). */
  private async resolveConfigRepoId(workbookId: WorkbookId): Promise<string> {
    const workbook = await this.db.client.workbook.findFirst({
      where: { id: workbookId },
      select: { organizationId: true },
    });
    if (!workbook) {
      throw new NotFoundException(`Workbook ${workbookId} not found`);
    }
    return getWorkbookRepoPath(workbook.organizationId, workbookId);
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
