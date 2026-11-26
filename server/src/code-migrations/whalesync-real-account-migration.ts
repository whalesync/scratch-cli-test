import { WorkbookId } from '@spinner/shared-types';
import { getDefaultRepoPath, getScratchRepoPath } from 'src/scratch-git/scratch-git.service';
import { getWorkbookRepoPath } from 'src/workbook/workbook-repo.service';

/**
 * DEV-13019: take every Whalesync team off a real Scratch account.
 *
 * A Whalesync team's Live Exports are held by one Scratch shadow user, found by the unique `User.whalesyncTeamId`.
 * For some teams that user is a real Scratch account (a person's own Scratch login, adopted into Whalesync by email
 * before teams), so a session for the team is a login to that person's account. This migration ends that, for every
 * such account it finds in the data (never by id):
 *
 * - **unlink**: an account that holds no Live Export is unlinked from Whalesync. The team's next session creates a
 *   pure shadow user.
 * - **move**: an account that holds Live Exports gets a new pure shadow user for its team, in an organization of its
 *   own; each Live Export moves to it (its repos, rows, and schedules); then the account is unlinked and, in the same
 *   transaction, the team's Whalesync ids move to the new shadow user.
 *
 * Everything here works from state read back from the data, so a run that stops at any step is finished by the next
 * run (see {@link migrateRealScratchAccountOffWhalesyncTeam}). This file holds the decisions and the order of steps;
 * the reads and writes are behind {@link RealScratchAccountMigrationDeps}.
 */
export const WHALESYNC_TEAMS_OFF_REAL_ACCOUNTS_MIGRATION_NAME = 'whalesync-teams-off-real-accounts';

/** Stands in for the new organization's id in a dry run, before the organization exists. */
export const NEW_ORGANIZATION_ID_PLACEHOLDER = '<new organization>';

export interface LiveExportConnectionState {
  connectorAccountId: string;
  repoPath: string | null;
}

export interface LiveExportWorkbookState {
  workbookId: string;
  name: string | null;
  organizationId: string;
  userId: string | null;
  isPendingDelete: boolean;
  connections: LiveExportConnectionState[];
  scheduleCount: number;
  /** Users other than the workbook's creator with a workspace permission on it. */
  workspacePermissionUserIdsOtherThanCreator: string[];
  activeRoutineRunCount: number;
  nonTerminalJobCount: number;
  /** A crash mid-move can leave these behind; a later run releases them. */
  migrationLockedConnectionCount: number;
  schedulesDisabledForMigrationCount: number;
}

/** The user with clerkId `ws_<whalesyncTeamId>`, if any: the shadow user a previous run created. */
export interface ShadowUserWithTeamClerkIdState {
  userId: string;
  organizationId: string | null;
  organizationMemberCount: number;
  whalesyncTeamId: string | null;
  whalesyncUserId: string | null;
  email: string | null;
}

export interface RealScratchAccountState {
  userId: string;
  whalesyncTeamId: string | null;
  whalesyncUserId: string | null;
  organizationId: string | null;
  organizationMemberCount: number;
  /** `ws_export` workbooks whose `userId` is this account, in any state. */
  liveExportsCreatedByAccount: LiveExportWorkbookState[];
  /** Ids of `ws_export` workbooks in the account's organization that someone else created. */
  liveExportIdsInOrganizationCreatedByOthers: string[];
  shadowUserWithTeamClerkId: ShadowUserWithTeamClerkIdState | null;
  /** The shadow user's Live Exports that a crashed run left paused (locked connections or disabled schedules). */
  liveExportsOnShadowUserLeftPaused: LiveExportWorkbookState[];
  /** Status of the organization's `WHALESYNC_PLAN` subscription, if it has one. */
  whalesyncPlanStatusOfOrganization: string | null;
}

export type RealScratchAccountSkipReason =
  | 'no_organization'
  | 'organization_has_other_members'
  | 'live_export_created_by_another_user'
  | 'live_export_in_another_organization'
  | 'live_export_pending_delete'
  | 'live_export_shared_with_another_user'
  | 'routine_run_in_progress'
  | 'job_in_progress'
  | 'no_whalesync_team_id'
  | 'team_already_has_a_pure_shadow_user'
  | 'connection_repo_path_unexpected'
  | 'connection_busy'
  | 'live_export_created_during_migration';

