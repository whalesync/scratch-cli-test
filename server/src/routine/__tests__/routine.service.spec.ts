import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { WorkbookId } from '@spinner/shared-types';
import { AuditLogService } from 'src/audit/audit-log.service';
import { DbService } from 'src/db/db.service';
import { JobService } from 'src/job/job.service';
import { ScheduleService } from 'src/schedule/schedule.service';
import { Actor } from 'src/users/types';
import { RoutineDefinitionStoreService } from '../routine-definition-store.service';
import { RoutineGitMirrorService } from '../routine-git-mirror.service';
import { RoutineParserService } from '../routine-parser.service';
import { RoutineReferenceValidatorService } from '../routine-reference-validator.service';
import { RoutineService } from '../routine.service';
import { RoutineValidationContext } from '../routine.types';

const WORKBOOK_ID = 'wkb_test1234' as WorkbookId;
const ACTOR: Actor = { userId: 'usr_test1234', organizationId: 'org_test1234' };

/** A stored RoutineDefinition row as the store returns it. */
function definitionRow(filePath: string, content: string, version = 1) {
  return {
    id: `rdf_${filePath.replace(/[^a-z0-9]/gi, '').slice(0, 10)}`,
    createdAt: new Date('2026-06-19T00:00:00.000Z'),
    updatedAt: new Date('2026-06-19T00:00:00.000Z'),
    workbookId: WORKBOOK_ID,
    filePath,
    content,
    version,
    source: 'web',
    updatedByUserId: 'usr_test1234',
  };
}

/** An empty validation context — no folders, connections, or syncs resolve, so any reference is "not found". */
function emptyValidationContext(): RoutineValidationContext {
  return {
    foldersByPath: new Map(),
    foldersById: new Map(),
    connectionsByName: new Map(),
    connectionsById: new Map(),
    syncsById: new Map(),
  };
}

const FIXTURE_DATE = new Date('2026-06-19T00:00:00.000Z');

/** A Prisma RoutineRun row (Date timestamps, as Prisma returns) for the run read tests. */
function prismaRunRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'rr_1',
    createdAt: FIXTURE_DATE,
    updatedAt: FIXTURE_DATE,
    workbookId: WORKBOOK_ID,
    routineFilePath: 'routines/daily.yaml',
    routineName: 'Daily',
    status: 'completed',
    trigger: 'manual',
    triggeredByUserId: 'usr_test1234',
    startedAt: FIXTURE_DATE,
    finishedAt: FIXTURE_DATE,
    error: null,
    currentStepIndex: 1,
    ...overrides,
  };
}

/** A Prisma RoutineRunStep row. `jobId` holds the BullMQ job id (or null for a step with no job). */
function prismaStepRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'rrs_1',
    createdAt: FIXTURE_DATE,
    updatedAt: FIXTURE_DATE,
    runId: 'rr_1',
    stepIndex: 0,
    action: 'pull',
    name: null,
    folder: null,
    folders: [],
    connection: null,
    sync: null,
    timeoutSeconds: null,
    options: null,
    status: 'completed',
    startedAt: FIXTURE_DATE,
    finishedAt: FIXTURE_DATE,
    error: null,
    jobId: 'bull_1',
    pipelineId: null,
    ...overrides,
  };
}

/** A JobEntity as `JobService.getJobsProgress` returns it (Date timestamps). */
function jobEntityFixture(overrides: Record<string, unknown> = {}) {
  return {
    dbJobId: 'job_1',
    bullJobId: 'bull_1',
    runId: 'run_1',
    workbookId: WORKBOOK_ID,
    dataFolderId: null,
    type: 'pull-linked-folder-files',
    state: 'completed',
    progressTimestamp: 123,
    publicProgress: { totalFiles: 5 },
    processedOn: new Date('2026-06-19T00:00:01.000Z'),
    finishedOn: new Date('2026-06-19T00:00:02.000Z'),
    failedReason: null,
    runContext: null,
    ...overrides,
  };
}

