/**
 * DB-backed live-pipeline E2E for the DEV-9698 (T4) per-connection quiesce — the
 * "publish/sync interleaved with a migration batch" scenario the plan deferred
 * (`docs/plans/2026-06-11-webflow-folder-structure-and-support-all.md` → Tests →
 * Integration / E2E, bullet A3/#6).
 *
 * The unit specs exercise the quiesce gate + schedule logic against mocked Prisma,
 * and `connection-quiesce-db.spec.ts` pins the lock gate + the marker-driven
 * schedule crash-repair against real Postgres in isolation. Neither drives the
 * REAL `ConnectionQuiesceService.quiesceConnection` / `unquiesceConnection` pair
 * end-to-end against live pipeline state — real `PublishPlan` rows, real `DbJob`
 * rows, real `Schedule` rows, and the two migration gates resolving jobs through
 * real sync-pair / connector-account FKs. That's what this spec covers: the
 * migration's effect on a connection that has in-flight work and the guarantee
 * that everything is usable again after release.
 *
 * What this proves (all against real Postgres):
 *   - quiesce cancels the connection's non-terminal publish plans (and ONLY that
 *     connection's — a sibling connection's plan in the same workbook survives),
 *   - quiesce cancels the connection's in-flight jobs — including a SyncDataFolders
 *     job whose connection is resolved through real `SyncTablePair` source/dest
 *     folder FKs — and drains to a clean stop,
 *   - while quiesced, a live web save / `/upload-patch/commit`
 *     (`assertConnectionNotMigrating`) AND a new job enqueue
 *     (`assertEnqueueAllowedForJob`) are both rejected with 409 — and the enqueue
 *     gate is correctly SCOPED (a job touching a different, unlocked connection in
 *     the same workbook is still allowed),
 *   - the connection's enabled schedules are disabled (marked) so none fires
 *     mid-migration; a user-disabled schedule is left untouched,
 *   - after `unquiesceConnection`: the lock is cleared, both gates pass again,
 *     schedules are restored, a workbook-updated event is emitted, and the
 *     already-cancelled plans/jobs STAY cancelled (release never resurrects work),
 *   - a connection whose worker won't stop (the BullMQ `active` set never clears)
 *     fails the drain with `ConnectionDrainTimeoutError` while STILL holding the
 *     lock — the migration's "abort-and-skip a busy connection" contract.
 *
 * Construction mirrors `connection-quiesce-db.spec.ts`: hand-build the real
 * services against a real `PrismaClient` (no NestJS TestingModule). The only seam
 * we stub is `JobService.getActiveBullJobDatas`, which reads the live BullMQ
 * `active` set — there is no running worker in a test, so it returns `[]` (drain
 * stops on the first poll); the timeout case overrides it to keep reporting an
 * active job. Seeded jobs carry no `bullJobId`, so `systemCancelJob` takes its
 * pure-DB path and never touches Redis. Everything else — the publish-plan cancel
 * SQL, the schedule disable/restore, the lock, the job→account resolution — is the
 * shipped code running against real rows.
 */

import { ConflictException } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import {
  ConnectorAccountId,
  createConnectorAccountId,
  createDataFolderId,
  createJobId,
  createOrganizationId,
  createScheduleId,
  createSyncId,
  createUserId,
  createWorkbookId,
  JobType,
  PublishPlanStatus,
  ScheduleAction,
  SyncId,
  WorkbookId,
} from '@spinner/shared-types';
import { ConnectionDrainTimeoutError, ConnectionQuiesceService } from 'src/code-migrations/connection-quiesce.service';
import { ScratchConfigService } from 'src/config/scratch-config.service';
import { DbService } from 'src/db/db.service';
import { JobService } from 'src/job/job.service';
import { MigrationLockService } from 'src/migration-lock/migration-lock.service';
import { PublishPlanBuildService } from 'src/publish-plan/publish-plan-build.service';
import { ScheduleService } from 'src/schedule/schedule.service';
import { WorkbookEventService } from 'src/workbook/workbook-event.service';
import type { JobData } from 'src/worker/jobs/union-types';