export type RealScratchAccountMigrationDecision =
  | { branch: 'unlink' }
  | { branch: 'move'; shadowUser: 'create' | 'reuse' }
  | { branch: 'skip'; skipReasons: RealScratchAccountSkipReason[] };

/** One repo a Live Export's move renames on scratch-git. */
export interface PlannedRepoMove {
  kind: 'connection' | 'workbook' | 'scratch';
  /** Set for a connection's repo. */
  connectorAccountId?: string;
  fromRepoId: string;
  toRepoId: string;
}

/**
 * The shadow user a previous run created and has not yet handed the team to: clerkId `ws_<whalesyncTeamId>`, pure,
 * no Whalesync ids, no email, alone in its organization. Any other user with that clerkId is somebody else's.
 */
export function isShadowUserAwaitingTeamFromPreviousRun(shadowUser: ShadowUserWithTeamClerkIdState): boolean {
  return (
    shadowUser.whalesyncTeamId === null &&
    shadowUser.whalesyncUserId === null &&
    shadowUser.email === null &&
    shadowUser.organizationId !== null &&
    shadowUser.organizationMemberCount === 1
  );
}

/** Every repo a Live Export holds, with the id it has in the account's organization and the id it moves to. */
export function planRepoMovesForLiveExport(
  liveExport: Pick<LiveExportWorkbookState, 'workbookId' | 'connections'>,
  fromOrganizationId: string,
  toOrganizationId: string,
): PlannedRepoMove[] {
  const workbookId = liveExport.workbookId as WorkbookId;
  return [
    ...liveExport.connections.map(
      (connection): PlannedRepoMove => ({
        kind: 'connection',
        connectorAccountId: connection.connectorAccountId,
        fromRepoId: getDefaultRepoPath(fromOrganizationId, workbookId, connection.connectorAccountId),
        toRepoId: getDefaultRepoPath(toOrganizationId, workbookId, connection.connectorAccountId),
      }),
    ),
    {
      kind: 'workbook',
      fromRepoId: getWorkbookRepoPath(fromOrganizationId, workbookId),
      toRepoId: getWorkbookRepoPath(toOrganizationId, workbookId),
    },
    {
      kind: 'scratch',
      fromRepoId: getScratchRepoPath(fromOrganizationId, workbookId),
      toRepoId: getScratchRepoPath(toOrganizationId, workbookId),
    },
  ];
}

/**
 * Which branch an account takes, or why it is skipped. Every check is a state the migration doesn't expect; it is
 * reported and left alone rather than forced. Skips for work in progress (a routine run or a job) clear on their own
 * and are picked up by a later run.
 */
