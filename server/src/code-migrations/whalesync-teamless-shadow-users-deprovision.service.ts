import { Injectable } from '@nestjs/common';
import { MigrationResult, MigrationResultSummaryRow, WorkbookManager } from '@spinner/shared-types';
import { DbService } from 'src/db/db.service';
import { WhalesyncInternalService } from 'src/internal/whalesync-internal.service';
import { WSLogger } from 'src/logger';
import { isPureWhalesyncShadowUser, WHALESYNC_SHADOW_USER_CLERK_ID_PREFIX } from 'src/users/types';
import { UsersService } from 'src/users/users.service';
import { assertUnreachable } from 'src/utils/asserts';
import { WorkbookService } from 'src/workbook/workbook.service';

export const WHALESYNC_TEAMLESS_SHADOW_USERS_DEPROVISION_MIGRATION_NAME = 'whalesync-teamless-shadow-users-deprovision';

const LOG_SOURCE = 'WhalesyncTeamlessShadowUsersDeprovision';

/** Why a candidate was left alone. Each is reported, never forced. */
export type TeamlessShadowUserSkipReason =
  /** It has a real Clerk login (a person's own Scratch account), so it is not Whalesync's to delete. */
  | 'not_a_pure_shadow_user'
  /** It created a Live Export, or its organization owns one: deleting it would delete someone's export. */
  | 'holds_a_live_export'
  /** Its organization has another member, whose workbooks would go with it. */
  | 'organization_has_another_member'
  /** It was given a Whalesync team since it was selected. */
  | 'now_belongs_to_a_team';

/** What happened to one candidate. */
export type TeamlessShadowUserOutcome =
  | { kind: 'deprovisioned' }
  /** Deleted between selection and its turn, e.g. by a concurrent run or a team deprovision. */
  | { kind: 'already_gone' }
  | { kind: 'would_deprovision' }
  | { kind: 'skipped'; reason: TeamlessShadowUserSkipReason }
  | { kind: 'failed'; errorMessage: string };

/**
 * DEV-13019 — deprovisions the Whalesync shadow users that belong to no Whalesync team. Scratch now reaches a shadow
 * user only by team, so these can never be reached again: they are the pure shadow users made for a Whalesync person
 * before teams that no Whalesync environment ever gave a team (about 16 in Scratch test, none in production). Each is
 * deleted through {@link WhalesyncInternalService.deleteShadowUserWithItsOrganizationAndOwnedWorkbooks}, the same path
 * as a team's deprovision.
 *
 * Candidates are selected by data on every run, never by id: users with no `whalesyncTeamId` that either carry the
 * synthetic `ws_` clerkId or still carry a (deprecated) `whalesyncUserId`. The second half only widens the net so a
 * leftover link to a real account is reported rather than missed. A candidate is skipped, and reported, when it isn't
 * a pure shadow user, holds a Live Export, belongs to an organization with another member, or was given a team
 * meanwhile. Every condition is re-checked against a fresh read right before the delete. Idempotent: a deleted user
 * is no longer a candidate, and a skipped one is skipped again.
 */
@Injectable()
export class WhalesyncTeamlessShadowUsersDeprovisionService {
  constructor(
    private readonly db: DbService,
    private readonly usersService: UsersService,
    private readonly workbookService: WorkbookService,
    private readonly whalesyncInternalService: WhalesyncInternalService,
  ) {}

  /**
   * @param options.scratchUserIdsToConsider When given, only these candidates are considered (each must still be one).
   * @param options.maximumCandidateCount When given, at most this many candidates are considered, in id order.
   */
  async run(options: {
    dryRun: boolean;
    scratchUserIdsToConsider?: string[];
    maximumCandidateCount?: number;
  }): Promise<MigrationResult> {
    const candidateUserIds = await this.findIdsOfShadowUsersWithoutTeam(options.scratchUserIdsToConsider);
    const candidateUserIdsThisRun =
      options.maximumCandidateCount !== undefined
        ? candidateUserIds.slice(0, options.maximumCandidateCount)
        : candidateUserIds;

    const outcomeByUserId = new Map<string, TeamlessShadowUserOutcome>();
    for (const candidateUserId of candidateUserIdsThisRun) {
      outcomeByUserId.set(candidateUserId, await this.deprovisionIfStillEligible(candidateUserId, options.dryRun));
    }

    const outcomes = [...outcomeByUserId.values()];
    const deprovisionedOrWouldDeprovisionUserIds = [...outcomeByUserId.entries()]
      .filter(([, outcome]) => outcome.kind === 'deprovisioned' || outcome.kind === 'would_deprovision')
      .map(([userId]) => userId);
    const remainingCandidateCount = (await this.findIdsOfShadowUsersWithoutTeam(options.scratchUserIdsToConsider))
      .length;

    const result: MigrationResult = {
      migrationName: WHALESYNC_TEAMLESS_SHADOW_USERS_DEPROVISION_MIGRATION_NAME,
      dryRun: options.dryRun,
      migratedIds: deprovisionedOrWouldDeprovisionUserIds,
      remainingCount: remainingCandidateCount,
      summary: summarizeTeamlessShadowUserOutcomes(outcomes, options.dryRun, candidateUserIds.length),
      report: [...outcomeByUserId.entries()].map(([userId, outcome]) => describeOutcome(userId, outcome)),
    };
    WSLogger.info({
      source: LOG_SOURCE,
      message: `Teamless shadow user deprovision ${options.dryRun ? '(dry run) ' : ''}finished`,
      summary: result.summary,
      remainingCandidateCount,
    });
    return result;
  }

