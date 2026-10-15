/**
 * DB-backed integration test for DEV-12330 (pushing failed Live Export runs to Whalesync), run against real Postgres.
 *
 * The unit specs mock Prisma. This spec validates what those mocks can't (migration
 * `20261015120000_whalesync_run_notification`):
 *   - the sweeper's backfill query, including the `whalesyncRunNotification: { is: null }` filter on the optional
 *     one-to-one back-relation, the finishedAt window, and the workbook/owner filters;
 *   - the unique `routineRunId`, which makes queuing a run twice a no-op;
 *   - the `routineRunId` FK cascade, which removes a workbook's notifications with the workbook.
 * Every id is unique to this run, so the assertions hold on a database that has other data.
 */

import { PrismaClient, WorkbookManager } from '@prisma/client';
import {
  createOrganizationId,
  createRoutineRunId,
  createUserId,
  createWorkbookId,
  RoutineRunId,
} from '@spinner/shared-types';
import { randomUUID } from 'crypto';
import { ScratchConfigService } from 'src/config/scratch-config.service';
import { findRecentlyFailedLiveExportRunIdsWithoutWhalesyncNotification } from 'src/cron/whalesync-run-notification-sweeper.service';
import { DbService } from 'src/db/db.service';
import { ExperimentsService } from 'src/experiments/experiments.service';
import { CustomMetricsService } from 'src/metrics/custom-metrics-service';
import { WhalesyncRunNotifierService } from 'src/routine/whalesync-run-notifier.service';
import { createIntegrationTestDbService } from './integration-db-service';

const MINUTE_MS = 60_000;