export function decideRealScratchAccountMigration(
  account: RealScratchAccountState,
): RealScratchAccountMigrationDecision {
  const skipReasons = new Set<RealScratchAccountSkipReason>();
  if (!account.organizationId) {
    return { branch: 'skip', skipReasons: ['no_organization'] };
  }
  // Unlinking also removes the organization's Whalesync plan, which another member would lose too.
  if (account.organizationMemberCount > 1) {
    skipReasons.add('organization_has_other_members');
  }
  if (account.liveExportIdsInOrganizationCreatedByOthers.length > 0) {
    skipReasons.add('live_export_created_by_another_user');
  }

  const shadowUserFromPreviousRun =
    account.shadowUserWithTeamClerkId && isShadowUserAwaitingTeamFromPreviousRun(account.shadowUserWithTeamClerkId)
      ? account.shadowUserWithTeamClerkId
      : null;
  if (account.shadowUserWithTeamClerkId && !shadowUserFromPreviousRun) {
    skipReasons.add('team_already_has_a_pure_shadow_user');
  }

  // A shadow user from a previous run means Live Exports may already sit on it: finish the move, never just unlink.
  const accountNeedsMove = account.liveExportsCreatedByAccount.length > 0 || shadowUserFromPreviousRun !== null;
  if (accountNeedsMove && !account.whalesyncTeamId) {
    skipReasons.add('no_whalesync_team_id');
  }

  for (const liveExport of account.liveExportsCreatedByAccount) {
    if (liveExport.organizationId !== account.organizationId) {
      skipReasons.add('live_export_in_another_organization');
    }
    if (liveExport.isPendingDelete) {
      skipReasons.add('live_export_pending_delete');
    }
    if (liveExport.workspacePermissionUserIdsOtherThanCreator.length > 0) {
      skipReasons.add('live_export_shared_with_another_user');
    }
    if (liveExport.activeRoutineRunCount > 0) {
      skipReasons.add('routine_run_in_progress');
    }
    if (liveExport.nonTerminalJobCount > 0) {
      skipReasons.add('job_in_progress');
    }
    const repoIdsTheConnectionsMayHave = new Set<string>(
      [account.organizationId, shadowUserFromPreviousRun?.organizationId].flatMap((organizationId) =>
        organizationId
          ? liveExport.connections.map((connection) =>
              getDefaultRepoPath(organizationId, liveExport.workbookId as WorkbookId, connection.connectorAccountId),
            )
          : [],
      ),
    );
    if (
      liveExport.connections.some(
        (connection) => connection.repoPath === null || !repoIdsTheConnectionsMayHave.has(connection.repoPath),
      )
    ) {
      skipReasons.add('connection_repo_path_unexpected');
    }
  }

  if (skipReasons.size > 0) {
    return { branch: 'skip', skipReasons: [...skipReasons] };
  }
  if (!accountNeedsMove) {
    return { branch: 'unlink' };
  }
  return { branch: 'move', shadowUser: shadowUserFromPreviousRun ? 'reuse' : 'create' };
}

export type WhalesyncPlanCopyOutcome = 'copied' | 'already_present' | 'nothing_to_copy' | 'inactive_not_copied';
export type RepoMoveOutcome = 'moved' | 'already_moved' | 'no_repo';

export interface RealScratchAccountMigrationDeps {
  /** The account as it stands now, or null when it is no longer a real Scratch account linked to Whalesync. */
  loadRealScratchAccountState(realUserId: string): Promise<RealScratchAccountState | null>;
  /** A pure shadow user with clerkId `ws_<whalesyncTeamId>`, no Whalesync ids, and an organization of its own. */
  createShadowUserAwaitingTeam(whalesyncTeamId: string): Promise<{ userId: string; organizationId: string }>;
  /** Gives the shadow user's organization the Whalesync plan the account's organization has. Idempotent. */
  copyWhalesyncPlanToShadowUser(realUserId: string, shadowUserId: string): Promise<WhalesyncPlanCopyOutcome>;
  /**
   * Quiesces each connection and disables every schedule in the workbook, both behind crash-safe markers. Throws
   * `ConnectionDrainTimeoutError` when a connection's jobs don't stop in time.
   */
  pauseLiveExport(workbookId: string, connectorAccountIds: string[]): Promise<void>;
  /** Undoes {@link pauseLiveExport} from its markers. Safe to call repeatedly, or for a workbook never paused. */
  releaseLiveExport(workbookId: string, connectorAccountIds: string[]): Promise<void>;
  countActiveRoutineRuns(workbookId: string): Promise<number>;
  /** scratch-git's move: refuses an existing destination, and treats a move already made as done. */
  moveRepo(fromRepoId: string, toRepoId: string): Promise<RepoMoveOutcome>;
  /**
   * In one transaction: the workbook to the new organization and shadow user; each connection's `repoPath` and
   * creator; its schedules' organization and creator; the account's workspace permission, and the rows that name it
   * (publish plans, jobs, routine runs), to the shadow user; and the account's last-workbook pointer cleared if it
   * pointed here. Guarded on the workbook still being the account's, so a repeat changes nothing.
   */
  moveLiveExportRows(move: {
    workbookId: string;
    fromUserId: string;
    fromOrganizationId: string;
    toUserId: string;
    toOrganizationId: string;
    connectorAccountIdToNewRepoPath: Map<string, string>;
  }): Promise<void>;
  /**
   * `WhalesyncInternalService.unlinkRealScratchUserFromWhalesyncIdentity` in migration mode: refuses while the
   * account still created a Live Export, and, given a shadow user, hands it the account's Whalesync ids in the
   * unlink's transaction.
   */
  unlinkRealScratchAccount(realUserId: string, handOverWhalesyncIdentityToUserId?: string): Promise<void>;
  logAudit(entry: { organizationId: string; entityId: string; message: string }): Promise<void>;
}