  /** Ids, ascending, of the users with no Whalesync team that are, or were linked as, Whalesync shadow users. */
  private async findIdsOfShadowUsersWithoutTeam(scratchUserIdsToConsider: string[] | undefined): Promise<string[]> {
    const candidates = await this.db.client.user.findMany({
      where: {
        whalesyncTeamId: null,
        OR: [{ clerkId: { startsWith: WHALESYNC_SHADOW_USER_CLERK_ID_PREFIX } }, { whalesyncUserId: { not: null } }],
        ...(scratchUserIdsToConsider ? { id: { in: scratchUserIdsToConsider } } : {}),
      },
      select: { id: true },
      orderBy: { id: 'asc' },
    });
    return candidates.map((candidate) => candidate.id);
  }

  private async deprovisionIfStillEligible(userId: string, dryRun: boolean): Promise<TeamlessShadowUserOutcome> {
    try {
      const candidate = await this.usersService.findOne(userId);
      if (!candidate) {
        return { kind: 'already_gone' };
      }
      if (candidate.whalesyncTeamId) {
        return { kind: 'skipped', reason: 'now_belongs_to_a_team' };
      }
      if (!isPureWhalesyncShadowUser(candidate)) {
        return { kind: 'skipped', reason: 'not_a_pure_shadow_user' };
      }
      if (candidate.organizationId && !(await this.usersService.isSoleMemberOfOrganization(candidate))) {
        return { kind: 'skipped', reason: 'organization_has_another_member' };
      }
      if (await this.holdsALiveExport(candidate.id, candidate.organizationId)) {
        return { kind: 'skipped', reason: 'holds_a_live_export' };
      }
      if (dryRun) {
        return { kind: 'would_deprovision' };
      }
      await this.whalesyncInternalService.deleteShadowUserWithItsOrganizationAndOwnedWorkbooks(candidate, {
        deprovisionReason: WHALESYNC_TEAMLESS_SHADOW_USERS_DEPROVISION_MIGRATION_NAME,
      });
      return { kind: 'deprovisioned' };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      WSLogger.error({
        source: LOG_SOURCE,
        message: `Failed to deprovision teamless shadow user ${userId}`,
        userId,
        error,
      });
      return { kind: 'failed', errorMessage };
    }
  }

  /** Whether the user created a Live Export, or its organization owns one (pending deletion or not). */
  private async holdsALiveExport(userId: string, organizationId: string | null): Promise<boolean> {
    if ((await this.workbookService.findIdsOfLiveExportWorkbooksCreatedByUser(userId)).length > 0) {
      return true;
    }
    if (!organizationId) {
      return false;
    }
    const liveExportCountOwnedByOrganization = await this.db.client.workbook.count({
      where: { organizationId, managedBy: WorkbookManager.WS_EXPORT },
    });
    return liveExportCountOwnedByOrganization > 0;
  }
}

const SKIP_REASON_LABELS: Record<TeamlessShadowUserSkipReason, string> = {
  not_a_pure_shadow_user: 'Skipped: not a pure shadow user (has a real Clerk login)',
  holds_a_live_export: 'Skipped: holds a Live Export',
  organization_has_another_member: 'Skipped: organization has another member',
  now_belongs_to_a_team: 'Skipped: was given a Whalesync team meanwhile',
};

export function summarizeTeamlessShadowUserOutcomes(
  outcomes: TeamlessShadowUserOutcome[],
  dryRun: boolean,
  candidateCountBeforeRun: number,
): MigrationResultSummaryRow[] {
  const countOf = (predicate: (outcome: TeamlessShadowUserOutcome) => boolean): number =>
    outcomes.filter(predicate).length;
  const rows: MigrationResultSummaryRow[] = [
    { label: 'Candidates (teamless shadow users) before this run', count: candidateCountBeforeRun },
    { label: 'Considered this run', count: outcomes.length },
    dryRun
      ? { label: 'Would deprovision', count: countOf((outcome) => outcome.kind === 'would_deprovision') }
      : { label: 'Deprovisioned', count: countOf((outcome) => outcome.kind === 'deprovisioned') },
  ];
  for (const [reason, label] of Object.entries(SKIP_REASON_LABELS) as [TeamlessShadowUserSkipReason, string][]) {
    rows.push({
      label,
      count: countOf((outcome) => outcome.kind === 'skipped' && outcome.reason === reason),
    });
  }
  rows.push({ label: 'Already gone', count: countOf((outcome) => outcome.kind === 'already_gone') });
  rows.push({ label: 'Failed', count: countOf((outcome) => outcome.kind === 'failed') });
  return rows;
}

function describeOutcome(userId: string, outcome: TeamlessShadowUserOutcome): string {
  switch (outcome.kind) {
    case 'deprovisioned':
      return `${userId}: deprovisioned`;
    case 'already_gone':
      return `${userId}: already gone`;
    case 'would_deprovision':
      return `${userId}: would deprovision`;
    case 'skipped':
      return `${userId}: ${SKIP_REASON_LABELS[outcome.reason]}`;
    case 'failed':
      return `${userId}: FAILED: ${outcome.errorMessage}`;
    default:
      return assertUnreachable(outcome);
  }
}