describe('RoutineService', () => {
  let routineRunFindMany: jest.Mock;
  let routineRunFindFirst: jest.Mock;
  let routineRunStepFindMany: jest.Mock;
  let listDefinitions: jest.Mock;
  let getDefinition: jest.Mock;
  let upsertDefinition: jest.Mock;
  let deleteDefinition: jest.Mock;
  let applyPush: jest.Mock;
  let mirrorWorkbookRoutinesInBackground: jest.Mock;
  let mirrorWorkbookRoutines: jest.Mock;
  let deleteRoutineScheduleByFilePath: jest.Mock;
  let deleteOrphanedRoutineSchedules: jest.Mock;
  let findRoutineSchedules: jest.Mock;
  let logEvent: jest.Mock;
  let validateRoutine: jest.Mock;
  let loadContext: jest.Mock;
  let getJobsProgress: jest.Mock;
  let service: RoutineService;

  beforeEach(() => {
    routineRunFindMany = jest.fn().mockResolvedValue([]);
    routineRunFindFirst = jest.fn();
    routineRunStepFindMany = jest.fn().mockResolvedValue([]);
    listDefinitions = jest.fn().mockResolvedValue([]);
    getDefinition = jest.fn().mockResolvedValue(null);
    // Echo back a row for whatever was written, so the service can build the joined routine.
    upsertDefinition = jest
      .fn()
      .mockImplementation((_workbookId: string, filePath: string, content: string) =>
        Promise.resolve({ definition: definitionRow(filePath, content), outcome: 'created' }),
      );
    deleteDefinition = jest.fn().mockResolvedValue(true);
    applyPush = jest
      .fn()
      .mockResolvedValue({ status: 'applied', files: [], upsertedFilePaths: [], deletedFilePaths: [] });
    mirrorWorkbookRoutinesInBackground = jest.fn();
    mirrorWorkbookRoutines = jest.fn().mockResolvedValue('headsha123');
    deleteRoutineScheduleByFilePath = jest.fn().mockResolvedValue(undefined);
    deleteOrphanedRoutineSchedules = jest.fn().mockResolvedValue(undefined);
    findRoutineSchedules = jest.fn().mockResolvedValue([]);
    logEvent = jest.fn().mockResolvedValue(undefined);
    validateRoutine = jest.fn().mockResolvedValue([]);
    loadContext = jest.fn().mockResolvedValue(emptyValidationContext());
    getJobsProgress = jest.fn().mockResolvedValue([]);

    const db = {
      client: {
        routineRun: { findMany: routineRunFindMany, findFirst: routineRunFindFirst },
        routineRunStep: { findMany: routineRunStepFindMany },
      },
    } as unknown as DbService;

    const routineDefinitionStore = {
      listDefinitions,
      getDefinition,
      upsertDefinition,
      deleteDefinition,
      applyPush,
    } as unknown as RoutineDefinitionStoreService;
    const routineGitMirror = {
      mirrorWorkbookRoutinesInBackground,
      mirrorWorkbookRoutines,
    } as unknown as RoutineGitMirrorService;
    const scheduleService = {
      deleteRoutineScheduleByFilePath,
      deleteOrphanedRoutineSchedules,
      findRoutineSchedules,
    } as unknown as ScheduleService;
    const auditLogService = { logEvent } as unknown as AuditLogService;
    const referenceValidator = {
      validateRoutine,
      loadContext,
    } as unknown as RoutineReferenceValidatorService;
    const jobService = { getJobsProgress } as unknown as JobService;

    service = new RoutineService(
      db,
      routineDefinitionStore,
      routineGitMirror,
      scheduleService,
      new RoutineParserService(),
      referenceValidator,
      auditLogService,
      jobService,
    );
  });

  describe('reloadRoutines', () => {
    it('returns a routine joined with its ROUTINE schedule row (cron sourced from the DB, not the YAML)', async () => {
      listDefinitions.mockResolvedValue([
        definitionRow('routines/scheduled.yaml', 'name: Scheduled\nsteps:\n  - action: pull\n'),
      ]);
      findRoutineSchedules.mockResolvedValue([
        { entityId: 'routines/scheduled.yaml', id: 'sch_routine01', enabled: true, cronExpression: '0 9 * * *' },
      ]);

      const routines = await service.reloadRoutines(WORKBOOK_ID, ACTOR);

      // Reload writes no schedules — the cron lives in the Schedule table, edited via the schedule API.
      expect(deleteRoutineScheduleByFilePath).not.toHaveBeenCalled();
      expect(deleteOrphanedRoutineSchedules).toHaveBeenCalledWith(WORKBOOK_ID, ['routines/scheduled.yaml']);
      expect(logEvent).toHaveBeenCalledTimes(1);

      expect(routines).toHaveLength(1);
      expect(routines[0]).toMatchObject({
        filePath: 'routines/scheduled.yaml',
        name: 'Scheduled',
        schedule: '0 9 * * *',
        scheduleId: 'sch_routine01',
        scheduleEnabled: true,
        parseError: null,
      });
    });

    it('writes no per-file schedules on reload (only orphan-cleans)', async () => {
      listDefinitions.mockResolvedValue([
        definitionRow('routines/manual.yaml', 'name: Manual\nsteps:\n  - action: pull\n'),
      ]);

      const routines = await service.reloadRoutines(WORKBOOK_ID, ACTOR);

      expect(deleteRoutineScheduleByFilePath).not.toHaveBeenCalled();
      expect(deleteOrphanedRoutineSchedules).toHaveBeenCalledWith(WORKBOOK_ID, ['routines/manual.yaml']);
      expect(routines[0]).toMatchObject({ filePath: 'routines/manual.yaml', schedule: null, scheduleId: null });
    });

    it('orphan-cleans schedules for files no longer present, passing all present paths', async () => {
      listDefinitions.mockResolvedValue([
        definitionRow('routines/a.yaml', 'name: A\nsteps:\n  - action: pull\n'),
        definitionRow('routines/b.yml', 'name: B\nsteps:\n  - action: pull\n'),
      ]);

      await service.reloadRoutines(WORKBOOK_ID, ACTOR);

      expect(deleteOrphanedRoutineSchedules).toHaveBeenCalledWith(WORKBOOK_ID, ['routines/a.yaml', 'routines/b.yml']);
    });

    it('does not orphan-clean anything when the store fails (a partial list must never delete schedules)', async () => {
      listDefinitions.mockRejectedValue(new Error('scratch-git unreachable during git import'));

      await expect(service.reloadRoutines(WORKBOOK_ID, ACTOR)).rejects.toThrow('scratch-git unreachable');

      expect(deleteOrphanedRoutineSchedules).not.toHaveBeenCalled();
    });

    it('surfaces a parse error and keeps reloading the rest', async () => {
      listDefinitions.mockResolvedValue([
        definitionRow('routines/broken.yaml', 'name: Broken\nsteps: []\n'), // empty steps → invalid
        definitionRow('routines/ok.yaml', 'name: Ok\nsteps:\n  - action: pull\n'),
      ]);

      const routines = await service.reloadRoutines(WORKBOOK_ID, ACTOR);

      // Reload no longer writes per-file schedules — broken or not, only orphan cleanup runs.
      expect(deleteRoutineScheduleByFilePath).not.toHaveBeenCalled();
      expect(deleteOrphanedRoutineSchedules).toHaveBeenCalledWith(WORKBOOK_ID, [
        'routines/broken.yaml',
        'routines/ok.yaml',
      ]);

      const broken = routines.find((r) => r.filePath === 'routines/broken.yaml');
      expect(broken?.parseError).toMatch(/steps/);
      expect(broken?.name).toBeNull();
    });

    it('treats a workbook with no routine definitions as zero routines', async () => {
      listDefinitions.mockResolvedValue([]);

      const routines = await service.reloadRoutines(WORKBOOK_ID, ACTOR);

      expect(routines).toEqual([]);
      // Orphan cleanup still runs (with an empty list) to clear any stale ROUTINE schedules.
      expect(deleteOrphanedRoutineSchedules).toHaveBeenCalledWith(WORKBOOK_ID, []);
    });

    it('surfaces referenceWarnings for a parsed routine with a broken reference, and writes no schedules', async () => {
      // Parses fine, but `/gone` resolves to nothing in the (empty) validation context.
      listDefinitions.mockResolvedValue([
        definitionRow('routines/a.yaml', 'name: A\nsteps:\n  - action: pull\n    folders:\n      - /gone\n'),
      ]);

      const routines = await service.reloadRoutines(WORKBOOK_ID, ACTOR);

      expect(routines[0].parseError).toBeNull();
      expect(routines[0].referenceWarnings).toContain('steps.0.folders.0: folder "/gone" not found in this workbook');
      // Reload never writes schedules — the cron is owned by the Schedule table now.
      expect(deleteRoutineScheduleByFilePath).not.toHaveBeenCalled();
    });
  });

  describe('listRoutines', () => {
    it('joins schedule + latest run without writing any schedules', async () => {
      listDefinitions.mockResolvedValue([definitionRow('routines/a.yaml', 'name: A\nsteps:\n  - action: pull\n')]);
      findRoutineSchedules.mockResolvedValue([
        { entityId: 'routines/a.yaml', id: 'sch_a0000001', enabled: false, cronExpression: '0 9 * * *' },
      ]);
      routineRunFindMany.mockResolvedValue([
        {
          id: 'rrn_run00001',
          routineFilePath: 'routines/a.yaml',
          status: 'completed',
          trigger: 'manual',
          startedAt: new Date('2026-01-01T00:00:00Z'),
          finishedAt: new Date('2026-01-01T00:05:00Z'),
          createdAt: new Date('2026-01-01T00:00:00Z'),
        },
      ]);

      const routines = await service.listRoutines(WORKBOOK_ID);

      expect(deleteRoutineScheduleByFilePath).not.toHaveBeenCalled();
      expect(deleteOrphanedRoutineSchedules).not.toHaveBeenCalled();
      expect(routines[0]).toMatchObject({
        filePath: 'routines/a.yaml',
        schedule: '0 9 * * *',
        scheduleId: 'sch_a0000001',
        scheduleEnabled: false,
        latestRun: { id: 'rrn_run00001', status: 'completed', trigger: 'manual' },
      });
    });

    it('reads definitions from the store (which owns the one-time git import), never git directly', async () => {
      await service.listRoutines(WORKBOOK_ID);
      expect(listDefinitions).toHaveBeenCalledWith(WORKBOOK_ID);
    });
  });

  describe('listRoutineFiles', () => {
    it('returns every file with its version and content', async () => {
      listDefinitions.mockResolvedValue([
        definitionRow('routines/a.yaml', 'name: A\nsteps:\n  - action: pull\n', 3),
        definitionRow('routines/b.yaml', 'name: B\nsteps:\n  - action: pull\n', 1),
      ]);

      const result = await service.listRoutineFiles(WORKBOOK_ID, {});

      expect(result).toEqual({
        files: [
          {
            path: 'routines/a.yaml',
            version: 3,
            updatedAt: '2026-06-19T00:00:00.000Z',
            content: 'name: A\nsteps:\n  - action: pull\n',
          },
          {
            path: 'routines/b.yaml',
            version: 1,
            updatedAt: '2026-06-19T00:00:00.000Z',
            content: 'name: B\nsteps:\n  - action: pull\n',
          },
        ],
      });
    });

    it('omits content when metadataOnly is set', async () => {
      listDefinitions.mockResolvedValue([definitionRow('routines/a.yaml', 'name: A\nsteps:\n  - action: pull\n', 2)]);

      const result = await service.listRoutineFiles(WORKBOOK_ID, { metadataOnly: true });

      expect(result.files).toEqual([{ path: 'routines/a.yaml', version: 2, updatedAt: '2026-06-19T00:00:00.000Z' }]);
      expect(result.files[0]).not.toHaveProperty('content');
    });
  });

  describe('getRoutineFileContent', () => {
    it('returns the raw file content', async () => {
      getDefinition.mockResolvedValue(definitionRow('routines/a.yaml', 'name: A\nsteps:\n  - action: pull\n'));

      const result = await service.getRoutineFileContent(WORKBOOK_ID, 'routines/a.yaml');

      expect(result).toEqual({ path: 'routines/a.yaml', content: 'name: A\nsteps:\n  - action: pull\n' });
    });

    it('throws NotFound when the file does not exist', async () => {
      getDefinition.mockResolvedValue(null);

      await expect(service.getRoutineFileContent(WORKBOOK_ID, 'routines/missing.yaml')).rejects.toThrow(
        NotFoundException,
      );
    });

    it.each([
      ['outside routines/', 'syncs/a.yaml'],
      ['a nested path', 'routines/sub/a.yaml'],
      ['a non-yaml extension', 'routines/a.txt'],
      ['parent traversal', 'routines/../secret.yaml'],
      ['an empty path', ''],
    ])('rejects %s with BadRequest', async (_label, path) => {
      await expect(service.getRoutineFileContent(WORKBOOK_ID, path)).rejects.toThrow(BadRequestException);
      expect(getDefinition).not.toHaveBeenCalled();
    });
  });

  describe('createRoutineFile', () => {
    const VALID_YAML = 'name: Sched\nsteps:\n  - action: pull\n';

    it('stores the definition, mirrors to git in the background, audit-logs, and returns the joined routine', async () => {
      getDefinition.mockResolvedValue(null); // does not already exist

      const routine = await service.createRoutineFile(
        WORKBOOK_ID,
        { path: 'routines/new.yaml', content: VALID_YAML },
        ACTOR,
      );

      expect(upsertDefinition).toHaveBeenCalledWith(WORKBOOK_ID, 'routines/new.yaml', VALID_YAML, {
        source: 'web',
        updatedByUserId: ACTOR.userId,
      });
      expect(mirrorWorkbookRoutinesInBackground).toHaveBeenCalledWith(WORKBOOK_ID, ACTOR);
      // The schedule is managed via the Schedule API now — create touches no schedule rows.
      expect(deleteRoutineScheduleByFilePath).not.toHaveBeenCalled();
      expect(logEvent).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'create' }));
      expect(routine).toMatchObject({ filePath: 'routines/new.yaml', name: 'Sched', parseError: null });
    });

    it('records the caller-supplied source (the Live Export generator passes "generated")', async () => {
      getDefinition.mockResolvedValue(null);

      await service.createRoutineFile(WORKBOOK_ID, { path: 'routines/run.yaml', content: VALID_YAML }, ACTOR, {
        source: 'generated',
      });

      expect(upsertDefinition).toHaveBeenCalledWith(
        WORKBOOK_ID,
        'routines/run.yaml',
        VALID_YAML,
        expect.objectContaining({ source: 'generated' }),
      );
    });

    it('throws Conflict and writes nothing when the file already exists', async () => {
      getDefinition.mockResolvedValue(definitionRow('routines/dup.yaml', 'name: Existing\nsteps:\n  - action: pull\n'));

      await expect(
        service.createRoutineFile(WORKBOOK_ID, { path: 'routines/dup.yaml', content: VALID_YAML }, ACTOR),
      ).rejects.toThrow(ConflictException);
      expect(upsertDefinition).not.toHaveBeenCalled();
      expect(mirrorWorkbookRoutinesInBackground).not.toHaveBeenCalled();
    });

    it('throws BadRequest and writes nothing when the YAML is invalid', async () => {
      getDefinition.mockResolvedValue(null);

      await expect(
        service.createRoutineFile(
          WORKBOOK_ID,
          { path: 'routines/bad.yaml', content: 'name: Bad\nsteps: []\n' }, // empty steps → invalid
          ACTOR,
        ),
      ).rejects.toThrow(BadRequestException);
      expect(upsertDefinition).not.toHaveBeenCalled();
      // Reference validation must not run until the structural parse passes.
      expect(validateRoutine).not.toHaveBeenCalled();
    });

    it('throws BadRequest and writes nothing when a referenced folder does not exist', async () => {
      getDefinition.mockResolvedValue(null);
      validateRoutine.mockResolvedValue(['steps.0.folders.0: folder "/path/to/folder" not found in this workbook']);

      await expect(
        service.createRoutineFile(
          WORKBOOK_ID,
          {
            path: 'routines/new.yaml',
            content: 'name: R\nsteps:\n  - action: pull\n    folders:\n      - /path/to/folder\n',
          },
          ACTOR,
        ),
      ).rejects.toThrow(BadRequestException);
      expect(validateRoutine).toHaveBeenCalledTimes(1);
      expect(upsertDefinition).not.toHaveBeenCalled();
    });

    it('rejects a path outside routines/ before any store access', async () => {
      await expect(
        service.createRoutineFile(WORKBOOK_ID, { path: 'syncs/evil.yaml', content: VALID_YAML }, ACTOR),
      ).rejects.toThrow(BadRequestException);
      expect(getDefinition).not.toHaveBeenCalled();
      expect(upsertDefinition).not.toHaveBeenCalled();
    });
  });

  describe('updateRoutineFile', () => {
    it('stores the new content, mirrors in the background, and does not touch the schedule', async () => {
      getDefinition.mockResolvedValue(definitionRow('routines/a.yaml', 'name: Old\nsteps:\n  - action: pull\n'));

      await service.updateRoutineFile(
        WORKBOOK_ID,
        { path: 'routines/a.yaml', content: 'name: Manual\nsteps:\n  - action: pull\n' },
        ACTOR,
      );

      expect(upsertDefinition).toHaveBeenCalledWith(
        WORKBOOK_ID,
        'routines/a.yaml',
        'name: Manual\nsteps:\n  - action: pull\n',
        { source: 'web', updatedByUserId: ACTOR.userId },
      );
      expect(mirrorWorkbookRoutinesInBackground).toHaveBeenCalledWith(WORKBOOK_ID, ACTOR);
      // Editing the routine file never touches the schedule — it is owned by the Schedule table.
      expect(deleteRoutineScheduleByFilePath).not.toHaveBeenCalled();
      expect(logEvent).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'update' }));
    });

    it('throws NotFound and writes nothing when the file is missing', async () => {
      getDefinition.mockResolvedValue(null);

      await expect(
        service.updateRoutineFile(
          WORKBOOK_ID,
          { path: 'routines/missing.yaml', content: 'name: X\nsteps:\n  - action: pull\n' },
          ACTOR,
        ),
      ).rejects.toThrow(NotFoundException);
      expect(upsertDefinition).not.toHaveBeenCalled();
    });

    it('throws BadRequest and writes nothing when a referenced connection does not exist', async () => {
      getDefinition.mockResolvedValue(definitionRow('routines/a.yaml', 'name: Old\nsteps:\n  - action: pull\n'));
      validateRoutine.mockResolvedValue(['steps.0.connection: connection "ghost" not found in this workbook']);

      await expect(
        service.updateRoutineFile(
          WORKBOOK_ID,
          { path: 'routines/a.yaml', content: 'name: A\nsteps:\n  - action: pull\n    connection: ghost\n' },
          ACTOR,
        ),
      ).rejects.toThrow(BadRequestException);
      expect(validateRoutine).toHaveBeenCalledTimes(1);
      expect(upsertDefinition).not.toHaveBeenCalled();
    });
  });

  describe('upsertRoutineFile', () => {
    const NEW_YAML = 'name: New\nsteps:\n  - action: pull\n';

    it('creates the file when it does not exist', async () => {
      getDefinition.mockResolvedValue(null);

      const { routine, outcome } = await service.upsertRoutineFile(
        WORKBOOK_ID,
        { path: 'routines/run.yaml', content: NEW_YAML },
        ACTOR,
        { source: 'generated' },
      );

      expect(outcome).toBe('created');
      expect(upsertDefinition).toHaveBeenCalledWith(WORKBOOK_ID, 'routines/run.yaml', NEW_YAML, {
        source: 'generated',
        updatedByUserId: ACTOR.userId,
      });
      expect(logEvent).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'create' }));
      expect(routine).toMatchObject({ filePath: 'routines/run.yaml', name: 'New', parseError: null });
    });

    it('replaces the file when the stored content differs', async () => {
      getDefinition.mockResolvedValue(definitionRow('routines/run.yaml', 'name: Old\nsteps:\n  - action: pull\n'));

      const { routine, outcome } = await service.upsertRoutineFile(
        WORKBOOK_ID,
        { path: 'routines/run.yaml', content: NEW_YAML },
        ACTOR,
      );

      expect(outcome).toBe('updated');
      expect(upsertDefinition).toHaveBeenCalledWith(WORKBOOK_ID, 'routines/run.yaml', NEW_YAML, {
        source: 'web',
        updatedByUserId: ACTOR.userId,
      });
      expect(mirrorWorkbookRoutinesInBackground).toHaveBeenCalledTimes(1);
      expect(logEvent).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'update' }));
      expect(routine).toMatchObject({ filePath: 'routines/run.yaml', name: 'New', parseError: null });
    });

    it('writes nothing, mirrors nothing, and logs no audit event when the stored content is identical', async () => {
      getDefinition.mockResolvedValue(definitionRow('routines/run.yaml', NEW_YAML));

      const { routine, outcome } = await service.upsertRoutineFile(
        WORKBOOK_ID,
        { path: 'routines/run.yaml', content: NEW_YAML },
        ACTOR,
      );

      expect(outcome).toBe('unchanged');
      expect(upsertDefinition).not.toHaveBeenCalled();
      expect(mirrorWorkbookRoutinesInBackground).not.toHaveBeenCalled();
      expect(logEvent).not.toHaveBeenCalled();
      expect(routine).toMatchObject({ filePath: 'routines/run.yaml', name: 'New', parseError: null });
    });

    it('throws BadRequest and writes nothing when the new YAML is invalid', async () => {
      getDefinition.mockResolvedValue(definitionRow('routines/run.yaml', 'name: Old\nsteps:\n  - action: pull\n'));

      await expect(
        service.upsertRoutineFile(WORKBOOK_ID, { path: 'routines/run.yaml', content: 'steps: 42' }, ACTOR),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(upsertDefinition).not.toHaveBeenCalled();
    });
  });

  describe('deleteRoutineFile', () => {
    it('deletes the definition and its schedule, mirrors in the background, and audit-logs', async () => {
      deleteDefinition.mockResolvedValue(true);

      await service.deleteRoutineFile(WORKBOOK_ID, 'routines/a.yaml', ACTOR);

      expect(deleteDefinition).toHaveBeenCalledWith(WORKBOOK_ID, 'routines/a.yaml');
      expect(mirrorWorkbookRoutinesInBackground).toHaveBeenCalledWith(WORKBOOK_ID, ACTOR);
      expect(deleteRoutineScheduleByFilePath).toHaveBeenCalledWith(WORKBOOK_ID, 'routines/a.yaml');
      expect(logEvent).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'delete' }));
    });

    it('throws NotFound and touches no schedule when the file is missing', async () => {
      deleteDefinition.mockResolvedValue(false);

      await expect(service.deleteRoutineFile(WORKBOOK_ID, 'routines/missing.yaml', ACTOR)).rejects.toThrow(
        NotFoundException,
      );
      expect(deleteRoutineScheduleByFilePath).not.toHaveBeenCalled();
      expect(mirrorWorkbookRoutinesInBackground).not.toHaveBeenCalled();
    });
  });

  describe('pushRoutineFiles', () => {
    const VALID = 'name: Daily\nsteps:\n  - action: pull\n';

    it('applies upserts and deletes via the store, reloads, mirrors synchronously, and returns versions + head', async () => {
      applyPush.mockResolvedValue({
        status: 'applied',
        files: [{ path: 'routines/new.yaml', version: 1 }],
        upsertedFilePaths: ['routines/new.yaml'],
        deletedFilePaths: ['routines/old.yaml'],
      });
      // reloadRoutines reads the written definitions back to reconcile + return them.
      listDefinitions.mockResolvedValue([definitionRow('routines/new.yaml', VALID)]);

      const result = await service.pushRoutineFiles(
        WORKBOOK_ID,
        {
          upserts: [{ path: 'routines/new.yaml', content: VALID, baseVersion: null }],
          deletes: [{ path: 'routines/old.yaml', baseVersion: 2 }],
        },
        ACTOR,
      );

      expect(applyPush).toHaveBeenCalledWith(WORKBOOK_ID, {
        upserts: [{ filePath: 'routines/new.yaml', content: VALID, baseVersion: null }],
        deletes: [{ filePath: 'routines/old.yaml', baseVersion: 2 }],
        source: 'cli',
        updatedByUserId: ACTOR.userId,
      });
      expect(deleteOrphanedRoutineSchedules).toHaveBeenCalledWith(WORKBOOK_ID, ['routines/new.yaml']);
      expect(mirrorWorkbookRoutines).toHaveBeenCalledWith(WORKBOOK_ID, ACTOR);
      expect(result.files).toEqual([{ path: 'routines/new.yaml', version: 1 }]);
      expect(result.head).toBe('headsha123');
      expect(result.routines).toHaveLength(1);
      expect(logEvent).toHaveBeenCalledWith(
        expect.objectContaining({ eventType: 'update', message: 'Pushed routines: 1 upsert(s), 1 delete(s)' }),
      );
    });

    it('accepts bare-string deletes from a pre-DEV-11399 CLI (no per-file guard)', async () => {
      await service.pushRoutineFiles(WORKBOOK_ID, { upserts: [], deletes: ['routines/old.yaml'] }, ACTOR);

      expect(applyPush).toHaveBeenCalledWith(
        WORKBOOK_ID,
        expect.objectContaining({ deletes: [{ filePath: 'routines/old.yaml', baseVersion: undefined }] }),
      );
    });

    it('refuses with 409 blocked_stale naming the stale files, with no reload/mirror/audit', async () => {
      applyPush.mockResolvedValue({
        status: 'blocked_stale',
        staleFiles: [{ path: 'routines/a.yaml', baseVersion: 1, currentVersion: 3 }],
      });

      const pushPromise = service.pushRoutineFiles(
        WORKBOOK_ID,
        { upserts: [{ path: 'routines/a.yaml', content: VALID, baseVersion: 1 }], deletes: [] },
        ACTOR,
      );
      const thrown: unknown = await pushPromise.catch((error: unknown) => error);
      expect(thrown).toBeInstanceOf(ConflictException);
      const blockedStale = (thrown as ConflictException).getResponse() as {
        status: string;
        staleFiles: unknown[];
        message: string;
      };
      expect(blockedStale).toMatchObject({
        status: 'blocked_stale',
        staleFiles: [{ path: 'routines/a.yaml', baseVersion: 1, currentVersion: 3 }],
      });
      expect(blockedStale.message).toContain('routines/a.yaml');

      expect(deleteOrphanedRoutineSchedules).not.toHaveBeenCalled();
      expect(mirrorWorkbookRoutines).not.toHaveBeenCalled();
      expect(logEvent).not.toHaveBeenCalled();
    });

    it('ignores the deprecated baseHead git SHA (pre-DEV-11399 CLI) and still applies the push', async () => {
      await service.pushRoutineFiles(
        WORKBOOK_ID,
        { upserts: [{ path: 'routines/a.yaml', content: VALID }], deletes: [], baseHead: 'staleLocalHead' },
        ACTOR,
      );

      expect(applyPush).toHaveBeenCalledTimes(1);
      expect(applyPush).toHaveBeenCalledWith(
        WORKBOOK_ID,
        expect.objectContaining({
          upserts: [{ filePath: 'routines/a.yaml', content: VALID, baseVersion: undefined }],
        }),
      );
    });

    it('returns head "" when the mirror is disabled', async () => {
      mirrorWorkbookRoutines.mockResolvedValue(null);

      const result = await service.pushRoutineFiles(
        WORKBOOK_ID,
        { upserts: [{ path: 'routines/a.yaml', content: VALID }], deletes: [] },
        ACTOR,
      );

      expect(result.head).toBe('');
    });

    it('returns head "" (and still succeeds) when the git mirror fails after the definitions were saved', async () => {
      mirrorWorkbookRoutines.mockRejectedValue(new Error('git down'));

      const result = await service.pushRoutineFiles(
        WORKBOOK_ID,
        { upserts: [{ path: 'routines/a.yaml', content: VALID }], deletes: [] },
        ACTOR,
      );

      // The pre-DEV-11399 CLI deserializes `head` as a non-nullable string and treats "" as "skip".
      expect(result.head).toBe('');
      expect(logEvent).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'update' }));
    });

    it('rejects a path outside routines/ before any store call', async () => {
      await expect(
        service.pushRoutineFiles(
          WORKBOOK_ID,
          { upserts: [{ path: 'secrets/leak.yaml', content: VALID }], deletes: [] },
          ACTOR,
        ),
      ).rejects.toThrow(BadRequestException);

      expect(applyPush).not.toHaveBeenCalled();
    });

    it('rejects a path listed in both upserts and deletes', async () => {
      await expect(
        service.pushRoutineFiles(
          WORKBOOK_ID,
          { upserts: [{ path: 'routines/a.yaml', content: VALID }], deletes: ['routines/a.yaml'] },
          ACTOR,
        ),
      ).rejects.toThrow(BadRequestException);

      expect(applyPush).not.toHaveBeenCalled();
    });

    it('rejects malformed YAML before any write', async () => {
      await expect(
        service.pushRoutineFiles(
          WORKBOOK_ID,
          { upserts: [{ path: 'routines/a.yaml', content: 'steps: [] # missing name' }], deletes: [] },
          ACTOR,
        ),
      ).rejects.toThrow(BadRequestException);

      expect(applyPush).not.toHaveBeenCalled();
    });

    it('rejects an unresolved reference before any write', async () => {
      validateRoutine.mockResolvedValue(['steps.0.connection: connection "ghost" not found in this workbook']);

      await expect(
        service.pushRoutineFiles(
          WORKBOOK_ID,
          {
            upserts: [
              { path: 'routines/a.yaml', content: 'name: A\nsteps:\n  - action: pull\n    connection: ghost\n' },
            ],
            deletes: [],
          },
          ACTOR,
        ),
      ).rejects.toThrow(BadRequestException);

      expect(applyPush).not.toHaveBeenCalled();
    });
  });

  describe('listRuns', () => {
    it('returns runs without steps and does not load jobs when includeJobs is not set', async () => {
      routineRunFindMany.mockResolvedValue([prismaRunRow()]);

      const runs = await service.listRuns(WORKBOOK_ID, {});

      expect(runs).toHaveLength(1);
      expect(runs[0].steps).toBeUndefined();
      expect(getJobsProgress).not.toHaveBeenCalled();
    });

    it('includes steps with each step job, batched in a single fetch, when includeJobs is true', async () => {
      routineRunFindMany.mockResolvedValue([
        prismaRunRow({
          steps: [prismaStepRow({ jobId: 'bull_1' }), prismaStepRow({ id: 'rrs_2', stepIndex: 1, jobId: null })],
        }),
      ]);
      getJobsProgress.mockResolvedValue([jobEntityFixture({ bullJobId: 'bull_1' })]);

      const runs = await service.listRuns(WORKBOOK_ID, { includeJobs: true });

      // One batched fetch for every step's job across the run list.
      expect(getJobsProgress).toHaveBeenCalledTimes(1);
      expect(getJobsProgress).toHaveBeenCalledWith(['bull_1']);
      const steps = runs[0].steps ?? [];
      expect(steps[0].job).toMatchObject({
        bullJobId: 'bull_1',
        state: 'completed',
        publicProgress: { totalFiles: 5 },
      });
      // Date timestamps are serialized to ISO strings on the wire type.
      expect(steps[0].job?.processedOn).toBe('2026-06-19T00:00:01.000Z');
      // A step with no jobId resolves to null.
      expect(steps[1].job).toBeNull();
    });

    // DEV-11256: mid-run, `resultSummary` names the step that already FINISHED. Every list row also
    // carries what the run is doing right now, so a polling list needs no per-run detail fetch for it.
    it('describes an active run by its in-flight step, loading only that step job', async () => {
      routineRunFindMany.mockResolvedValue([
        prismaRunRow({ id: 'rr_active', status: 'running', currentStepIndex: 1, finishedAt: null }),
        prismaRunRow({ id: 'rr_done', status: 'completed' }),
      ]);
      routineRunStepFindMany.mockResolvedValue([
        prismaStepRow({ id: 'rrs_1', runId: 'rr_active', stepIndex: 0, status: 'completed', jobId: 'bull_done' }),
        prismaStepRow({ id: 'rrs_2', runId: 'rr_active', stepIndex: 1, status: 'running', jobId: 'bull_active' }),
      ]);
      getJobsProgress.mockResolvedValue([
        jobEntityFixture({
          bullJobId: 'bull_active',
          state: 'active',
          publicProgress: { folderCount: 2, totalFiles: 1200, folders: [] },
        }),
      ]);

      const runs = await service.listRuns(WORKBOOK_ID, {});

      // Steps are loaded for the ACTIVE run only, and only its in-flight step's job is fetched.
      expect(routineRunStepFindMany).toHaveBeenCalledWith({
        where: { runId: { in: ['rr_active'] } },
        orderBy: { stepIndex: 'asc' },
      });
      expect(getJobsProgress).toHaveBeenCalledWith(['bull_active']);
      expect(runs[0].currentStepSummary).toBe('Pulling 2 folders — 1,200 records fetched');
      // The list contract is unchanged otherwise: no steps on the rows, and nothing derived for a
      // finished run (its `resultSummary` is its result).
      expect(runs[0].steps).toBeUndefined();
      expect(runs[1].currentStepSummary).toBeNull();
    });

    it('falls back to the in-flight step label before its job reports progress', async () => {
      routineRunFindMany.mockResolvedValue([
        prismaRunRow({ id: 'rr_active', status: 'running', currentStepIndex: 0, finishedAt: null }),
      ]);
      routineRunStepFindMany.mockResolvedValue([
        prismaStepRow({
          id: 'rrs_1',
          runId: 'rr_active',
          stepIndex: 0,
          status: 'running',
          name: 'Pull Source',
          jobId: null,
        }),
      ]);

      const runs = await service.listRuns(WORKBOOK_ID, {});

      expect(getJobsProgress).not.toHaveBeenCalled();
      expect(runs[0].currentStepSummary).toBe('Pull Source…');
    });

    it('issues no extra queries when every listed run has finished', async () => {
      routineRunFindMany.mockResolvedValue([prismaRunRow()]);

      const runs = await service.listRuns(WORKBOOK_ID, {});

      expect(routineRunStepFindMany).not.toHaveBeenCalled();
      expect(getJobsProgress).not.toHaveBeenCalled();
      expect(runs[0].currentStepSummary).toBeNull();
    });
  });

  describe('getRun', () => {
    it('throws NotFoundException when the run is missing', async () => {
      routineRunFindFirst.mockResolvedValue(null);

      await expect(service.getRun(WORKBOOK_ID, 'rr_missing')).rejects.toThrow(NotFoundException);
    });

    it('returns steps without a job field and does not load jobs when includeJobs is not set', async () => {
      routineRunFindFirst.mockResolvedValue(prismaRunRow({ steps: [prismaStepRow()] }));

      const run = await service.getRun(WORKBOOK_ID, 'rr_1');

      expect(run.steps).toHaveLength(1);
      expect(run.steps?.[0]).not.toHaveProperty('job');
      expect(getJobsProgress).not.toHaveBeenCalled();
    });

    it("maps a step's name column to displayName on the wire (null when the step is unnamed)", async () => {
      routineRunFindFirst.mockResolvedValue(
        prismaRunRow({
          steps: [prismaStepRow({ name: 'Pull Source' }), prismaStepRow({ id: 'rrs_2', stepIndex: 1, name: null })],
        }),
      );

      const run = await service.getRun(WORKBOOK_ID, 'rr_1');

      expect(run.steps?.[0].displayName).toBe('Pull Source');
      expect(run.steps?.[1].displayName).toBeNull();
    });

    it('populates each step job from the batched fetch when includeJobs is true', async () => {
      routineRunFindFirst.mockResolvedValue(
        prismaRunRow({
          steps: [prismaStepRow({ jobId: 'bull_1' }), prismaStepRow({ id: 'rrs_2', stepIndex: 1, jobId: null })],
        }),
      );
      getJobsProgress.mockResolvedValue([jobEntityFixture({ bullJobId: 'bull_1' })]);

      const run = await service.getRun(WORKBOOK_ID, 'rr_1', true);

      expect(getJobsProgress).toHaveBeenCalledWith(['bull_1']);
      expect(run.steps?.[0].job).toMatchObject({ bullJobId: 'bull_1' });
      expect(run.steps?.[1].job).toBeNull();
    });

    // DEV-11256: the live progress line needs the in-flight step's job even when the caller didn't ask
    // for jobs — but the steps themselves must still come back without a `job` field.
    it("describes an active run's current step without attaching jobs to the steps", async () => {
      routineRunFindFirst.mockResolvedValue(
        prismaRunRow({
          status: 'running',
          currentStepIndex: 1,
          finishedAt: null,
          steps: [
            prismaStepRow({ id: 'rrs_1', stepIndex: 0, status: 'completed', jobId: 'bull_done' }),
            prismaStepRow({ id: 'rrs_2', stepIndex: 1, status: 'running', action: 'sync', jobId: 'bull_active' }),
          ],
        }),
      );
      getJobsProgress.mockResolvedValue([
        jobEntityFixture({
          bullJobId: 'bull_active',
          type: 'sync-data-folders',
          state: 'active',
          publicProgress: {
            totalFilesSynced: 450,
            tables: [{ id: 'dfd_1', name: 'Deals', status: 'in_progress' }],
          },
        }),
      ]);

      const run = await service.getRun(WORKBOOK_ID, 'rr_1');

      expect(getJobsProgress).toHaveBeenCalledWith(['bull_active']);
      expect(run.currentStepSummary).toBe('Syncing Deals — 450 records synced');
      expect(run.steps?.[0]).not.toHaveProperty('job');
    });

    it('reports no current step for a finished run, leaving resultSummary to describe it', async () => {
      routineRunFindFirst.mockResolvedValue(
        prismaRunRow({ resultSummary: 'Published 3 changes', steps: [prismaStepRow()] }),
      );

      const run = await service.getRun(WORKBOOK_ID, 'rr_1');

      expect(run.currentStepSummary).toBeNull();
      expect(run.resultSummary).toBe('Published 3 changes');
      expect(getJobsProgress).not.toHaveBeenCalled();
    });
  });
});
