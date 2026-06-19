import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { WorkbookId } from '@spinner/shared-types';
import { AuditLogService } from 'src/audit/audit-log.service';
import { DbService } from 'src/db/db.service';
import { JobService } from 'src/job/job.service';
import { ScheduleService } from 'src/schedule/schedule.service';
import { RepoFileRef, ScratchGitService } from 'src/scratch-git/scratch-git.service';
import { Actor } from 'src/users/types';
import { RoutineParserService } from '../routine-parser.service';
import { RoutineReferenceValidatorService } from '../routine-reference-validator.service';
import { RoutineService } from '../routine.service';
import { RoutineValidationContext } from '../routine.types';

const WORKBOOK_ID = 'wkb_test1234' as WorkbookId;
const ACTOR: Actor = { userId: 'usr_test1234', organizationId: 'org_test1234' };

function fileRef(path: string): RepoFileRef {
  const name = path.includes('/') ? path.slice(path.lastIndexOf('/') + 1) : path;
  return { name, path, type: 'file' };
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
  let workbookFindFirst: jest.Mock;
  let listRepoFiles: jest.Mock;
  let getRepoFile: jest.Mock;
  let commitFilesToBranch: jest.Mock;
  let deleteFilesFromBranch: jest.Mock;
  let getBranchHead: jest.Mock;
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
    workbookFindFirst = jest.fn().mockResolvedValue({ organizationId: 'org_test1234' });
    listRepoFiles = jest.fn().mockResolvedValue([]);
    getRepoFile = jest.fn();
    commitFilesToBranch = jest.fn().mockResolvedValue({ created: [], updated: [], unchanged: [] });
    deleteFilesFromBranch = jest.fn().mockResolvedValue(undefined);
    getBranchHead = jest.fn().mockResolvedValue(null);
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
        workbook: { findFirst: workbookFindFirst },
      },
    } as unknown as DbService;

    const scratchGitService = {
      listRepoFiles,
      getRepoFile,
      commitFilesToBranch,
      deleteFilesFromBranch,
      getBranchHead,
    } as unknown as ScratchGitService;
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
      scratchGitService,
      scheduleService,
      new RoutineParserService(),
      referenceValidator,
      auditLogService,
      jobService,
    );
  });

  describe('reloadRoutines', () => {
    it('returns a routine joined with its ROUTINE schedule row (cron sourced from the DB, not the YAML)', async () => {
      listRepoFiles.mockResolvedValue([fileRef('routines/scheduled.yaml')]);
      getRepoFile.mockResolvedValue({ content: 'name: Scheduled\nsteps:\n  - action: pull\n' });
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
      listRepoFiles.mockResolvedValue([fileRef('routines/manual.yaml')]);
      getRepoFile.mockResolvedValue({ content: 'name: Manual\nsteps:\n  - action: pull\n' });

      const routines = await service.reloadRoutines(WORKBOOK_ID, ACTOR);

      expect(deleteRoutineScheduleByFilePath).not.toHaveBeenCalled();
      expect(deleteOrphanedRoutineSchedules).toHaveBeenCalledWith(WORKBOOK_ID, ['routines/manual.yaml']);
      expect(routines[0]).toMatchObject({ filePath: 'routines/manual.yaml', schedule: null, scheduleId: null });
    });

    it('orphan-cleans schedules for files no longer present, passing all present paths', async () => {
      listRepoFiles.mockResolvedValue([fileRef('routines/a.yaml'), fileRef('routines/b.yml')]);
      getRepoFile
        .mockResolvedValueOnce({ content: 'name: A\nsteps:\n  - action: pull\n' })
        .mockResolvedValueOnce({ content: 'name: B\nsteps:\n  - action: pull\n' });

      await service.reloadRoutines(WORKBOOK_ID, ACTOR);

      expect(deleteOrphanedRoutineSchedules).toHaveBeenCalledWith(WORKBOOK_ID, ['routines/a.yaml', 'routines/b.yml']);
    });

    it('surfaces a parse error and keeps reloading the rest', async () => {
      listRepoFiles.mockResolvedValue([fileRef('routines/broken.yaml'), fileRef('routines/ok.yaml')]);
      getRepoFile
        .mockResolvedValueOnce({ content: 'name: Broken\nsteps: []\n' }) // empty steps → invalid
        .mockResolvedValueOnce({ content: 'name: Ok\nsteps:\n  - action: pull\n' });

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

    it('treats a workbook with no routines folder as zero routines', async () => {
      listRepoFiles.mockResolvedValue([]);

      const routines = await service.reloadRoutines(WORKBOOK_ID, ACTOR);

      expect(routines).toEqual([]);
      // Orphan cleanup still runs (with an empty list) to clear any stale ROUTINE schedules.
      expect(deleteOrphanedRoutineSchedules).toHaveBeenCalledWith(WORKBOOK_ID, []);
    });

    it('surfaces referenceWarnings for a parsed routine with a broken reference, and writes no schedules', async () => {
      listRepoFiles.mockResolvedValue([fileRef('routines/a.yaml')]);
      // Parses fine, but `/gone` resolves to nothing in the (empty) validation context.
      getRepoFile.mockResolvedValue({
        content: 'name: A\nsteps:\n  - action: pull\n    folders:\n      - /gone\n',
      });

      const routines = await service.reloadRoutines(WORKBOOK_ID, ACTOR);

      expect(routines[0].parseError).toBeNull();
      expect(routines[0].referenceWarnings).toContain('steps.0.folders.0: folder "/gone" not found in this workbook');
      // Reload never writes schedules — the cron is owned by the Schedule table now.
      expect(deleteRoutineScheduleByFilePath).not.toHaveBeenCalled();
    });
  });

  describe('listRoutines', () => {
    it('joins schedule + latest run without writing any schedules', async () => {
      listRepoFiles.mockResolvedValue([fileRef('routines/a.yaml')]);
      getRepoFile.mockResolvedValue({ content: 'name: A\nsteps:\n  - action: pull\n' });
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

    it('lists the routines folder with NO trailing slash', async () => {
      // Regression guard: scratch-git's tree walk splits the folder on "/", so "routines/" resolves
      // to an empty subdir and returns nothing — routines would never appear. Must be "routines".
      await service.listRoutines(WORKBOOK_ID);
      expect(listRepoFiles).toHaveBeenCalledWith(expect.any(String), 'main', 'routines');
    });
  });

  describe('getRoutineFileContent', () => {
    it('returns the raw file content', async () => {
      getRepoFile.mockResolvedValue({ content: 'name: A\nsteps:\n  - action: pull\n' });

      const result = await service.getRoutineFileContent(WORKBOOK_ID, 'routines/a.yaml');

      expect(result).toEqual({ path: 'routines/a.yaml', content: 'name: A\nsteps:\n  - action: pull\n' });
    });

    it('throws NotFound when the file does not exist', async () => {
      getRepoFile.mockResolvedValue(null);

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
      expect(getRepoFile).not.toHaveBeenCalled();
    });
  });

  describe('createRoutineFile', () => {
    const VALID_YAML = 'name: Sched\nsteps:\n  - action: pull\n';

    it('commits the file, audit-logs, and returns the joined routine without writing a schedule', async () => {
      getRepoFile.mockResolvedValue(null); // does not already exist

      const routine = await service.createRoutineFile(
        WORKBOOK_ID,
        { path: 'routines/new.yaml', content: VALID_YAML },
        ACTOR,
      );

      expect(commitFilesToBranch).toHaveBeenCalledWith(
        expect.any(String),
        'main',
        [{ path: 'routines/new.yaml', content: VALID_YAML }],
        expect.stringContaining('Create routine routines/new.yaml'),
      );
      // The schedule is managed via the Schedule API now — create touches no schedule rows.
      expect(deleteRoutineScheduleByFilePath).not.toHaveBeenCalled();
      expect(logEvent).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'create' }));
      expect(routine).toMatchObject({ filePath: 'routines/new.yaml', name: 'Sched', parseError: null });
    });

    it('throws Conflict and does not commit when the file already exists', async () => {
      getRepoFile.mockResolvedValue({ content: 'name: Existing\nsteps:\n  - action: pull\n' });

      await expect(
        service.createRoutineFile(WORKBOOK_ID, { path: 'routines/dup.yaml', content: VALID_YAML }, ACTOR),
      ).rejects.toThrow(ConflictException);
      expect(commitFilesToBranch).not.toHaveBeenCalled();
    });

    it('throws BadRequest and does not commit when the YAML is invalid', async () => {
      getRepoFile.mockResolvedValue(null);

      await expect(
        service.createRoutineFile(
          WORKBOOK_ID,
          { path: 'routines/bad.yaml', content: 'name: Bad\nsteps: []\n' }, // empty steps → invalid
          ACTOR,
        ),
      ).rejects.toThrow(BadRequestException);
      expect(commitFilesToBranch).not.toHaveBeenCalled();
      // Reference validation must not run until the structural parse passes.
      expect(validateRoutine).not.toHaveBeenCalled();
    });

    it('throws BadRequest and does not commit when a referenced folder does not exist', async () => {
      getRepoFile.mockResolvedValue(null);
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
      expect(commitFilesToBranch).not.toHaveBeenCalled();
    });

    it('rejects a path outside routines/ before any git access', async () => {
      await expect(
        service.createRoutineFile(WORKBOOK_ID, { path: 'syncs/evil.yaml', content: VALID_YAML }, ACTOR),
      ).rejects.toThrow(BadRequestException);
      expect(getRepoFile).not.toHaveBeenCalled();
      expect(commitFilesToBranch).not.toHaveBeenCalled();
    });
  });

  describe('updateRoutineFile', () => {
    it('commits the new content and does not touch the schedule', async () => {
      getRepoFile.mockResolvedValue({ content: 'name: Old\nsteps:\n  - action: pull\n' });

      await service.updateRoutineFile(
        WORKBOOK_ID,
        { path: 'routines/a.yaml', content: 'name: Manual\nsteps:\n  - action: pull\n' },
        ACTOR,
      );

      expect(commitFilesToBranch).toHaveBeenCalledWith(
        expect.any(String),
        'main',
        [{ path: 'routines/a.yaml', content: 'name: Manual\nsteps:\n  - action: pull\n' }],
        expect.stringContaining('Update routine routines/a.yaml'),
      );
      // Editing the routine file never touches the schedule — it is owned by the Schedule table.
      expect(deleteRoutineScheduleByFilePath).not.toHaveBeenCalled();
      expect(logEvent).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'update' }));
    });

    it('throws NotFound and does not commit when the file is missing', async () => {
      getRepoFile.mockResolvedValue(null);

      await expect(
        service.updateRoutineFile(
          WORKBOOK_ID,
          { path: 'routines/missing.yaml', content: 'name: X\nsteps:\n  - action: pull\n' },
          ACTOR,
        ),
      ).rejects.toThrow(NotFoundException);
      expect(commitFilesToBranch).not.toHaveBeenCalled();
    });

    it('throws BadRequest and does not commit when a referenced connection does not exist', async () => {
      getRepoFile.mockResolvedValue({ content: 'name: Old\nsteps:\n  - action: pull\n' });
      validateRoutine.mockResolvedValue(['steps.0.connection: connection "ghost" not found in this workbook']);

      await expect(
        service.updateRoutineFile(
          WORKBOOK_ID,
          { path: 'routines/a.yaml', content: 'name: A\nsteps:\n  - action: pull\n    connection: ghost\n' },
          ACTOR,
        ),
      ).rejects.toThrow(BadRequestException);
      expect(validateRoutine).toHaveBeenCalledTimes(1);
      expect(commitFilesToBranch).not.toHaveBeenCalled();
    });
  });

  describe('deleteRoutineFile', () => {
    it('deletes the file and its schedule and audit-logs', async () => {
      getRepoFile.mockResolvedValue({ content: 'name: A\nsteps:\n  - action: pull\n' });

      await service.deleteRoutineFile(WORKBOOK_ID, 'routines/a.yaml', ACTOR);

      expect(deleteFilesFromBranch).toHaveBeenCalledWith(
        expect.any(String),
        'main',
        ['routines/a.yaml'],
        expect.stringContaining('Delete routine routines/a.yaml'),
      );
      expect(deleteRoutineScheduleByFilePath).toHaveBeenCalledWith(WORKBOOK_ID, 'routines/a.yaml');
      expect(logEvent).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'delete' }));
    });

    it('throws NotFound and does not delete when the file is missing', async () => {
      getRepoFile.mockResolvedValue(null);

      await expect(service.deleteRoutineFile(WORKBOOK_ID, 'routines/missing.yaml', ACTOR)).rejects.toThrow(
        NotFoundException,
      );
      expect(deleteFilesFromBranch).not.toHaveBeenCalled();
    });
  });

  describe('pushRoutineFiles', () => {
    const VALID = 'name: Daily\nsteps:\n  - action: pull\n';

    it('commits upserts and deletes, reloads, and returns the new head', async () => {
      getBranchHead.mockResolvedValue('headsha123');
      // reloadRoutines reads the committed files back to reconcile + return them.
      listRepoFiles.mockResolvedValue([fileRef('routines/new.yaml')]);
      getRepoFile.mockResolvedValue({ content: VALID });

      const result = await service.pushRoutineFiles(
        WORKBOOK_ID,
        { upserts: [{ path: 'routines/new.yaml', content: VALID }], deletes: ['routines/old.yaml'] },
        ACTOR,
      );

      expect(commitFilesToBranch).toHaveBeenCalledWith(
        expect.any(String),
        'main',
        [{ path: 'routines/new.yaml', content: VALID }],
        expect.stringContaining('Push routines'),
      );
      expect(deleteFilesFromBranch).toHaveBeenCalledWith(
        expect.any(String),
        'main',
        ['routines/old.yaml'],
        expect.stringContaining('Push routines'),
      );
      expect(result.head).toBe('headsha123');
      expect(result.routines).toHaveLength(1);
      // The commit/delete messages above already assert the "Push routines" wording; here just
      // confirm an audit event was logged for the push.
      expect(logEvent).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'update' }));
    });

    it('refuses with 409 blocked_stale when baseHead no longer matches, with no side effects', async () => {
      getBranchHead.mockResolvedValue('serverHeadAdvanced');

      await expect(
        service.pushRoutineFiles(
          WORKBOOK_ID,
          { upserts: [{ path: 'routines/a.yaml', content: VALID }], deletes: [], baseHead: 'staleLocalHead' },
          ACTOR,
        ),
      ).rejects.toThrow(ConflictException);

      expect(commitFilesToBranch).not.toHaveBeenCalled();
      expect(deleteFilesFromBranch).not.toHaveBeenCalled();
      expect(logEvent).not.toHaveBeenCalled();
    });

    it('proceeds (no staleness guard) when baseHead is omitted even though the head differs', async () => {
      getBranchHead.mockResolvedValue('someServerHead');
      listRepoFiles.mockResolvedValue([fileRef('routines/a.yaml')]);
      getRepoFile.mockResolvedValue({ content: VALID });

      await service.pushRoutineFiles(
        WORKBOOK_ID,
        { upserts: [{ path: 'routines/a.yaml', content: VALID }], deletes: [] },
        ACTOR,
      );

      expect(commitFilesToBranch).toHaveBeenCalledTimes(1);
    });

    it('rejects a path outside routines/ before any git call', async () => {
      await expect(
        service.pushRoutineFiles(
          WORKBOOK_ID,
          { upserts: [{ path: 'secrets/leak.yaml', content: VALID }], deletes: [] },
          ACTOR,
        ),
      ).rejects.toThrow(BadRequestException);

      expect(getBranchHead).not.toHaveBeenCalled();
      expect(commitFilesToBranch).not.toHaveBeenCalled();
    });

    it('rejects a path listed in both upserts and deletes', async () => {
      await expect(
        service.pushRoutineFiles(
          WORKBOOK_ID,
          { upserts: [{ path: 'routines/a.yaml', content: VALID }], deletes: ['routines/a.yaml'] },
          ACTOR,
        ),
      ).rejects.toThrow(BadRequestException);

      expect(commitFilesToBranch).not.toHaveBeenCalled();
    });

    it('rejects malformed YAML before the staleness check or any commit', async () => {
      await expect(
        service.pushRoutineFiles(
          WORKBOOK_ID,
          { upserts: [{ path: 'routines/a.yaml', content: 'steps: [] # missing name' }], deletes: [] },
          ACTOR,
        ),
      ).rejects.toThrow(BadRequestException);

      expect(getBranchHead).not.toHaveBeenCalled();
      expect(commitFilesToBranch).not.toHaveBeenCalled();
    });

    it('rejects an unresolved reference before any commit', async () => {
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

      expect(commitFilesToBranch).not.toHaveBeenCalled();
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
  });
});