export interface LiveExportMoveReport {
  workbookId: string;
  name: string | null;
  connectionCount: number;
  scheduleCount: number;
  repoMoves: (PlannedRepoMove & { outcome?: RepoMoveOutcome })[];
}

export type RealScratchAccountMigrationOutcome =
  | 'not_a_candidate'
  | 'skipped'
  | 'would_unlink'
  | 'would_move'
  | 'unlinked'
  | 'moved'
  | 'errored';

export interface RealScratchAccountMigrationReport {
  realUserId: string;
  whalesyncTeamId: string | null;
  whalesyncUserId: string | null;
  outcome: RealScratchAccountMigrationOutcome;
  skipReasons: RealScratchAccountSkipReason[];
  shadowUser?: { userId: string; organizationId: string; createdThisRun: boolean };
  whalesyncPlanStatusOfOrganization: string | null;
  whalesyncPlanCopy?: WhalesyncPlanCopyOutcome;
  liveExports: LiveExportMoveReport[];
  releasedLeftoverPausedLiveExportIds: string[];
  /** Live Exports a failure stopped mid-move, left paused; the next run finishes and releases them. */
  liveExportIdsLeftPausedForNextRun: string[];
  error?: string;
}

/** Thrown inside a move to stop it for a state that clears on its own; the account is reported as skipped. */
class RealScratchAccountSkippedDuringMigration extends Error {
  constructor(readonly skipReason: RealScratchAccountSkipReason) {
    super(`Skipped: ${skipReason}`);
  }
}

/** A move that failed partway, carrying what it had done so far, so the run's report can say so. */
export class RealScratchAccountMigrationFailed extends Error {
  constructor(
    readonly partialReport: RealScratchAccountMigrationReport,
    readonly cause: unknown,
  ) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = 'RealScratchAccountMigrationFailed';
  }
}

function isConnectionDrainTimeout(error: unknown): boolean {
  return error instanceof Error && error.name === 'ConnectionDrainTimeoutError';
}

/**
 * Migrates one account, in an order that can't lose data and that a re-run finishes from wherever a previous run
 * stopped:
 *
 * 1. Find or create the team's new pure shadow user (`ws_<whalesyncTeamId>`; a previous run's is reused).
 * 2. Copy the organization's Whalesync plan to the shadow user's organization (skipped when it already has one).
 * 3. Release anything a crashed run left paused on the shadow user's Live Exports.
 * 4. For each Live Export still on the account: pause it, re-check for a routine run, move its repos (each move is
 *    idempotent), move its rows in one guarded transaction, and release it (in `finally`).
 * 5. Re-read the account. If it still created any Live Export (one made by a session during the run), stop: the
 *    next run moves it.
 * 6. Unlink the account, handing its Whalesync ids to the shadow user in the same transaction. The unlink refuses,
 *    again inside its transaction, if a Live Export is still on the account.
 *
 * The account stays a candidate (linked to Whalesync) until step 6 commits, so any failure before it is retried by
 * the next run; after it, there is nothing left to do. With `dryRun` it only reports what it would do.
 */
