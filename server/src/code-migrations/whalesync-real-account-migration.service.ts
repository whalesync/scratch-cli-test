import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  MigrationResult,
  MigrationResultSummaryRow,
  ScratchPlanType,
  WhalesyncSubscriptionMetadata,
  WhalesyncSubscriptionPayload,
  WhalesyncSubscriptionStatus,
  WorkbookId,
  WorkbookManager,
} from '@spinner/shared-types';
import { randomUUID } from 'crypto';
import { AuditLogService } from 'src/audit/audit-log.service';
import { DbService } from 'src/db/db.service';
import { WhalesyncInternalService } from 'src/internal/whalesync-internal.service';
import { WSLogger } from 'src/logger';
import { getPlanTypeFromString } from 'src/payment/plans';
import { StripePaymentService } from 'src/payment/stripe-payment.service';
import { ScheduleService } from 'src/schedule/schedule.service';
import { ScratchGitNotFoundError } from 'src/scratch-git/scratch-git.client';
import { ScratchGitService } from 'src/scratch-git/scratch-git.service';
import {
  isPureWhalesyncShadowUser,
  pureShadowUserClerkIdForWhalesyncTeam,
  SYSTEM_ACTOR,
  WHALESYNC_SHADOW_USER_CLERK_ID_PREFIX,
} from 'src/users/types';
import { UsersService } from 'src/users/users.service';
import { ConnectionQuiesceService } from './connection-quiesce.service';
import {
  formatRealScratchAccountMigrationReport,
  LiveExportWorkbookState,
  migrateRealScratchAccountOffWhalesyncTeam,
  RealScratchAccountMigrationDeps,
  RealScratchAccountMigrationFailed,
  RealScratchAccountMigrationReport,
  RealScratchAccountState,
  RepoMoveOutcome,
  WHALESYNC_TEAMS_OFF_REAL_ACCOUNTS_MIGRATION_NAME,
  WhalesyncPlanCopyOutcome,
} from './whalesync-real-account-migration';

const LOG_SOURCE = 'WhalesyncRealAccountMigrationService';

/** The `reason` on scratch-git's 404 when a move finds the repo at neither id (`MOVE_FOUND_NEITHER_REPO_REASON`). */
export const SCRATCH_GIT_MOVE_FOUND_NEITHER_REPO_REASON = 'neither_repo_exists';

const ROUTINE_RUN_STATUSES_IN_PROGRESS = ['pending', 'running'];
const JOB_STATUSES_NOT_TERMINAL = ['created', 'active'];
const WHALESYNC_SUBSCRIPTION_STATUSES: readonly WhalesyncSubscriptionStatus[] = [
  'none',
  'active',
  'cancelled',
  'expired',
];

/**
 * The real Scratch accounts linked to Whalesync: a Whalesync team or user id set, and not a pure shadow user (no
 * synthetic `ws_` clerkId). The same test as `isPureWhalesyncShadowUser`, which counts a user with no clerkId as real.
 */
const REAL_SCRATCH_ACCOUNTS_LINKED_TO_WHALESYNC: Prisma.UserWhereInput = {
  AND: [
    { OR: [{ whalesyncTeamId: { not: null } }, { whalesyncUserId: { not: null } }] },
    // Spelled out for a null clerkId, which a bare NOT would drop (NOT NULL is NULL in SQL).
    { OR: [{ clerkId: null }, { NOT: { clerkId: { startsWith: WHALESYNC_SHADOW_USER_CLERK_ID_PREFIX } } }] },
  ],
};

/**
 * The Whalesync payload that reproduces a `WHALESYNC_PLAN` subscription row on another organization: its recorded
 * Whalesync status (falling back to its Stripe-style status), its metadata, and its expiration.
 */
