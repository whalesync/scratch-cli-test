import { WorkbookId } from '@spinner/shared-types';
import { AuditLogService } from 'src/audit/audit-log.service';
import { DbService } from 'src/db/db.service';
import { ScheduleService } from 'src/schedule/schedule.service';
import { RepoFileRef, ScratchGitService } from 'src/scratch-git/scratch-git.service';
import { Actor } from 'src/users/types';
import { RoutineParserService } from '../routine-parser.service';
import { RoutineService } from '../routine.service';

const WORKBOOK_ID = 'wkb_test1234' as WorkbookId;
const ACTOR: Actor = { userId: 'usr_test1234', organizationId: 'org_test1234' };

function fileRef(path: string): RepoFileRef {
  const name = path.includes('/') ? path.slice(path.lastIndexOf('/') + 1) : path;
  return { name, path, type: 'file' };
}

describe('RoutineService', () => {
  let routineRunFindMany: jest.Mock;
  let workbookFindFirst: jest.Mock;
  let listRepoFiles: jest.Mock;
  let getRepoFile: jest.Mock;
  let upsertRoutineSchedule: jest.Mock;
  let deleteRoutineScheduleByFilePath: jest.Mock;
  let deleteOrphanedRoutineSchedules: jest.Mock;
  let findRoutineSchedules: jest.Mock;
  let logEvent: jest.Mock;
  let service: RoutineService;

  beforeEach(() => {
    routineRunFindMany = jest.fn().mockResolvedValue([]);
    workbookFindFirst = jest.fn().mockResolvedValue({ organizationId: 'org_test1234' });
    listRepoFiles = jest.fn().mockResolvedValue([]);
    getRepoFile = jest.fn();
    upsertRoutineSchedule = jest.fn().mockResolvedValue(undefined);
    deleteRoutineScheduleByFilePath = jest.fn().mockResolvedValue(undefined);
    deleteOrphanedRoutineSchedules = jest.fn().mockResolvedValue(undefined);
    findRoutineSchedules = jest.fn().mockResolvedValue([]);
    logEvent = jest.fn().mockResolvedValue(undefined);

    const db = {
      client: {
        routineRun: { findMany: routineRunFindMany },
        workbook: { findFirst: workbookFindFirst },
      },
    } as unknown as DbService;

    const scratchGitService = { listRepoFiles, getRepoFile } as unknown as ScratchGitService;
    const scheduleService = {
      upsertRoutineSchedule,
      deleteRoutineScheduleByFilePath,
      deleteOrphanedRoutineSchedules,
      findRoutineSchedules,
    } as unknown as ScheduleService;
    const auditLogService = { logEvent } as unknown as AuditLogService;

    service = new RoutineService(db, scratchGitService, scheduleService, new RoutineParserService(), auditLogService);
  });

  describe('reloadRoutines', () => {
    it('upserts a ROUTINE schedule for a routine with a schedule and returns it joined', async () => {
      listRepoFiles.mockResolvedValue([fileRef('routines/scheduled.yaml')]);
      getRepoFile.mockResolvedValue({ content: 'name: Scheduled\nschedule: "0 9 * * *"\nsteps:\n  - action: pull\n' });
      findRoutineSchedules.mockResolvedValue([
        { entityId: 'routines/scheduled.yaml', id: 'sch_routine01', enabled: true },
      ]);

      const routines = await service.reloadRoutines(WORKBOOK_ID, ACTOR);

      expect(upsertRoutineSchedule).toHaveBeenCalledWith(
        WORKBOOK_ID,
        { filePath: 'routines/scheduled.yaml', name: 'Scheduled', cronExpression: '0 9 * * *' },
        ACTOR,
      );
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

    it('deletes the schedule for a routine without a schedule field', async () => {
      listRepoFiles.mockResolvedValue([fileRef('routines/manual.yaml')]);
      getRepoFile.mockResolvedValue({ content: 'name: Manual\nsteps:\n  - action: sync\n' });

      await service.reloadRoutines(WORKBOOK_ID, ACTOR);

      expect(deleteRoutineScheduleByFilePath).toHaveBeenCalledWith(WORKBOOK_ID, 'routines/manual.yaml');
      expect(upsertRoutineSchedule).not.toHaveBeenCalled();
    });

    it('orphan-cleans schedules for files no longer present, passing all present paths', async () => {
      listRepoFiles.mockResolvedValue([fileRef('routines/a.yaml'), fileRef('routines/b.yml')]);
      getRepoFile
        .mockResolvedValueOnce({ content: 'name: A\nsteps:\n  - action: pull\n' })
        .mockResolvedValueOnce({ content: 'name: B\nsteps:\n  - action: pull\n' });

      await service.reloadRoutines(WORKBOOK_ID, ACTOR);

      expect(deleteOrphanedRoutineSchedules).toHaveBeenCalledWith(WORKBOOK_ID, ['routines/a.yaml', 'routines/b.yml']);
    });

    it('surfaces a parse error without touching that file’s schedule, and keeps reloading', async () => {
      listRepoFiles.mockResolvedValue([fileRef('routines/broken.yaml'), fileRef('routines/ok.yaml')]);
      getRepoFile
        .mockResolvedValueOnce({ content: 'name: Broken\nsteps: []\n' }) // empty steps → invalid
        .mockResolvedValueOnce({ content: 'name: Ok\nsteps:\n  - action: pull\n' });

      const routines = await service.reloadRoutines(WORKBOOK_ID, ACTOR);

      // The broken file does not trigger an upsert or a per-file delete...
      expect(upsertRoutineSchedule).not.toHaveBeenCalled();
      expect(deleteRoutineScheduleByFilePath).toHaveBeenCalledTimes(1);
      expect(deleteRoutineScheduleByFilePath).toHaveBeenCalledWith(WORKBOOK_ID, 'routines/ok.yaml');
      // ...but it is still a "present" file for orphan cleanup.
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
  });

  describe('listRoutines', () => {
    it('joins schedule + latest run without writing any schedules', async () => {
      listRepoFiles.mockResolvedValue([fileRef('routines/a.yaml')]);
      getRepoFile.mockResolvedValue({ content: 'name: A\nsteps:\n  - action: pull\n' });
      findRoutineSchedules.mockResolvedValue([{ entityId: 'routines/a.yaml', id: 'sch_a0000001', enabled: false }]);
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

      expect(upsertRoutineSchedule).not.toHaveBeenCalled();
      expect(deleteRoutineScheduleByFilePath).not.toHaveBeenCalled();
      expect(deleteOrphanedRoutineSchedules).not.toHaveBeenCalled();
      expect(routines[0]).toMatchObject({
        filePath: 'routines/a.yaml',
        scheduleId: 'sch_a0000001',
        scheduleEnabled: false,
        latestRun: { id: 'rrn_run00001', status: 'completed', trigger: 'manual' },
      });
    });
  });
});
