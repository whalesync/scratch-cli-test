import { Injectable } from '@nestjs/common';
import {
  ScratchPlanType,
  WhalesyncListLiveExportsResponse,
  WhalesyncLiveExportAccess,
  WhalesyncSetLiveExportAccessResponse,
  WhalesyncSubscriptionPayload,
  WhalesyncUpdateSubscriptionResponse,
  WorkbookId,
  WorkbookManager,
} from '@spinner/shared-types';
import { UserCluster } from 'src/db/cluster-types';
import { liveExportAccessFromWhalesyncSubscriptionPayload } from 'src/live-export-access/live-export-access-rules';
import { WSLogger } from 'src/logger';
import { StripePaymentService } from 'src/payment/stripe-payment.service';
import { assertIsPureWhalesyncShadowUser, userToActor } from 'src/users/types';
import { UsersService } from 'src/users/users.service';
import { WorkbookService } from 'src/workbook/workbook.service';

const LOG_SOURCE = 'WhalesyncInternalService';

/**
 * Orchestrates the server-to-server operations Bottlenose drives over the admin channel, each for one Whalesync
 * team's shadow user (DEV-13019): provisioning it and minting its short-lived browser session tokens, applying the
 * team's Live Export access (DEV-12983), listing its Live Exports, and deprovisioning it.
 *
 * Every one of them reaches a pure shadow user only (see {@link assertIsPureWhalesyncShadowUser}): a user with a real
 * Clerk login is refused with a 409, never handed out or deleted through this channel.
 *
 * This service (rather than {@link UsersService}) owns deprovisioning because tearing a shadow user down
 * must route through {@link WorkbookService.executeHardDeleteWorkbook} (the CLAUDE.md cleanup rule), and
 * `WorkbookModule` already imports `UserModule` — injecting `WorkbookService` into `UsersService` would be a
 * circular dependency. The internal module sits above both, so it can compose them cleanly.
 */
@Injectable()
export class WhalesyncInternalService {
  constructor(
    private readonly usersService: UsersService,
    private readonly workbookService: WorkbookService,
    private readonly stripePaymentService: StripePaymentService,
  ) {}

  /**
   * Ensure the team's shadow user exists, apply the team's Live Export access when the session carries one, then mint
   * a fresh 10-minute session token for it. Idempotent on `whalesyncTeamId`. Any member of the team gets the same
   * shadow user. `liveExportAccess` wins over `subscription`, the old payload, which is mapped onto an access.
   */
  public async ensureSessionForWhalesyncTeam(
    whalesyncTeamId: string,
    name?: string,
    liveExportAccess?: WhalesyncLiveExportAccess,
    subscription?: WhalesyncSubscriptionPayload,
  ): Promise<{ scratchUserId: string; apiToken: string; expiresAt: Date }> {
    const liveExportAccessToApply =
      liveExportAccess ?? (subscription ? liveExportAccessFromWhalesyncSubscriptionPayload(subscription) : undefined);
    const shadowUser = await this.usersService.getOrCreateShadowUserForWhalesyncTeam(
      whalesyncTeamId,
      name,
      liveExportAccessToApply,
    );
    const { token, expiresAt } = await this.usersService.mintWhalesyncSessionToken(shadowUser.id);
    return { scratchUserId: shadowUser.id, apiToken: token, expiresAt };
  }

  /**
   * Set the team's Live Export access (DEV-12983): whether its Live Exports are paused, how many records they may hold,
   * and how fast they may run on a schedule. Whalesync works it out from the team's plan and sends the whole of it
   * whenever it changes. Idempotent: a repeat changes nothing, and a team with no shadow user gets
   * `{ scratchUserId: null, updated: false }` with nothing created.
   */
  public async setLiveExportAccessForWhalesyncTeam(
    whalesyncTeamId: string,
    liveExportAccess: WhalesyncLiveExportAccess,
  ): Promise<WhalesyncSetLiveExportAccessResponse> {
    const shadowUser = await this.usersService.findShadowUserForWhalesyncTeam(whalesyncTeamId, 'live-export-access');
    if (!shadowUser) {
      return { scratchUserId: null, updated: false };
    }
    const { updated } = await this.stripePaymentService.applyWhalesyncLiveExportAccess(shadowUser, liveExportAccess);
    return { scratchUserId: shadowUser.id, updated };
  }

  /**
   * The old way to set the team's Live Export access, from a Whalesync backend before DEV-12983 MR 3.2: the payload is
   * mapped onto an access (paused unless its status is `active`) and applied as
   * {@link setLiveExportAccessForWhalesyncTeam} applies it, so the plan never lapses. Idempotent: a team with no shadow
   * user returns `{ scratchUserId: null, updated: false, planType: null }`.
   */
  public async updateWhalesyncSubscription(
    whalesyncTeamId: string,
    subscription: WhalesyncSubscriptionPayload,
  ): Promise<WhalesyncUpdateSubscriptionResponse> {
    const shadowUser = await this.usersService.findShadowUserForWhalesyncTeam(whalesyncTeamId, 'subscription');
    if (!shadowUser) {
      return { scratchUserId: null, updated: false, planType: null };
    }
    const { updated } = await this.stripePaymentService.applyWhalesyncLiveExportAccess(
      shadowUser,
      liveExportAccessFromWhalesyncSubscriptionPayload(subscription),
    );
    return {
      scratchUserId: shadowUser.id,
      updated,
      planType: shadowUser.organizationId ? ScratchPlanType.WHALESYNC_PLAN : null,
    };
  }