describe('Webflow folder migration — live-pipeline quiesce/release (DB-backed)', () => {
  let prisma: PrismaClient;
  let dbService: DbService;

  let migrationLockService: MigrationLockService;
  let scheduleService: ScheduleService;
  let jobService: JobService;
  let quiesceService: ConnectionQuiesceService;
  let sendWorkbookEvent: jest.Mock;

  // Stable fixture ids reused across tests. The connection under migration is
  // `connectionUnderMigrationId`; `siblingConnectionId` is a second connection in
  // the SAME workbook that must be left entirely alone (scoping proof).
  const organizationId = createOrganizationId();
  const workbookId: WorkbookId = createWorkbookId();
  const ownerUserId = createUserId();
  const connectionUnderMigrationId: ConnectorAccountId = createConnectorAccountId();
  const siblingConnectionId: ConnectorAccountId = createConnectorAccountId();
  // A sync wholly inside the connection under migration (both folders belong to it),
  // so a SyncDataFolders job resolves to that connection through real table-pair FKs.
  const syncSourceFolderId = createDataFolderId();
  const syncDestinationFolderId = createDataFolderId();
  const syncId: SyncId = createSyncId();

  const enabledScheduleId = createScheduleId();
  const userDisabledScheduleId = createScheduleId();

  // Builders for typed job payloads — used both as the seeded `DbJob.data` and as
  // direct `assertEnqueueAllowedForJob` arguments.
  const publishJobDataForConnection = (connectorAccountId: string): JobData => ({
    type: JobType.Publish,
    workbookId,
    userId: ownerUserId,
    pipelineId: 'pipeline-under-test',
    connectorAccountId,
  });
  const syncJobDataForSync = (): JobData => ({
    type: JobType.SyncDataFolders,
    workbookId,
    syncId,
    organizationId,
    userId: ownerUserId,
  });

  beforeAll(async () => {
    prisma = new PrismaClient();
    dbService = { client: prisma } as unknown as DbService;

    migrationLockService = new MigrationLockService(dbService);
    scheduleService = new ScheduleService(dbService);
    // JobService only reaches Redis via `getActiveBullJobDatas` (stubbed per test)
    // and `systemCancelJob` for jobs WITH a bullJobId (we seed none) — so the
    // config service is never consulted at runtime here.
    jobService = new JobService(dbService, {} as unknown as ScratchConfigService);

    // `cancelNonTerminalPlansForConnection` (the only method quiesce calls on the
    // publish-plan build service) touches solely `this.db`; the remaining seven
    // constructor dependencies are never invoked in this test, so they're unset.
    const unusedDependency = undefined as never;
    const publishPlanBuildService = new PublishPlanBuildService(
      dbService,
      unusedDependency,
      unusedDependency,
      unusedDependency,
      unusedDependency,
      unusedDependency,
      unusedDependency,
      unusedDependency,
      unusedDependency,
    );

    sendWorkbookEvent = jest.fn();
    const workbookEventService = { sendWorkbookEvent } as unknown as WorkbookEventService;

    quiesceService = new ConnectionQuiesceService(
      migrationLockService,
      scheduleService,
      publishPlanBuildService,
      jobService,
      workbookEventService,
    );

    await prisma.organization.create({
      data: { id: organizationId, name: 'WF Live-Pipeline Org', clerkId: `clerk_wflp_${organizationId}` },
    });
    await prisma.user.create({ data: { id: ownerUserId, organizationId } });
    await prisma.workbook.create({ data: { id: workbookId, name: 'WF Live-Pipeline WB', organizationId } });
    await prisma.connectorAccount.create({
      data: { id: connectionUnderMigrationId, workbookId, service: 'webflow', displayName: 'Migrating WF' },
    });
    await prisma.connectorAccount.create({
      data: { id: siblingConnectionId, workbookId, service: 'webflow', displayName: 'Sibling WF' },
    });

    // Both sync folders live in the connection under migration, so the sync
    // resolves to exactly that connection (and not the sibling).
    await prisma.dataFolder.create({
      data: {
        id: syncSourceFolderId,
        name: 'Source',
        workbookId,
        connectorAccountId: connectionUnderMigrationId,
        path: '/Migrating Site/Source',
      },
    });
    await prisma.dataFolder.create({
      data: {
        id: syncDestinationFolderId,
        name: 'Dest',
        workbookId,
        connectorAccountId: connectionUnderMigrationId,
        path: '/Migrating Site/Dest',
      },
    });
    await prisma.sync.create({ data: { id: syncId, displayName: 'WF Sync', mappings: [], workbookId } });
    await prisma.syncTablePair.create({
      data: {
        id: createSyncId(),
        syncId,
        sourceDataFolderId: syncSourceFolderId,
        destinationDataFolderId: syncDestinationFolderId,
      },
    });
  });

  afterAll(async () => {
    // DbJob has no workbook FK cascade — it cascades only via its `userId` owner.
    // Deleting the user clears any leftover jobs + publish plans; deleting the org
    // cascades the workbook → connector accounts, data folders, sync, table pairs,
    // and schedules.
    await prisma.dbJob.deleteMany({ where: { workbookId } });
    await prisma.publishPlan.deleteMany({ where: { workbookId } });
    await prisma.schedule.deleteMany({ where: { workbookId } });
    await prisma.user.deleteMany({ where: { id: ownerUserId } });
    await prisma.organization.deleteMany({ where: { id: organizationId } });
    await prisma.$disconnect();
  });

  // Volatile per-test state: plans, jobs, schedules, the lock, and the spy.
  beforeEach(async () => {
    await prisma.schedule.create({
      data: {
        id: enabledScheduleId,
        workbookId,
        organizationId,
        name: 'Connection full pull (enabled)',
        action: ScheduleAction.CONNECTION_FULL_PULL,
        entityId: connectionUnderMigrationId,
        cronExpression: '0 * * * *',
        enabled: true,
      },
    });
    await prisma.schedule.create({
      data: {
        id: userDisabledScheduleId,
        workbookId,
        organizationId,
        name: 'Connection incremental pull (user-disabled)',
        action: ScheduleAction.CONNECTION_INCREMENTAL_PULL,
        entityId: connectionUnderMigrationId,
        cronExpression: '0 * * * *',
        enabled: false,
      },
    });

    // Publish plans: one non-terminal on the migrating connection (must cancel),
    // one terminal on the migrating connection (must survive), one non-terminal on
    // the sibling connection (must survive — cancel is connection-scoped).
    await prisma.publishPlan.createMany({
      data: [
        {
          id: 'plan-nonterminal-migrating',
          workbookId,
          userId: ownerUserId,
          status: PublishPlanStatus.EditsRunning,
          branchName: 'dirty/migrating',
          connectorAccountId: connectionUnderMigrationId,
        },
        {
          id: 'plan-terminal-migrating',
          workbookId,
          userId: ownerUserId,
          status: PublishPlanStatus.Completed,
          branchName: 'dirty/migrating',
          connectorAccountId: connectionUnderMigrationId,
        },
        {
          id: 'plan-nonterminal-sibling',
          workbookId,
          userId: ownerUserId,
          status: PublishPlanStatus.Planning,
          branchName: 'dirty/sibling',
          connectorAccountId: siblingConnectionId,
        },
      ],
    });

    // In-flight jobs: a publish + a sync on the migrating connection (must cancel),
    // a publish on the sibling connection (must survive). No `bullJobId` → the
    // cancel takes its pure-DB path.
    await prisma.dbJob.createMany({
      data: [
        {
          id: createJobId(),
          userId: ownerUserId,
          workbookId,
          status: 'active',
          type: JobType.Publish,
          data: publishJobDataForConnection(connectionUnderMigrationId) as unknown as Prisma.InputJsonValue,
        },
        {
          id: createJobId(),
          userId: ownerUserId,
          workbookId,
          status: 'created',
          type: JobType.SyncDataFolders,
          data: syncJobDataForSync() as unknown as Prisma.InputJsonValue,
        },
        {
          id: createJobId(),
          userId: ownerUserId,
          workbookId,
          status: 'created',
          type: JobType.Publish,
          data: publishJobDataForConnection(siblingConnectionId) as unknown as Prisma.InputJsonValue,
        },
      ],
    });
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await prisma.dbJob.deleteMany({ where: { workbookId } });
    await prisma.publishPlan.deleteMany({ where: { workbookId } });
    await prisma.schedule.deleteMany({ where: { workbookId } });
    // Always release both connections so a failed test never leaves a lock that
    // could leak into another spec via the global `assertEnqueueAllowedForJob` scan.
    await prisma.connectorAccount.updateMany({
      where: { id: { in: [connectionUnderMigrationId, siblingConnectionId] } },
      data: { migrationLockedAt: null },
    });
  });

  // A publish job carries its connection in `data.connectorAccountId`, so the two
  // seeded publish jobs (migrating vs sibling) are told apart by it.
  const publishJobStatusForConnection = async (connectorAccountId: string): Promise<string | undefined> => {
    const publishJobs = await prisma.dbJob.findMany({ where: { workbookId, type: JobType.Publish } });
    const match = publishJobs.find(
      (job) => (job.data as { connectorAccountId?: string }).connectorAccountId === connectorAccountId,
    );
    return match?.status;
  };

  // The sync job carries no `connectorAccountId` (its connection is resolved via
  // the sync's table pairs); there is exactly one, so fetch it directly.
  const syncJobStatus = async (): Promise<string | undefined> => {
    const syncJob = await prisma.dbJob.findFirst({ where: { workbookId, type: JobType.SyncDataFolders } });
    return syncJob?.status;
  };

  it('cancels the connection’s in-flight work + blocks new work while quiesced, then restores it on release', async () => {
    // No worker is running anything for this connection, so the drain's `active`
    // poll is empty and it stops on the first pass.
    const getActiveBullJobDatasSpy = jest.spyOn(jobService, 'getActiveBullJobDatas').mockResolvedValue([]);

    // Before quiesce, both gates allow work on the connection.
    await expect(
      migrationLockService.assertConnectionNotMigrating(connectionUnderMigrationId),
    ).resolves.toBeUndefined();
    await expect(
      migrationLockService.assertEnqueueAllowedForJob(publishJobDataForConnection(connectionUnderMigrationId)),
    ).resolves.toBeUndefined();

    // ── Quiesce (the migration's "enter the batch" step). ──
    const summary = await quiesceService.quiesceConnection(workbookId, connectionUnderMigrationId);

    // Exactly the migrating connection's non-terminal plan + its two jobs were cancelled.
    expect(summary).toEqual({ cancelledPublishPlans: 1, cancelledJobs: 2 });
    expect(getActiveBullJobDatasSpy).toHaveBeenCalled();

    // Publish plans: migrating non-terminal → cancelled; migrating terminal +
    // sibling non-terminal → untouched.
    const planById = new Map(
      (await prisma.publishPlan.findMany({ where: { workbookId } })).map((plan) => [plan.id, plan.status]),
    );
    expect(planById.get('plan-nonterminal-migrating')).toBe(PublishPlanStatus.Canceled);
    expect(planById.get('plan-terminal-migrating')).toBe(PublishPlanStatus.Completed);
    expect(planById.get('plan-nonterminal-sibling')).toBe(PublishPlanStatus.Planning);

    // Jobs: both migrating-connection jobs cancelled (incl. the sync resolved via
    // table-pair FKs); the sibling-connection job survives.
    expect(await publishJobStatusForConnection(connectionUnderMigrationId)).toBe('canceled');
    expect(await syncJobStatus()).toBe('canceled');
    expect(await publishJobStatusForConnection(siblingConnectionId)).toBe('created');

    // Schedules: the enabled one is disabled + marked; the user-disabled one is untouched.
    const enabledSchedule = await prisma.schedule.findUniqueOrThrow({ where: { id: enabledScheduleId } });
    const userDisabledSchedule = await prisma.schedule.findUniqueOrThrow({ where: { id: userDisabledScheduleId } });
    expect(enabledSchedule.enabled).toBe(false);
    expect(enabledSchedule.disabledForMigrationAt).not.toBeNull();
    expect(userDisabledSchedule.enabled).toBe(false);
    expect(userDisabledSchedule.disabledForMigrationAt).toBeNull();

    // ── While quiesced: live edits + new enqueues for THIS connection are rejected. ──
    await expect(migrationLockService.assertConnectionNotMigrating(connectionUnderMigrationId)).rejects.toBeInstanceOf(
      ConflictException,
    );
    await expect(
      migrationLockService.assertEnqueueAllowedForJob(publishJobDataForConnection(connectionUnderMigrationId)),
    ).rejects.toBeInstanceOf(ConflictException);
    // …but the enqueue gate is scoped: a job touching the unlocked sibling
    // connection in the same workbook is still allowed.
    await expect(
      migrationLockService.assertEnqueueAllowedForJob(publishJobDataForConnection(siblingConnectionId)),
    ).resolves.toBeUndefined();

    // ── Release (the migration's "leave the batch" step). ──
    await quiesceService.unquiesceConnection(workbookId, connectionUnderMigrationId);

    // Lock cleared → both gates pass again.
    expect(await migrationLockService.isConnectionMigrating(connectionUnderMigrationId)).toBe(false);
    await expect(
      migrationLockService.assertConnectionNotMigrating(connectionUnderMigrationId),
    ).resolves.toBeUndefined();
    await expect(
      migrationLockService.assertEnqueueAllowedForJob(publishJobDataForConnection(connectionUnderMigrationId)),
    ).resolves.toBeUndefined();

    // Schedule restored (re-enabled, marker cleared, next run recomputed); user-disabled stays off.
    const restoredEnabled = await prisma.schedule.findUniqueOrThrow({ where: { id: enabledScheduleId } });
    expect(restoredEnabled.enabled).toBe(true);
    expect(restoredEnabled.disabledForMigrationAt).toBeNull();
    expect(restoredEnabled.nextRunAt).not.toBeNull();
    const stillUserDisabled = await prisma.schedule.findUniqueOrThrow({ where: { id: userDisabledScheduleId } });
    expect(stillUserDisabled.enabled).toBe(false);

    // Release notifies open clients that the tree moved.
    expect(sendWorkbookEvent).toHaveBeenCalledTimes(1);
    expect(sendWorkbookEvent).toHaveBeenCalledWith(workbookId, expect.objectContaining({ type: 'workbook-updated' }));

    // Release never resurrects cancelled work.
    expect(await publishJobStatusForConnection(connectionUnderMigrationId)).toBe('canceled');
    const planAfterRelease = await prisma.publishPlan.findUniqueOrThrow({
      where: { id: 'plan-nonterminal-migrating' },
    });
    expect(planAfterRelease.status).toBe(PublishPlanStatus.Canceled);
  });

  it('fails the drain with ConnectionDrainTimeoutError while still holding the lock when a worker never stops', async () => {
    // The worker for this connection keeps running past cancellation — its job
    // stays in the BullMQ `active` set, so the drain can never confirm a clean stop.
    jest
      .spyOn(jobService, 'getActiveBullJobDatas')
      .mockResolvedValue([publishJobDataForConnection(connectionUnderMigrationId)]);

    await expect(
      quiesceService.quiesceConnection(workbookId, connectionUnderMigrationId, {
        drainTimeoutMs: 40,
        drainPollIntervalMs: 5,
      }),
    ).rejects.toBeInstanceOf(ConnectionDrainTimeoutError);

    // Lock is STILL held — the migration's contract is to release-and-skip a busy
    // connection in its `finally`, not to leak an unreleased lock or migrate unsafely.
    expect(await migrationLockService.isConnectionMigrating(connectionUnderMigrationId)).toBe(true);

    // The migration releases on the way out (mirrors the controller's finally),
    // and the connection is usable again.
    await quiesceService.unquiesceConnection(workbookId, connectionUnderMigrationId);
    expect(await migrationLockService.isConnectionMigrating(connectionUnderMigrationId)).toBe(false);
  });
});
