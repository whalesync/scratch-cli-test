/**
 * DB-backed integration test for DEV-12330 (pushing failed Live Export runs to Whalesync), run against real Postgres.
 *
 * The unit specs mock Prisma. This spec validates what those mocks can't (migration
 * `20261015120000_whalesync_run_notification`):
 *   - the sweeper's backfill query, including the `whalesyncRunNotification: { is: null }` filter on the optional
 *     one-to-one back-relation, the finishedAt window, and the workbook/owner filters;
 *   - the unique `routineRunId`, which makes queuing a run twice a no-op;
 *   - the `routineRunId` FK cascade, which removes a workbook's notifications with the workbook;
 *   - a notification names the Whalesync team that owns the Live Export and never a Whalesync person, and a run of a
 *     workbook whose user belongs to no team is neither queued nor backfilled (DEV-13019).
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

  // A team's shadow user, which owns the Live Exports below.
  const organizationId = createOrganizationId();
  const shadowOwnerUserId = createUserId();
  const whalesyncTeamId = `tm_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  const liveExportWorkbookId = createWorkbookId();
  const liveExportWorkbookBeingDeletedId = createWorkbookId();
  const standaloneWorkbookId = createWorkbookId();

  // A shadow user made for a Whalesync person before teams that was never given a team: it still carries the
  // deprecated `whalesyncUserId`, which the server no longer reads.
  const teamlessOrganizationId = createOrganizationId();
  const teamlessShadowUserId = createUserId();
  const leftoverWhalesyncUserIdOfTeamlessShadowUser = randomUUID();
  const teamlessLiveExportWorkbookId = createWorkbookId();

  const testWorkbookIds = [
    liveExportWorkbookId,
    liveExportWorkbookBeingDeletedId,
    standaloneWorkbookId,
    teamlessLiveExportWorkbookId,
  ];

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

    await prisma.organization.createMany({
      data: [
        { id: organizationId, name: 'Whalesync Team Org', clerkId: `ws_${whalesyncTeamId}` },
        {
          id: teamlessOrganizationId,
          name: 'Teamless Org',
          clerkId: `ws_${leftoverWhalesyncUserIdOfTeamlessShadowUser}`,
        },
      ],
    });
    // A team's shadow user carries the team's id, and no email or person.
    await prisma.user.create({
      data: { id: shadowOwnerUserId, organizationId, whalesyncTeamId, clerkId: `ws_${whalesyncTeamId}` },
    });
    await prisma.user.create({
      data: {
        id: teamlessShadowUserId,
        email: `wn-teamless-${teamlessShadowUserId.toLowerCase()}@example.com`,
        organizationId: teamlessOrganizationId,
        whalesyncUserId: leftoverWhalesyncUserIdOfTeamlessShadowUser,
        clerkId: `ws_${leftoverWhalesyncUserIdOfTeamlessShadowUser}`,
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
        {
          id: teamlessLiveExportWorkbookId,
          name: 'Teamless export',
          managedBy: WorkbookManager.ws_export,
          userId: teamlessShadowUserId,
          organizationId: teamlessOrganizationId,
        },
      ],
    });
  });

  afterEach(async () => {
    // Runs cascade to their notifications.
    await prisma.routineRun.deleteMany({ where: { workbookId: { in: testWorkbookIds } } });
  });

  afterAll(async () => {
    await prisma.workbook.deleteMany({ where: { id: { in: testWorkbookIds } } });
    await prisma.user.deleteMany({ where: { id: { in: [shadowOwnerUserId, teamlessShadowUserId] } } });
    await prisma.organization.deleteMany({ where: { id: { in: [organizationId, teamlessOrganizationId] } } });
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
      // Its workbook's user belongs to no Whalesync team.
      await createRoutineRun({ workbookId: teamlessLiveExportWorkbookId, status: 'failed', finishedMinutesAgo: 10 }),
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
        whalesyncTeamId,
        workbookId: liveExportWorkbookId,
        workbookName: 'Intercom → Supabase',
        runId,
        status: 'failed',
        trigger: 'schedule',
      }) as unknown,
    });
    // Scratch knows nothing about the people in a team, so the payload never names one.
    expect(notifications[0].payload).not.toHaveProperty('whalesyncUserId');
    // ...and once queued, the backfill no longer sees it.
    expect(await findRecentlyFailedLiveExportRunIdsWithoutWhalesyncNotification(db, new Date())).not.toContain(runId);
  });

  it('neither queues nor backfills a run of a workbook whose user belongs to no Whalesync team (DEV-13019)', async () => {
    const runId = await createRoutineRun({
      workbookId: teamlessLiveExportWorkbookId,
      status: 'failed',
      finishedMinutesAgo: 10,
    });

    await expect(notifier.enqueueNotificationIfRunIsEligible(runId)).resolves.toBe(false);

    // Skipped, not recorded as given up: there is no notification row at all.
    expect(await prisma.whalesyncRunNotification.count({ where: { routineRunId: runId } })).toBe(0);
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