  /**
   * A team's Live Exports (`ws_export` workbooks), newest first, for Whalesync's admin dev tools. Skips workbooks
   * pending deletion. Read-only: a team with no shadow user gets an empty list and none is created.
   */
  public async listLiveExportsForWhalesyncTeam(whalesyncTeamId: string): Promise<WhalesyncListLiveExportsResponse> {
    const shadowUser = await this.usersService.findShadowUserForWhalesyncTeam(whalesyncTeamId, 'list');
    if (!shadowUser) {
      return { liveExports: [] };
    }

    const workbooks = await this.workbookService.findAllForUser(
      userToActor(shadowUser),
      'createdAt',
      'desc',
      WorkbookManager.WS_EXPORT,
    );
    return {
      liveExports: workbooks
        .filter((workbook) => !workbook.isPendingDelete)
        .map((workbook) => ({
          id: workbook.id,
          name: workbook.name,
          createdAt: workbook.createdAt.toISOString(),
          updatedAt: workbook.updatedAt.toISOString(),
        })),
    };
  }

  /**
   * Deprovision a team's shadow user, when Whalesync deletes or archives the team: delete it with its organization
   * and Live Exports (see {@link deleteShadowUserWithItsOrganizationAndOwnedWorkbooks}). Idempotent: a team with no
   * shadow user (already deprovisioned, or never provisioned) is a no-op, so the endpoint keeps returning 204 to
   * Bottlenose's retries.
   */
  public async deprovisionWhalesyncTeam(whalesyncTeamId: string): Promise<void> {
    const shadowUserOfTeam = await this.usersService.findShadowUserForWhalesyncTeam(whalesyncTeamId, 'delete');
    if (!shadowUserOfTeam) {
      return;
    }
    await this.deleteShadowUserWithItsOrganizationAndOwnedWorkbooks(shadowUserOfTeam, {
      deprovisionReason: 'whalesync_team_deprovisioned',
      whalesyncTeamId,
    });
  }

  /**
   * Delete a pure shadow user, following the same rules as `DevToolsService.hardDeleteUser`:
   *   1. Only when the user is the SOLE member of their organization, delete every workbook OWNED by that
   *      organization through {@link WorkbookService.executeHardDeleteWorkbook} (so repos/jobs/tables are
   *      cleaned up), then delete the user (cascading its tokens and workspace permissions) and the
   *      organization.
   *   2. Otherwise delete only the user. The organization and its workbooks stay with the remaining members.
   *
   * Workbooks are picked by `Workbook.organizationId`, never by membership: a workbook another organization
   * shared with this user is not theirs to delete, and their permission on it goes away with the user row
   * (DEV-12427).
   *
   * Refuses (409) a user that isn't a pure shadow user, before deleting anything: a real Scratch account is never
   * deleted through the Whalesync channel. Also used by the `whalesync-teamless-shadow-users-deprovision` code
   * migration.
   */
  public async deleteShadowUserWithItsOrganizationAndOwnedWorkbooks(
    shadowUser: UserCluster.User,
    logContext: { deprovisionReason: string; whalesyncTeamId?: string },
  ): Promise<void> {
    assertIsPureWhalesyncShadowUser(shadowUser, 'delete');
    const shadowUserOrganizationId = shadowUser.organizationId ?? undefined;
    const isSoleMemberOfOrganization = await this.usersService.isSoleMemberOfOrganization(shadowUser);

    let workbookIdsOwnedByShadowUserOrganization: WorkbookId[] = [];
    if (isSoleMemberOfOrganization && shadowUserOrganizationId) {
      workbookIdsOwnedByShadowUserOrganization =
        await this.workbookService.findIdsOfAllWorkbooksOwnedByOrganization(shadowUserOrganizationId);
    }

    WSLogger.info({
      source: LOG_SOURCE,
      message: `Deprovisioning shadow user ${shadowUser.id} by deleting it: deleting ${workbookIdsOwnedByShadowUserOrganization.length} workbook(s), organizationDeleted=${isSoleMemberOfOrganization}`,
      scratchUserId: shadowUser.id,
      ...logContext,
      organizationId: shadowUserOrganizationId,
    });

    // executeHardDeleteWorkbook is idempotent on an already-deleted workbook, so a retried deprovision (or a
    // pending-delete job finishing first) can't fail here the way the NotFound check in `delete` would.
    const actor = userToActor(shadowUser);
    for (const workbookId of workbookIdsOwnedByShadowUserOrganization) {
      await this.workbookService.executeHardDeleteWorkbook(workbookId, { actor });
    }

    await this.usersService.deleteShadowUserAndOrganization(
      shadowUser.id,
      isSoleMemberOfOrganization ? shadowUserOrganizationId : undefined,
    );
  }
}