export function whalesyncSubscriptionPayloadFromWhalesyncPlanRow(whalesyncPlanRow: {
  stripeStatus: string | null;
  metadata: Prisma.JsonValue;
  expiration: Date;
}): WhalesyncSubscriptionPayload {
  const metadata = (
    whalesyncPlanRow.metadata &&
    typeof whalesyncPlanRow.metadata === 'object' &&
    !Array.isArray(whalesyncPlanRow.metadata)
      ? whalesyncPlanRow.metadata
      : {}
  ) as WhalesyncSubscriptionMetadata;
  const recordedWhalesyncStatus = WHALESYNC_SUBSCRIPTION_STATUSES.find((status) => status === metadata.whalesyncStatus);
  const status: WhalesyncSubscriptionStatus =
    recordedWhalesyncStatus ?? (whalesyncPlanRow.stripeStatus === 'active' ? 'active' : 'expired');
  return {
    status,
    whalesyncProductType: metadata.whalesyncProductType,
    liveExportRecordCountLimit: metadata.liveExportRecordCountLimit,
    liveExportCadence: metadata.liveExportCadence,
    expiresAt: whalesyncPlanRow.expiration.toISOString(),
  };
}

/**
 * One repo move through scratch-git. Only scratch-git's own answer that the repo is at neither id means there is
 * nothing to move (a workbook from before its scratch repo existed, say). Any other 404, like a scratch-git that
 * predates the move route, is thrown: counting it as "no repo" would point the rows at repos that never moved.
 */
export async function moveRepoOnScratchGit(
  scratchGitService: Pick<ScratchGitService, 'moveRepo'>,
  fromRepoId: string,
  toRepoId: string,
): Promise<RepoMoveOutcome> {
  try {
    const { moved } = await scratchGitService.moveRepo(fromRepoId, toRepoId);
    return moved ? 'moved' : 'already_moved';
  } catch (error) {
    if (
      error instanceof ScratchGitNotFoundError &&
      error.responseBody.includes(SCRATCH_GIT_MOVE_FOUND_NEITHER_REPO_REASON)
    ) {
      return 'no_repo';
    }
    throw error;
  }
}

/**
 * Runs the DEV-13019 migration that takes every Whalesync team off a real Scratch account (see
 * `whalesync-real-account-migration.ts` for the decisions and the order of steps). This class is the
 * {@link RealScratchAccountMigrationDeps} against Postgres, scratch-git, and the existing services, plus the loop
 * over accounts.
 */
@Injectable()
export class WhalesyncRealAccountMigrationService {
  constructor(
    private readonly db: DbService,
    private readonly usersService: UsersService,
    private readonly whalesyncInternalService: WhalesyncInternalService,
    private readonly stripePaymentService: StripePaymentService,
    private readonly scratchGitService: ScratchGitService,
    private readonly connectionQuiesceService: ConnectionQuiesceService,
    private readonly scheduleService: ScheduleService,
    private readonly auditLogService: AuditLogService,
  ) {}