export async function migrateRealScratchAccountOffWhalesyncTeam(
  realUserId: string,
  deps: RealScratchAccountMigrationDeps,
  options: { dryRun: boolean },
): Promise<RealScratchAccountMigrationReport> {
  const account = await deps.loadRealScratchAccountState(realUserId);
  if (!account) {
    return {
      realUserId,
      whalesyncTeamId: null,
      whalesyncUserId: null,
      outcome: 'not_a_candidate',
      skipReasons: [],
      whalesyncPlanStatusOfOrganization: null,
      liveExports: [],
      releasedLeftoverPausedLiveExportIds: [],
      liveExportIdsLeftPausedForNextRun: [],
    };
  }

  const decision = decideRealScratchAccountMigration(account);
  const shadowUserFromPreviousRun =
    decision.branch === 'move' && decision.shadowUser === 'reuse' ? account.shadowUserWithTeamClerkId : null;
  const plannedOrganizationIdOfShadowUser =
    shadowUserFromPreviousRun?.organizationId ?? NEW_ORGANIZATION_ID_PLACEHOLDER;
  const report: RealScratchAccountMigrationReport = {
    realUserId,
    whalesyncTeamId: account.whalesyncTeamId,
    whalesyncUserId: account.whalesyncUserId,
    outcome: 'skipped',
    skipReasons: decision.branch === 'skip' ? decision.skipReasons : [],
    whalesyncPlanStatusOfOrganization: account.whalesyncPlanStatusOfOrganization,
    liveExports: account.liveExportsCreatedByAccount.map((liveExport) => ({
      workbookId: liveExport.workbookId,
      name: liveExport.name,
      connectionCount: liveExport.connections.length,
      scheduleCount: liveExport.scheduleCount,
      repoMoves: account.organizationId
        ? planRepoMovesForLiveExport(liveExport, account.organizationId, plannedOrganizationIdOfShadowUser)
        : [],
    })),
    releasedLeftoverPausedLiveExportIds: [],
    liveExportIdsLeftPausedForNextRun: [],
  };
  if (shadowUserFromPreviousRun?.organizationId) {
    report.shadowUser = {
      userId: shadowUserFromPreviousRun.userId,
      organizationId: shadowUserFromPreviousRun.organizationId,
      createdThisRun: false,
    };
  }

  if (decision.branch === 'skip') {
    return report;
  }
  if (options.dryRun) {
    report.outcome = decision.branch === 'unlink' ? 'would_unlink' : 'would_move';
    return report;
  }
  if (decision.branch === 'unlink') {
    await deps.unlinkRealScratchAccount(realUserId);
    report.outcome = 'unlinked';
    return report;
  }

  // decideRealScratchAccountMigration only moves an account that has an organization and a team id.
  const fromOrganizationId = account.organizationId as string;
  const whalesyncTeamId = account.whalesyncTeamId as string;

  try {
    const shadowUser = shadowUserFromPreviousRun?.organizationId
      ? { userId: shadowUserFromPreviousRun.userId, organizationId: shadowUserFromPreviousRun.organizationId }
      : await deps.createShadowUserAwaitingTeam(whalesyncTeamId);
    report.shadowUser = { ...shadowUser, createdThisRun: !shadowUserFromPreviousRun };

    report.whalesyncPlanCopy = await deps.copyWhalesyncPlanToShadowUser(realUserId, shadowUser.userId);

    for (const leftoverPausedLiveExport of account.liveExportsOnShadowUserLeftPaused) {
      await deps.releaseLiveExport(
        leftoverPausedLiveExport.workbookId,
        leftoverPausedLiveExport.connections.map((connection) => connection.connectorAccountId),
      );
      report.releasedLeftoverPausedLiveExportIds.push(leftoverPausedLiveExport.workbookId);
    }

    for (const [liveExportIndex, liveExport] of account.liveExportsCreatedByAccount.entries()) {
      const liveExportReport = report.liveExports[liveExportIndex];
      liveExportReport.repoMoves = planRepoMovesForLiveExport(
        liveExport,
        fromOrganizationId,
        shadowUser.organizationId,
      );
      const connectorAccountIds = liveExport.connections.map((connection) => connection.connectorAccountId);
      // Between the first repo move and the row move, the repos and the rows disagree about the organization.
      // Released then, the Live Export could run against repos that aren't where its rows say (and a write could
      // create an empty repo at the old id, which the next move would then refuse to overwrite). So a failure in
      // that window leaves it paused, behind its markers, for the next run to finish and release.
      let repoAndRowLocationsMayDisagree = false;
      try {
        await deps.pauseLiveExport(liveExport.workbookId, connectorAccountIds);
        // A run that started after the account was read would be writing to the repos about to move.
        if ((await deps.countActiveRoutineRuns(liveExport.workbookId)) > 0) {
          throw new RealScratchAccountSkippedDuringMigration('routine_run_in_progress');
        }
        repoAndRowLocationsMayDisagree = true;
        for (const repoMove of liveExportReport.repoMoves) {
          repoMove.outcome = await deps.moveRepo(repoMove.fromRepoId, repoMove.toRepoId);
        }
        await deps.moveLiveExportRows({
          workbookId: liveExport.workbookId,
          fromUserId: realUserId,
          fromOrganizationId,
          toUserId: shadowUser.userId,
          toOrganizationId: shadowUser.organizationId,
          connectorAccountIdToNewRepoPath: new Map(
            liveExportReport.repoMoves.flatMap((repoMove) =>
              repoMove.connectorAccountId ? [[repoMove.connectorAccountId, repoMove.toRepoId]] : [],
            ),
          ),
        });
        repoAndRowLocationsMayDisagree = false;
      } catch (error) {
        if (repoAndRowLocationsMayDisagree) {
          report.liveExportIdsLeftPausedForNextRun.push(liveExport.workbookId);
        }
        throw error;
      } finally {
        if (!repoAndRowLocationsMayDisagree) {
          await deps.releaseLiveExport(liveExport.workbookId, connectorAccountIds);
        }
      }
      await deps.logAudit({
        organizationId: fromOrganizationId,
        entityId: liveExport.workbookId,
        message: `Live Export moved to its Whalesync team's own Scratch account (${shadowUser.userId})`,
      });
      await deps.logAudit({
        organizationId: shadowUser.organizationId,
        entityId: liveExport.workbookId,
        message: `Live Export moved here from Scratch account ${realUserId}, which held it for its Whalesync team`,
      });
    }

    const accountAfterMoves = await deps.loadRealScratchAccountState(realUserId);
    if (accountAfterMoves && accountAfterMoves.liveExportsCreatedByAccount.length > 0) {
      throw new RealScratchAccountSkippedDuringMigration('live_export_created_during_migration');
    }
    await deps.unlinkRealScratchAccount(realUserId, shadowUser.userId);
    report.outcome = 'moved';
    return report;
  } catch (error) {
    if (error instanceof RealScratchAccountSkippedDuringMigration) {
      report.outcome = 'skipped';
      report.skipReasons = [error.skipReason];
      return report;
    }
    if (isConnectionDrainTimeout(error)) {
      report.outcome = 'skipped';
      report.skipReasons = ['connection_busy'];
      return report;
    }
    throw new RealScratchAccountMigrationFailed(report, error);
  }
}

