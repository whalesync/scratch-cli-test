import { Injectable, NotFoundException } from '@nestjs/common';
import { RoutineRun as PrismaRoutineRun } from '@prisma/client';
import { Routine, RoutineRun, RoutineRunListQueryDto, WorkbookId } from '@spinner/shared-types';
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
import { RoutineParseResult } from './routine.types';

/** Directory in the workbook config repo that holds routine YAML files. */
const ROUTINES_DIRECTORY = 'routines/';

/** Cap on runs returned by the list endpoint (newest first). */
const ROUTINE_RUNS_LIST_LIMIT = 100;

@Injectable()
export class RoutineService {
  constructor(
    private readonly db: DbService,
    private readonly scratchGitService: ScratchGitService,
    private readonly scheduleService: ScheduleService,
    private readonly parser: RoutineParserService,
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

  // ── internals ────────────────────────────────────────────────────────────────

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

    return [...parseResultsByFilePath.entries()].map(([filePath, parseResult]) =>
      RoutineEntity.build({
        filePath,
        parseResult,
        schedule: scheduleByFilePath.get(filePath) ?? null,
        latestRun: latestRunByFilePath.get(filePath) ?? null,
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
}