  /**
   * Re-derives the candidates from the data, then migrates them one account at a time: one account's failure is
   * reported and the rest go on. `realUserIds` limits the run to those accounts (each still has to be a candidate);
   * otherwise up to `maximumAccountCount` candidates are taken in id order.
   */
  async run(options: {
    dryRun: boolean;
    realUserIds?: string[];
    maximumAccountCount?: number;
  }): Promise<MigrationResult> {
    const candidateRealUserIds = (
      await this.db.client.user.findMany({
        where: {
          ...REAL_SCRATCH_ACCOUNTS_LINKED_TO_WHALESYNC,
          ...(options.realUserIds ? { id: { in: options.realUserIds } } : {}),
        },
        select: { id: true },
        orderBy: { id: 'asc' },
        ...(options.realUserIds ? {} : { take: options.maximumAccountCount }),
      })
    ).map((user) => user.id);

    // Fail fast at the boundary: a scratch-git deployed before the move route would stop every move partway.
    const scratchGitSupportsRepoMoves = await this.scratchGitSupportsRepoMoves();
    if (!scratchGitSupportsRepoMoves && !options.dryRun) {
      throw new ServiceUnavailableException(
        'scratch-git does not support repo moves (POST /api/repo/manage/move) yet: deploy scratch-git, then run again.',
      );
    }

    const deps = this.buildDeps();
    const reports: RealScratchAccountMigrationReport[] = [];
    for (const realUserId of candidateRealUserIds) {
      try {
        reports.push(await migrateRealScratchAccountOffWhalesyncTeam(realUserId, deps, { dryRun: options.dryRun }));
      } catch (error) {
        WSLogger.error({
          source: LOG_SOURCE,
          message: `Failed to take the Whalesync team off real Scratch account ${realUserId}`,
          realUserId,
          error: error instanceof RealScratchAccountMigrationFailed ? error.cause : error,
        });
        const partialReport: RealScratchAccountMigrationReport =
          error instanceof RealScratchAccountMigrationFailed
            ? error.partialReport
            : {
                realUserId,
                whalesyncTeamId: null,
                whalesyncUserId: null,
                outcome: 'errored',
                skipReasons: [],
                whalesyncPlanStatusOfOrganization: null,
                liveExports: [],
                releasedLeftoverPausedLiveExportIds: [],
                liveExportIdsLeftPausedForNextRun: [],
              };
        reports.push({
          ...partialReport,
          outcome: 'errored',
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    for (const report of reports) {
      WSLogger.info({
        source: LOG_SOURCE,
        message: `${WHALESYNC_TEAMS_OFF_REAL_ACCOUNTS_MIGRATION_NAME}: ${report.realUserId} ${report.outcome}`,
        dryRun: options.dryRun,
        report,
      });
    }

    const remainingCount = await this.db.client.user.count({ where: REAL_SCRATCH_ACCOUNTS_LINKED_TO_WHALESYNC });
    return {
      migrationName: WHALESYNC_TEAMS_OFF_REAL_ACCOUNTS_MIGRATION_NAME,
      dryRun: options.dryRun,
      migratedIds: reports
        .filter((report) => ['unlinked', 'moved', 'would_unlink', 'would_move'].includes(report.outcome))
        .map((report) => report.realUserId),
      remainingCount,
      summary: summarizeReports(reports),
      report: [
        `scratch-git repo moves: ${scratchGitSupportsRepoMoves ? 'supported' : 'NOT SUPPORTED (deploy scratch-git before a real run)'}`,
        ...reports.flatMap(formatRealScratchAccountMigrationReport),
      ],
    };
  }

  /** Asks scratch-git to move a repo that exists nowhere: one that has the move route says exactly that. */
  private async scratchGitSupportsRepoMoves(): Promise<boolean> {
    const probeRepoId = `migration-preflight/${randomUUID()}/probe`;
    try {
      return (await moveRepoOnScratchGit(this.scratchGitService, probeRepoId, `${probeRepoId}-moved`)) === 'no_repo';
    } catch (error) {
      WSLogger.warn({ source: LOG_SOURCE, message: 'scratch-git repo move preflight failed', error });
      return false;
    }
  }

  private buildDeps(): RealScratchAccountMigrationDeps {
    return {
      loadRealScratchAccountState: (realUserId) => this.loadRealScratchAccountState(realUserId),
      createShadowUserAwaitingTeam: async (whalesyncTeamId) => {
        const shadowUser = await this.usersService.createPureShadowUserAwaitingWhalesyncTeam(whalesyncTeamId);
        if (!shadowUser.organizationId) {
          throw new Error(`New shadow user ${shadowUser.id} for team ${whalesyncTeamId} has no organization`);
        }
        return { userId: shadowUser.id, organizationId: shadowUser.organizationId };
      },
      copyWhalesyncPlanToShadowUser: (realUserId, shadowUserId) =>
        this.copyWhalesyncPlanToShadowUser(realUserId, shadowUserId),
      pauseLiveExport: async (workbookId, connectorAccountIds) => {
        await this.scheduleService.disableSchedulesForWorkbookMigration(workbookId as WorkbookId);
        for (const connectorAccountId of connectorAccountIds) {
          await this.connectionQuiesceService.quiesceConnection(workbookId, connectorAccountId);
        }
      },
      releaseLiveExport: async (workbookId, connectorAccountIds) => {
        for (const connectorAccountId of connectorAccountIds) {
          await this.connectionQuiesceService.unquiesceConnection(workbookId, connectorAccountId);
        }
        await this.scheduleService.restoreSchedulesForWorkbookMigration(workbookId as WorkbookId);
      },
      countActiveRoutineRuns: (workbookId) =>
        this.db.client.routineRun.count({ where: { workbookId, status: { in: ROUTINE_RUN_STATUSES_IN_PROGRESS } } }),
      moveRepo: (fromRepoId, toRepoId) => moveRepoOnScratchGit(this.scratchGitService, fromRepoId, toRepoId),
      moveLiveExportRows: (move) => this.moveLiveExportRows(move),
      unlinkRealScratchAccount: async (realUserId, handOverWhalesyncIdentityToUserId) => {
        const realScratchUser = await this.usersService.findOne(realUserId);
        if (!realScratchUser) {
          throw new Error(`Real Scratch account ${realUserId} not found`);
        }
        const handOverWhalesyncIdentityTo = handOverWhalesyncIdentityToUserId
          ? await this.usersService.findOne(handOverWhalesyncIdentityToUserId)
          : undefined;
        if (handOverWhalesyncIdentityToUserId && !handOverWhalesyncIdentityTo) {
          throw new Error(`Shadow user ${handOverWhalesyncIdentityToUserId} not found`);
        }
        await this.whalesyncInternalService.unlinkRealScratchUserFromWhalesyncIdentity(
          realScratchUser,
          {
            whalesyncTeamId: realScratchUser.whalesyncTeamId ?? undefined,
            whalesyncUserId: realScratchUser.whalesyncUserId ?? undefined,
          },
          { handOverWhalesyncIdentityTo: handOverWhalesyncIdentityTo ?? undefined },
        );
      },
      logAudit: async (entry) => {
        // A side log written after the move landed: a failure here must not mark a finished move as failed.
        try {
          await this.auditLogService.logEvent({
            actor: SYSTEM_ACTOR,
            eventType: 'update',
            message: entry.message,
            entityId: entry.entityId as WorkbookId,
            organizationId: entry.organizationId,
          });
        } catch (error) {
          WSLogger.warn({ source: LOG_SOURCE, message: 'Audit log write failed', entityId: entry.entityId, error });
        }
      },
    };
  }

  private async loadRealScratchAccountState(realUserId: string): Promise<RealScratchAccountState | null> {
    const realScratchUser = await this.db.client.user.findUnique({
      where: { id: realUserId },
      select: { id: true, clerkId: true, whalesyncTeamId: true, whalesyncUserId: true, organizationId: true },
    });
    if (
      !realScratchUser ||
      (!realScratchUser.whalesyncTeamId && !realScratchUser.whalesyncUserId) ||
      isPureWhalesyncShadowUser(realScratchUser)
    ) {
      return null;
    }
    const organizationId = realScratchUser.organizationId;

    const shadowUserWithTeamClerkId = realScratchUser.whalesyncTeamId
      ? await this.db.client.user.findUnique({
          where: { clerkId: pureShadowUserClerkIdForWhalesyncTeam(realScratchUser.whalesyncTeamId) },
          select: { id: true, organizationId: true, whalesyncTeamId: true, whalesyncUserId: true, email: true },
        })
      : null;

    const whalesyncPlanOfOrganization = organizationId
      ? await this.db.client.subscription.findFirst({
          where: { organizationId, planType: ScratchPlanType.WHALESYNC_PLAN },
          select: { stripeStatus: true },
        })
      : null;

    const liveExportsOnShadowUser = shadowUserWithTeamClerkId
      ? await this.loadLiveExportWorkbookStates({ userId: shadowUserWithTeamClerkId.id })
      : [];

    return {
      userId: realScratchUser.id,
      whalesyncTeamId: realScratchUser.whalesyncTeamId,
      whalesyncUserId: realScratchUser.whalesyncUserId,
      organizationId,
      organizationMemberCount: organizationId ? await this.db.client.user.count({ where: { organizationId } }) : 0,
      liveExportsCreatedByAccount: await this.loadLiveExportWorkbookStates({ userId: realUserId }),
      liveExportIdsInOrganizationCreatedByOthers: organizationId
        ? (
            await this.db.client.workbook.findMany({
              where: {
                organizationId,
                managedBy: WorkbookManager.WS_EXPORT,
                OR: [{ userId: null }, { userId: { not: realUserId } }],
              },
              select: { id: true },
            })
          ).map((workbook) => workbook.id)
        : [],
      shadowUserWithTeamClerkId: shadowUserWithTeamClerkId
        ? {
            userId: shadowUserWithTeamClerkId.id,
            organizationId: shadowUserWithTeamClerkId.organizationId,
            organizationMemberCount: shadowUserWithTeamClerkId.organizationId
              ? await this.db.client.user.count({
                  where: { organizationId: shadowUserWithTeamClerkId.organizationId },
                })
              : 0,
            whalesyncTeamId: shadowUserWithTeamClerkId.whalesyncTeamId,
            whalesyncUserId: shadowUserWithTeamClerkId.whalesyncUserId,
            email: shadowUserWithTeamClerkId.email,
          }
        : null,
      liveExportsOnShadowUserLeftPaused: liveExportsOnShadowUser.filter(
        (liveExport) =>
          liveExport.migrationLockedConnectionCount > 0 || liveExport.schedulesDisabledForMigrationCount > 0,
      ),
      whalesyncPlanStatusOfOrganization: whalesyncPlanOfOrganization
        ? (whalesyncPlanOfOrganization.stripeStatus ?? 'unknown')
        : null,
    };
  }

  private async loadLiveExportWorkbookStates(where: { userId: string }): Promise<LiveExportWorkbookState[]> {
    const liveExportWorkbooks = await this.db.client.workbook.findMany({
      where: { userId: where.userId, managedBy: WorkbookManager.WS_EXPORT },
      select: {
        id: true,
        name: true,
        organizationId: true,
        userId: true,
        isPendingDelete: true,
        connectorAccounts: { select: { id: true, repoPath: true, migrationLockedAt: true }, orderBy: { id: 'asc' } },
        schedules: { select: { disabledForMigrationAt: true } },
        workspacePermissions: { select: { userId: true } },
      },
      orderBy: { id: 'asc' },
    });
    const liveExportStates: LiveExportWorkbookState[] = [];
    for (const workbook of liveExportWorkbooks) {
      liveExportStates.push({
        workbookId: workbook.id,
        name: workbook.name,
        organizationId: workbook.organizationId,
        userId: workbook.userId,
        isPendingDelete: workbook.isPendingDelete,
        connections: workbook.connectorAccounts.map((connectorAccount) => ({
          connectorAccountId: connectorAccount.id,
          repoPath: connectorAccount.repoPath,
        })),
        scheduleCount: workbook.schedules.length,
        workspacePermissionUserIdsOtherThanCreator: workbook.workspacePermissions
          .map((permission) => permission.userId)
          .filter((permissionUserId) => permissionUserId !== workbook.userId),
        activeRoutineRunCount: await this.db.client.routineRun.count({
          where: { workbookId: workbook.id, status: { in: ROUTINE_RUN_STATUSES_IN_PROGRESS } },
        }),
        nonTerminalJobCount: await this.db.client.dbJob.count({
          where: { workbookId: workbook.id, status: { in: JOB_STATUSES_NOT_TERMINAL } },
        }),
        migrationLockedConnectionCount: workbook.connectorAccounts.filter(
          (connectorAccount) => connectorAccount.migrationLockedAt !== null,
        ).length,
        schedulesDisabledForMigrationCount: workbook.schedules.filter(
          (schedule) => schedule.disabledForMigrationAt !== null,
        ).length,
      });
    }
    return liveExportStates;
  }

  private async copyWhalesyncPlanToShadowUser(
    realUserId: string,
    shadowUserId: string,
  ): Promise<WhalesyncPlanCopyOutcome> {
    const [realScratchUser, shadowUser] = await Promise.all([
      this.usersService.findOne(realUserId),
      this.usersService.findOne(shadowUserId),
    ]);
    if (!realScratchUser || !shadowUser) {
      throw new Error(`Cannot copy the Whalesync plan from ${realUserId} to ${shadowUserId}: a user is missing`);
    }
    const isWhalesyncPlanRow = (subscription: { planType: string }): boolean =>
      getPlanTypeFromString(subscription.planType) === ScratchPlanType.WHALESYNC_PLAN;
    if ((shadowUser.organization?.subscriptions ?? []).some(isWhalesyncPlanRow)) {
      return 'already_present';
    }
    const whalesyncPlanRowOfRealAccount = (realScratchUser.organization?.subscriptions ?? []).find(isWhalesyncPlanRow);
    if (!whalesyncPlanRowOfRealAccount) {
      return 'nothing_to_copy';
    }
    const { updated } = await this.stripePaymentService.applyWhalesyncSubscriptionState(
      shadowUser,
      whalesyncSubscriptionPayloadFromWhalesyncPlanRow(whalesyncPlanRowOfRealAccount),
      { throwOnRealSubscriptionConflict: true },
    );
    // A lapsed plan is never created on an organization that has none, which grants the same as copying it.
    return updated ? 'copied' : 'inactive_not_copied';
  }

  private async moveLiveExportRows(move: {
    workbookId: string;
    fromUserId: string;
    fromOrganizationId: string;
    toUserId: string;
    toOrganizationId: string;
    connectorAccountIdToNewRepoPath: Map<string, string>;
  }): Promise<void> {
    const { workbookId, fromUserId, fromOrganizationId, toUserId, toOrganizationId } = move;
    await this.db.client.$transaction(async (transaction) => {
      const { count: workbooksMoved } = await transaction.workbook.updateMany({
        where: { id: workbookId, userId: fromUserId, organizationId: fromOrganizationId },
        data: { userId: toUserId, organizationId: toOrganizationId },
      });
      if (workbooksMoved === 0) {
        // Already moved by an earlier run (this transaction is all-or-nothing), or no longer the account's.
        return;
      }
      const connectorAccountIdsAddedSinceTheRepoMoves = (
        await transaction.connectorAccount.findMany({ where: { workbookId }, select: { id: true } })
      )
        .map((connectorAccount) => connectorAccount.id)
        .filter((connectorAccountId) => !move.connectorAccountIdToNewRepoPath.has(connectorAccountId));
      if (connectorAccountIdsAddedSinceTheRepoMoves.length > 0) {
        // Its repo wasn't moved; rolling back keeps the workbook where its repos say. The next run moves it too.
        throw new Error(
          `Connection(s) ${connectorAccountIdsAddedSinceTheRepoMoves.join(', ')} were added to Live Export ${workbookId} during the migration`,
        );
      }
      for (const [connectorAccountId, newRepoPath] of move.connectorAccountIdToNewRepoPath) {
        await transaction.connectorAccount.update({
          where: { id: connectorAccountId },
          data: { repoPath: newRepoPath },
        });
      }
      await transaction.connectorAccount.updateMany({
        where: { workbookId, userId: fromUserId },
        data: { userId: toUserId },
      });
      await transaction.schedule.updateMany({ where: { workbookId }, data: { organizationId: toOrganizationId } });
      await transaction.schedule.updateMany({ where: { workbookId, userId: fromUserId }, data: { userId: toUserId } });
      await transaction.workspacePermission.updateMany({
        where: { workbookId, userId: fromUserId },
        data: { userId: toUserId },
      });
      await transaction.workspaceInvites.updateMany({
        where: { workbookId, userId: fromUserId },
        data: { userId: toUserId },
      });
      await transaction.publishPlan.updateMany({
        where: { workbookId, userId: fromUserId },
        data: { userId: toUserId },
      });
      await transaction.publishPlan.updateMany({
        where: { workbookId, authorId: fromUserId },
        data: { authorId: toUserId },
      });
      await transaction.dbJob.updateMany({ where: { workbookId, userId: fromUserId }, data: { userId: toUserId } });
      await transaction.routineRun.updateMany({
        where: { workbookId, triggeredByUserId: fromUserId },
        data: { triggeredByUserId: toUserId },
      });
      await transaction.routineDefinition.updateMany({
        where: { workbookId, updatedByUserId: fromUserId },
        data: { updatedByUserId: toUserId },
      });
      await transaction.user.updateMany({
        where: { id: fromUserId, lastWorkbookId: workbookId },
        data: { lastWorkbookId: null },
      });
    });
  }
}

function summarizeReports(reports: RealScratchAccountMigrationReport[]): MigrationResultSummaryRow[] {
  const countByLabel = new Map<string, number>();
  const add = (label: string, count: number): void => {
    countByLabel.set(label, (countByLabel.get(label) ?? 0) + count);
  };
  for (const report of reports) {
    add(`accounts ${report.outcome}`, 1);
    for (const skipReason of report.skipReasons) {
      add(`skipped: ${skipReason}`, 1);
    }
    if (report.outcome === 'moved' || report.outcome === 'would_move') {
      add('Live Exports moved', report.liveExports.length);
      add(
        'connections moved',
        report.liveExports.reduce((total, liveExport) => total + liveExport.connectionCount, 0),
      );
      add(
        'schedules moved',
        report.liveExports.reduce((total, liveExport) => total + liveExport.scheduleCount, 0),
      );
      add(
        'repos to move',
        report.liveExports.reduce((total, liveExport) => total + liveExport.repoMoves.length, 0),
      );
    }
  }
  return [...countByLabel].map(([label, count]) => ({ label, count }));
}
