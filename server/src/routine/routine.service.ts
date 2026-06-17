import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { RoutineRun as PrismaRoutineRun } from '@prisma/client';
import {
  CreateRoutineFileDto,
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
import { RoutineParserService } from './routine-parser.service';
import { RoutineReferenceValidatorService, validateRoutineReferences } from './routine-reference-validator.service';
import { ParsedRoutine, RoutineParseResult } from './routine.types';

/**
 * Directory in the workbook config repo that holds routine YAML files. Repo-relative with NO
 * trailing slash: scratch-git's tree walk splits the folder on "/", so "routines/" would resolve
 * to a non-existent empty subdir and list nothing. Routine file paths are `${ROUTINES_DIRECTORY}/x.yaml`.
 */
const ROUTINES_DIRECTORY = 'routines';

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
   * Reads `routines/*.yaml` from the workbook config repo and syncs the DB's ROUTINE
   * Schedule rows: upsert for routines with a `schedule:`, delete for routines without
   * one, and orphan-delete schedules whose file no longer exists. Returns the discovered
   * routines (malformed files carry a `parseError`). This is the feature's "data
   * management" entry point — it does NOT execute anything.
   */
  async reloadRoutines(workbookId: WorkbookId, actor: Actor): Promise<Routine[]> {
    const parseResultsByFilePath = await this.readAndParseRoutineFiles(workbookId);

    for (const [filePath, parseResult] of parseResultsByFilePath) {
      if ('error' in parseResult) {
        // Leave any existing schedule untouched on a parse failure — the file still exists,
        // so deleting its schedule on a transient typo would silently stop a working routine.
        // The error is surfaced to the user via the returned Routine.parseError.
        continue;
      }
      const { routine } = parseResult;
      if (routine.schedule) {
        await this.scheduleService.upsertRoutineSchedule(
          workbookId,
          { filePath, name: routine.name, cronExpression: routine.schedule },
          actor,
        );
      } else {
        await this.scheduleService.deleteRoutineScheduleByFilePath(workbookId, filePath);
      }
    }

    // Remove schedules whose routine file is gone. Files that exist but failed to parse are
    // still "present" and so are NOT orphaned (their schedule is preserved as noted above).
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
    this.assertValidRoutineFilePath(path);
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
   * unless the YAML is a valid routine. On success, reconciles the file's ROUTINE schedule.
   */
  async createRoutineFile(workbookId: WorkbookId, dto: CreateRoutineFileDto, actor: Actor): Promise<Routine> {
    this.assertValidRoutineFilePath(dto.path);
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
    await this.reconcileScheduleForRoutineFile(workbookId, dto.path, parseResult.routine, actor);

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
   * a missing file (404), or content that doesn't parse/validate (400). On success, reconciles
   * the file's ROUTINE schedule (e.g. removing it when a `schedule:` field is deleted).
   */
  async updateRoutineFile(workbookId: WorkbookId, dto: UpdateRoutineFileDto, actor: Actor): Promise<Routine> {
    this.assertValidRoutineFilePath(dto.path);
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
    await this.reconcileScheduleForRoutineFile(workbookId, dto.path, parseResult.routine, actor);

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
    this.assertValidRoutineFilePath(path);
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

  /**
   * Guards every file write/read against escaping the `routines/` directory: the path must be a
   * single `.yaml`/`.yml` file directly under `routines/`, with no `..` traversal. This is a
   * security boundary — without it a caller could read or overwrite arbitrary config-repo files.
   */
  private assertValidRoutineFilePath(path: string): void {
    if (!path) {
      throw new BadRequestException('routine file path is required');
    }
    const directoryPrefix = `${ROUTINES_DIRECTORY}/`;
    const errorPrefix = `Invalid routine file path "${path}":`;
    if (!path.startsWith(directoryPrefix)) {
      throw new BadRequestException(`${errorPrefix} must be inside "${directoryPrefix}"`);
    }
    if (path.includes('..')) {
      throw new BadRequestException(`${errorPrefix} must not contain ".."`);
    }
    const fileName = path.slice(directoryPrefix.length);
    if (fileName.length === 0 || fileName.includes('/')) {
      throw new BadRequestException(`${errorPrefix} must be a single file directly under "${directoryPrefix}"`);
    }
    if (!fileName.endsWith('.yaml') && !fileName.endsWith('.yml')) {
      throw new BadRequestException(`${errorPrefix} must end with .yaml or .yml`);
    }
  }

  /**
   * Keeps the file's ROUTINE schedule row in sync with its `schedule:` field: upsert when present,
   * delete when absent. Same logic `reloadRoutines` applies, scoped to one file after a write.
   */
  private async reconcileScheduleForRoutineFile(
    workbookId: WorkbookId,
    filePath: string,
    parsedRoutine: ParsedRoutine,
    actor: Actor,
  ): Promise<void> {
    if (parsedRoutine.schedule) {
      await this.scheduleService.upsertRoutineSchedule(
        workbookId,
        { filePath, name: parsedRoutine.name, cronExpression: parsedRoutine.schedule },
        actor,
      );
    } else {
      await this.scheduleService.deleteRoutineScheduleByFilePath(workbookId, filePath);
    }
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