/** One readable block per account, for the migration's report in the admin UI. */
export function formatRealScratchAccountMigrationReport(report: RealScratchAccountMigrationReport): string[] {
  const lines = [
    `${report.realUserId}: ${report.outcome}` +
      (report.skipReasons.length > 0 ? ` (${report.skipReasons.join(', ')})` : '') +
      ` — team ${report.whalesyncTeamId ?? 'none'}, Whalesync user ${report.whalesyncUserId ?? 'none'}, ` +
      `Whalesync plan ${report.whalesyncPlanStatusOfOrganization ?? 'none'}` +
      (report.whalesyncPlanCopy ? ` (${report.whalesyncPlanCopy})` : ''),
  ];
  if (report.error) {
    lines.push(`  error: ${report.error}`);
  }
  if (report.shadowUser) {
    lines.push(
      `  shadow user ${report.shadowUser.userId} in ${report.shadowUser.organizationId}` +
        (report.shadowUser.createdThisRun ? ' (created this run)' : ' (from a previous run)'),
    );
  }
  for (const pausedWorkbookId of report.liveExportIdsLeftPausedForNextRun) {
    lines.push(`  LEFT PAUSED ${pausedWorkbookId}: stopped mid-move; run the migration again to finish and release it`);
  }
  for (const releasedWorkbookId of report.releasedLeftoverPausedLiveExportIds) {
    lines.push(`  released ${releasedWorkbookId}, left paused by a previous run`);
  }
  for (const liveExport of report.liveExports) {
    lines.push(
      `  Live Export ${liveExport.workbookId} "${liveExport.name ?? ''}": ${liveExport.connectionCount} connection(s), ` +
        `${liveExport.scheduleCount} schedule(s)`,
    );
    for (const repoMove of liveExport.repoMoves) {
      lines.push(
        `    ${repoMove.kind} repo ${repoMove.fromRepoId} -> ${repoMove.toRepoId}` +
          (repoMove.outcome ? ` (${repoMove.outcome})` : ''),
      );
    }
  }
  return lines;
}