describe('Whalesync run notifications (DB-backed)', () => {
  let prisma: PrismaClient;
  let db: DbService;
  let notifier: WhalesyncRunNotifierService;

  const organizationId = createOrganizationId();
  const shadowOwnerUserId = createUserId();
  const whalesyncUserId = randomUUID();
  const liveExportWorkbookId = createWorkbookId();
  const liveExportWorkbookBeingDeletedId = createWorkbookId();
  const standaloneWorkbookId = createWorkbookId();
  const testWorkbookIds = [liveExportWorkbookId, liveExportWorkbookBeingDeletedId, standaloneWorkbookId];

  async function createRoutineRun(data: {
    workbookId: string;
    status: string;
    finishedMinutesAgo: number;
  }): Promise<RoutineRunId> {
    const runId = createRoutineRunId();
    await prisma.routineRun.create({
      data: {
        id: runId,
        workbookId: data.workbookId,
        routineFilePath: `routines/${runId}.yaml`,
        routineName: 'Live Export',
        status: data.status,
        trigger: 'schedule',
        finishedAt: new Date(Date.now() - data.finishedMinutesAgo * MINUTE_MS),
        resultSummary: 'Destination rejected the credentials',
        error: 'Step 2 (publish) failed: Destination rejected the credentials',
        liveExportEngine: 'classic',
      },
    });
    return runId;
  }

  beforeAll(async () => {
    prisma = new PrismaClient();
    db = createIntegrationTestDbService(prisma);
    notifier = new WhalesyncRunNotifierService(
      db,
      {} as ScratchConfigService,
      {} as ExperimentsService,
      { logValue: jest.fn() } as unknown as CustomMetricsService,
    );

    await prisma.organization.create({
      data: { id: organizationId, name: 'Whalesync Notify Org', clerkId: `clerk_wn_${organizationId}` },
    });
    await prisma.user.create({
      data: {
        id: shadowOwnerUserId,
        email: `wn-${shadowOwnerUserId}@example.com`,
        organizationId,
        whalesyncUserId,
        clerkId: `ws_${whalesyncUserId}`,
      },
    });
    await prisma.workbook.createMany({
      data: [
        {
          id: liveExportWorkbookId,
          name: 'Intercom → Supabase',
          managedBy: WorkbookManager.ws_export,
          userId: shadowOwnerUserId,
          organizationId,
        },
        {
          id: liveExportWorkbookBeingDeletedId,
          name: 'Deleted export',
          managedBy: WorkbookManager.ws_export,
          isPendingDelete: true,
          userId: shadowOwnerUserId,
          organizationId,
        },
        { id: standaloneWorkbookId, name: 'Standalone', userId: shadowOwnerUserId, organizationId },
      ],
    });
  });

  afterEach(async () => {
    // Runs cascade to their notifications.
    await prisma.routineRun.deleteMany({ where: { workbookId: { in: testWorkbookIds } } });
  });

  afterAll(async () => {
    await prisma.workbook.deleteMany({ where: { id: { in: testWorkbookIds } } });
    await prisma.user.deleteMany({ where: { id: shadowOwnerUserId } });
    await prisma.organization.deleteMany({ where: { id: organizationId } });
    await prisma.$disconnect();
  });

  it('backfills only recently failed Live Export runs that have no notification', async () => {
    const missedRunId = await createRoutineRun({
      workbookId: liveExportWorkbookId,
      status: 'failed',
      finishedMinutesAgo: 10,
    });
    const alreadyQueuedRunId = await createRoutineRun({
      workbookId: liveExportWorkbookId,
      status: 'failed',
      finishedMinutesAgo: 10,
    });
    await prisma.whalesyncRunNotification.create({
      data: { routineRunId: alreadyQueuedRunId, workbookId: liveExportWorkbookId, payload: {} },
    });
    const notBackfilledRunIds = [
      // Older than the lookback window.
      await createRoutineRun({ workbookId: liveExportWorkbookId, status: 'failed', finishedMinutesAgo: 90 }),
      // Inside the grace period the executor's hook gets.
      await createRoutineRun({ workbookId: liveExportWorkbookId, status: 'failed', finishedMinutesAgo: 0.5 }),
      await createRoutineRun({ workbookId: liveExportWorkbookId, status: 'completed', finishedMinutesAgo: 10 }),
      await createRoutineRun({ workbookId: standaloneWorkbookId, status: 'failed', finishedMinutesAgo: 10 }),
      await createRoutineRun({
        workbookId: liveExportWorkbookBeingDeletedId,
        status: 'failed',
        finishedMinutesAgo: 10,
      }),
    ];

    const backfillCandidateRunIds = await findRecentlyFailedLiveExportRunIdsWithoutWhalesyncNotification(
      db,
      new Date(),
    );

    expect(backfillCandidateRunIds).toContain(missedRunId);
    expect(backfillCandidateRunIds).not.toContain(alreadyQueuedRunId);
    for (const runId of notBackfilledRunIds) {
      expect(backfillCandidateRunIds).not.toContain(runId);
    }
  });

  it('queues a failed Live Export run once; queuing it again is a no-op', async () => {
    const runId = await createRoutineRun({ workbookId: liveExportWorkbookId, status: 'failed', finishedMinutesAgo: 5 });

    await expect(notifier.enqueueNotificationIfRunIsEligible(runId)).resolves.toBe(true);
    await expect(notifier.enqueueNotificationIfRunIsEligible(runId)).resolves.toBe(false);

    const notifications = await prisma.whalesyncRunNotification.findMany({ where: { routineRunId: runId } });
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toMatchObject({
      workbookId: liveExportWorkbookId,
      attempts: 0,
      deliveredAt: null,
      payload: expect.objectContaining({
        whalesyncUserId,
        workbookName: 'Intercom → Supabase',
        runId,
        status: 'failed',
        trigger: 'schedule',
      }) as unknown,
    });
    // ...and once queued, the backfill no longer sees it.
    expect(await findRecentlyFailedLiveExportRunIdsWithoutWhalesyncNotification(db, new Date())).not.toContain(runId);
  });

  it("deleting a workbook deletes its runs' notifications", async () => {
    const workbookToDeleteId = createWorkbookId();
    await prisma.workbook.create({
      data: {
        id: workbookToDeleteId,
        name: 'Short-lived export',
        managedBy: WorkbookManager.ws_export,
        userId: shadowOwnerUserId,
        organizationId,
      },
    });
    const runId = await createRoutineRun({ workbookId: workbookToDeleteId, status: 'failed', finishedMinutesAgo: 5 });
    await prisma.whalesyncRunNotification.create({
      data: { routineRunId: runId, workbookId: workbookToDeleteId, payload: {} },
    });

    await prisma.workbook.delete({ where: { id: workbookToDeleteId } });

    expect(await prisma.whalesyncRunNotification.findMany({ where: { routineRunId: runId } })).toHaveLength(0);
  });
});
