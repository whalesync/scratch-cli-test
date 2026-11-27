import { WorkbookManager } from '@prisma/client';
import { LIVE_EXPORT_PAUSED_ERROR, ScratchPlanType, WorkbookId } from '@spinner/shared-types';
import { DbService } from 'src/db/db.service';
import { WSLogger } from 'src/logger';
import {
  LIVE_EXPORT_PAUSED_MESSAGE,
  LiveExportPausedException,
  LiveExportScheduledRunSoonerThanFastestCadenceError,
} from '../live-export-access.errors';
import { LiveExportAccessService } from '../live-export-access.service';

const WORKBOOK_ID = 'wkb_live_export' as WorkbookId;
const ROUTINE_FILE_PATH = 'routines/run-syn_1.yaml';
const NOW = new Date('2027-03-10T12:00:00Z');
const MINUTE_IN_MILLISECONDS = 60 * 1000;

function minutesBeforeNow(minutes: number): Date {
  return new Date(NOW.getTime() - minutes * MINUTE_IN_MILLISECONDS);
}

describe('LiveExportAccessService', () => {
  let service: LiveExportAccessService;
  let workbookFindUnique: jest.Mock;
  let subscriptionFindFirst: jest.Mock;
  let routineRunFindFirst: jest.Mock;

  beforeEach(() => {
    jest.spyOn(WSLogger, 'info').mockImplementation(() => {});

    workbookFindUnique = jest.fn().mockResolvedValue({ managedBy: WorkbookManager.ws_export, organizationId: 'org_1' });
    subscriptionFindFirst = jest.fn().mockResolvedValue({
      metadata: { liveExportsPaused: false, liveExportCadence: 'hourly', liveExportRecordCountLimit: 5000 },
    });
    routineRunFindFirst = jest.fn().mockResolvedValue(null);

    const db = {
      client: {
        workbook: { findUnique: workbookFindUnique },
        subscription: { findFirst: subscriptionFindFirst },
        routineRun: { findFirst: routineRunFindFirst },
      },
    } as unknown as DbService;
    service = new LiveExportAccessService(db);
  });

  afterEach(() => jest.restoreAllMocks());

  describe('readLiveExportAccessOfOrganization', () => {
    it("reads the organization's most recently updated Whalesync plan row", async () => {
      await expect(service.readLiveExportAccessOfOrganization('org_1')).resolves.toEqual({
        paused: false,
        recordLimit: 5000,
        fastestCadence: 'hourly',
      });
      expect(subscriptionFindFirst).toHaveBeenCalledWith({
        where: { organizationId: 'org_1', planType: ScratchPlanType.WHALESYNC_PLAN },
        select: { metadata: true },
        orderBy: { updatedAt: 'desc' },
      });
    });

    it('lets the Live Exports of an organization with no Whalesync plan row run with no limits', async () => {
      subscriptionFindFirst.mockResolvedValue(null);

      await expect(service.readLiveExportAccessOfOrganization('org_1')).resolves.toEqual({
        paused: false,
        recordLimit: null,
        fastestCadence: null,
      });
    });
  });

  describe('assertLiveExportRunAllowedOrThrow', () => {
    function assertRunAllowed(
      trigger: 'manual' | 'schedule',
      schedule?: { cronExpression: string; timezone: string | null },
    ): Promise<void> {
      return service.assertLiveExportRunAllowedOrThrow({
        workbookId: WORKBOOK_ID,
        routineFilePath: ROUTINE_FILE_PATH,
        trigger,
        schedule,
        now: NOW,
      });
    }

    it.each([
      ['a workbook that is not a Live Export', { managedBy: null, organizationId: 'org_1' }],
      ['a missing workbook', null],
    ])('is a no-op, reading no access, for %s', async (_description, workbook) => {
      workbookFindUnique.mockResolvedValue(workbook);

      await expect(assertRunAllowed('manual')).resolves.toBeUndefined();
      expect(subscriptionFindFirst).not.toHaveBeenCalled();
    });

    it.each(['manual', 'schedule'] as const)(
      'refuses a %s run with a 403 and a code while Whalesync has paused the team',
      async (trigger) => {
        subscriptionFindFirst.mockResolvedValue({ metadata: { liveExportsPaused: true } });

        const refusal = await assertRunAllowed(trigger).catch((error: unknown) => error);

        expect(refusal).toBeInstanceOf(LiveExportPausedException);
        const forbidden = refusal as LiveExportPausedException;
        expect(forbidden.getStatus()).toBe(403);
        expect(forbidden.getResponse()).toEqual({
          error: LIVE_EXPORT_PAUSED_ERROR,
          message: LIVE_EXPORT_PAUSED_MESSAGE,
        });
        expect(routineRunFindFirst).not.toHaveBeenCalled();
      },
    );

    it.each([
      ['no Whalesync plan row', null],
      ['a row from before Live Export access', { metadata: { whalesyncStatus: 'expired' } }],
      ['a row that stores the pause as something other than true', { metadata: { liveExportsPaused: 'yes' } }],
    ])('lets a run start for an organization with %s, since Whalesync never paused it', async (_description, row) => {
      subscriptionFindFirst.mockResolvedValue(row);

      await expect(assertRunAllowed('manual')).resolves.toBeUndefined();
    });

    it('allows a manual run without comparing it with past runs', async () => {
      routineRunFindFirst.mockResolvedValue({ createdAt: minutesBeforeNow(1) });

      await expect(assertRunAllowed('manual')).resolves.toBeUndefined();
      expect(routineRunFindFirst).not.toHaveBeenCalled();
    });

    it("never compares a run of a schedule that fits the team's speed with past runs", async () => {
      routineRunFindFirst.mockResolvedValue({ createdAt: minutesBeforeNow(30) });

      await expect(
        assertRunAllowed('schedule', { cronExpression: '0 * * * *', timezone: null }),
      ).resolves.toBeUndefined();
      expect(routineRunFindFirst).not.toHaveBeenCalled();
    });

    describe("a schedule faster than the team's speed", () => {
      const EVERY_10_MINUTES = { cronExpression: '*/10 * * * *', timezone: null };

      it('skips a run that comes sooner after the last scheduled run than the speed allows', async () => {
        const lastScheduledRunAt = minutesBeforeNow(20);
        routineRunFindFirst.mockResolvedValue({ createdAt: lastScheduledRunAt });

        const refusal = await assertRunAllowed('schedule', EVERY_10_MINUTES).catch((error: unknown) => error);

        expect(refusal).toBeInstanceOf(LiveExportScheduledRunSoonerThanFastestCadenceError);
        expect(refusal).toMatchObject({ fastestCadence: 'hourly', lastScheduledRunAt });
        expect(routineRunFindFirst).toHaveBeenCalledWith({
          where: { workbookId: WORKBOOK_ID, routineFilePath: ROUTINE_FILE_PATH, trigger: 'schedule' },
          orderBy: { createdAt: 'desc' },
          select: { createdAt: true },
        });
      });

      it.each([
        ['a minute short of an hour', 59, true],
        ['a second less than that', 59 - 1 / 60, false],
      ])('runs again once the last scheduled run is %s old: %s', async (_description, minutesAgo, allowed) => {
        routineRunFindFirst.mockResolvedValue({ createdAt: minutesBeforeNow(minutesAgo) });

        const outcome = await assertRunAllowed('schedule', EVERY_10_MINUTES).then(
          () => 'allowed',
          () => 'skipped',
        );

        expect(outcome).toBe(allowed ? 'allowed' : 'skipped');
      });

      it('allows the first scheduled run', async () => {
        await expect(assertRunAllowed('schedule', EVERY_10_MINUTES)).resolves.toBeUndefined();
      });

      it('compares a scheduled run with past runs when its schedule is unknown', async () => {
        routineRunFindFirst.mockResolvedValue({ createdAt: minutesBeforeNow(20) });

        await expect(assertRunAllowed('schedule')).rejects.toBeInstanceOf(
          LiveExportScheduledRunSoonerThanFastestCadenceError,
        );
      });

      it('allows any speed when the team has no speed limit', async () => {
        subscriptionFindFirst.mockResolvedValue({ metadata: { liveExportsPaused: false } });
        routineRunFindFirst.mockResolvedValue({ createdAt: minutesBeforeNow(1) });

        await expect(assertRunAllowed('schedule', EVERY_10_MINUTES)).resolves.toBeUndefined();
        expect(routineRunFindFirst).not.toHaveBeenCalled();
      });
    });
  });
});
