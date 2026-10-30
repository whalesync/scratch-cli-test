import { Injectable } from '@nestjs/common';
import {
  WhalesyncListLiveExportsResponse,
  WhalesyncSubscriptionPayload,
  WhalesyncUpdateSubscriptionResponse,
  WorkbookId,
  WorkbookManager,
} from '@spinner/shared-types';
import { UserCluster } from 'src/db/cluster-types';
import { WSLogger } from 'src/logger';
import { StripePaymentService } from 'src/payment/stripe-payment.service';
import { isPureWhalesyncShadowUser, userToActor } from 'src/users/types';
import { UsersService } from 'src/users/users.service';
import { WorkbookService } from 'src/workbook/workbook.service';

const LOG_SOURCE = 'WhalesyncInternalService';

/**
 * Orchestrates the server-to-server operations Bottlenose drives over the admin channel: provisioning
 * shadow users, minting/revoking their short-lived browser session tokens, listing their Live Exports, and
 * deprovisioning them (deleting a pure shadow user, or unlinking a real Scratch account from Whalesync).
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

  /** Ensure the shadow user exists, then mint a fresh 10-minute session token. Idempotent on `whalesyncUserId`. */
  public async ensureSessionForWhalesyncUser(
    whalesyncUserId: string,
    email: string,
    name?: string,
    subscription?: WhalesyncSubscriptionPayload,
  ): Promise<{ scratchUserId: string; apiToken: string; expiresAt: Date }> {
    const shadowUser = await this.usersService.getOrCreateShadowUserFromWhalesync(
      whalesyncUserId,
      email,
      name,
      subscription,
    );
    const { token, expiresAt } = await this.usersService.mintWhalesyncSessionToken(shadowUser.id);
    return { scratchUserId: shadowUser.id, apiToken: token, expiresAt };
  }

  /** Ensure (create-if-missing) the shadow user without minting a token. For eager provisioning. */
  public async ensureWhalesyncUser(
    whalesyncUserId: string,
    email: string,
    name?: string,
    subscription?: WhalesyncSubscriptionPayload,
  ): Promise<{ scratchUserId: string }> {
    const shadowUser = await this.usersService.getOrCreateShadowUserFromWhalesync(
      whalesyncUserId,
      email,
      name,
      subscription,
    );
    return { scratchUserId: shadowUser.id };
  }

  /**
   * Apply a Whalesync subscription status change to a shadow user's Whalesync plan — driven by Bottlenose
   * whenever a subscription expires, is cancelled, or is upgraded on the Whalesync side. Only a
   * `WHALESYNC_PLAN` subscription is mutated: if the user holds a real active Scratch Stripe subscription
   * (paid Pro/Max) this throws `ConflictException` (→ 409), matching the contract. Idempotent: a user that
   * doesn't exist returns `{ scratchUserId: null, updated: false, planType: null }` so retried Bottlenose
   * lifecycle hooks are safe.
   */
  public async updateWhalesyncSubscription(
    whalesyncUserId: string,
    subscription: WhalesyncSubscriptionPayload,
  ): Promise<WhalesyncUpdateSubscriptionResponse> {
    const shadowUser = await this.usersService.findByWhalesyncUserId(whalesyncUserId);
    if (!shadowUser) {
      return { scratchUserId: null, updated: false, planType: null };
    }
    const { planType, updated } = await this.stripePaymentService.applyWhalesyncSubscriptionState(
      shadowUser,
      subscription,
      { throwOnRealSubscriptionConflict: true },
    );
    return { scratchUserId: shadowUser.id, updated, planType };
  }

  /**
   * Bulk-revoke a shadow user's session tokens (logout). Idempotent: a user that doesn't exist
   * returns `{ revoked: 0 }` rather than failing, so retried Bottlenose lifecycle hooks are safe.
   */
  public async revokeSessionsForWhalesyncUser(whalesyncUserId: string): Promise<{ revoked: number }> {
    const shadowUser = await this.usersService.findByWhalesyncUserId(whalesyncUserId);
    if (!shadowUser) {
      return { revoked: 0 };
    }
    const revoked = await this.usersService.revokeWhalesyncSessionTokens(shadowUser.id);
    return { revoked };
  }

  /**
   * Clear a shadow user's internal Whalesync-plan subscription — revoke the free Scratch access granted
   * for their Whalesync subscription. Driven by Bottlenose when the user's Whalesync subscription ends.
   * Throws `ConflictException` (409) if the user has a real active Scratch Stripe subscription (we never
   * downgrade a paying customer). Idempotent: a user that doesn't exist (already deprovisioned, or never
   * provisioned) returns `{ scratchUserId: null, cleared: false }` rather than failing, so retried
   * Bottlenose lifecycle hooks are safe.
   */
  public async clearWhalesyncSubscriptionForWhalesyncUser(
    whalesyncUserId: string,
  ): Promise<{ scratchUserId: string | null; cleared: boolean }> {
    const shadowUser = await this.usersService.findByWhalesyncUserId(whalesyncUserId);
    if (!shadowUser) {
      return { scratchUserId: null, cleared: false };
    }
    const { cleared } = await this.stripePaymentService.clearWhalesyncPlanSubscription(shadowUser);
    return { scratchUserId: shadowUser.id, cleared };
  }

  /**
   * A shadow user's Live Exports (`ws_export` workbooks), newest first, for Whalesync's admin dev tools. Skips
   * workbooks pending deletion. Read-only: a user that doesn't exist gets an empty list and is not created.
   */
  public async listLiveExportsForWhalesyncUser(whalesyncUserId: string): Promise<WhalesyncListLiveExportsResponse> {
    const shadowUser = await this.usersService.findByWhalesyncUserId(whalesyncUserId);
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
   * Deprovision the Scratch user linked to a Whalesync user, when Whalesync deletes or archives that account. What
   * happens depends on whether the Scratch user is a pure shadow user or a real Scratch account (DEV-12578):
   *
   *   - **Pure shadow user** (synthetic `ws_` clerkId, see {@link isPureWhalesyncShadowUser}): Whalesync created the
   *     account and it has never had a native login, so it is deleted outright. See
   *     {@link deleteShadowUserWithItsOrganizationAndOwnedWorkbooks}.
   *   - **Real Scratch account** (a native account adopted by email, or a shadow row that later signed in natively):
   *     the person still uses Scratch, so only the Whalesync link and what belongs to the Whalesync account go. The
   *     user, their organization, and their native workbooks are kept. See
   *     {@link unlinkRealScratchUserFromWhalesyncIdentity}.
   *
   * Idempotent: a user that doesn't exist (or is no longer linked) is a no-op, so the endpoint keeps returning 204 to
   * Bottlenose's retries.
   */
  public async deprovisionWhalesyncUser(whalesyncUserId: string): Promise<void> {
    const linkedUser = await this.usersService.findByWhalesyncUserId(whalesyncUserId);
    if (!linkedUser) {
      // Already gone or unlinked (or never provisioned) — idempotent success.
      return;
    }

    if (isPureWhalesyncShadowUser(linkedUser)) {
      await this.deleteShadowUserWithItsOrganizationAndOwnedWorkbooks(linkedUser, whalesyncUserId);
    } else {
      await this.unlinkRealScratchUserFromWhalesyncIdentity(linkedUser, whalesyncUserId);
    }
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
   */
  private async deleteShadowUserWithItsOrganizationAndOwnedWorkbooks(
    shadowUser: UserCluster.User,
    whalesyncUserId: string,
  ): Promise<void> {
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
      deprovisionBranch: 'delete',
      scratchUserId: shadowUser.id,
      whalesyncUserId,
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

  /**
   * Detach a real Scratch account from the Whalesync identity being deprovisioned, keeping the account itself: the
   * user row, their organization, their workspace permissions, and every workbook that isn't a Live Export stay.
   *   1. Hard-delete the Live Export (`ws_export`) workbooks the user created. They belong to the Whalesync account,
   *      and their scheduled runs would otherwise keep exporting with no Whalesync owner.
   *   2. Remove the internal `WHALESYNC_PLAN` subscription. A real Scratch Stripe subscription is never touched, and
   *      having one does not block the unlink.
   *   3. Revoke the WHALESYNC_SESSION tokens and clear `whalesyncUserId`, together.
   *
   * The unlink runs last on purpose: until it commits, the user is still found by `whalesyncUserId`, so if an
   * earlier step throws, Bottlenose's retry re-runs every (idempotent) step. Once it commits, a retry is a no-op.
   */
  private async unlinkRealScratchUserFromWhalesyncIdentity(
    realScratchUser: UserCluster.User,
    whalesyncUserId: string,
  ): Promise<void> {
    const liveExportWorkbookIdsCreatedByUser = await this.workbookService.findIdsOfLiveExportWorkbooksCreatedByUser(
      realScratchUser.id,
    );

    const actor = userToActor(realScratchUser);
    for (const workbookId of liveExportWorkbookIdsCreatedByUser) {
      await this.workbookService.executeHardDeleteWorkbook(workbookId, { actor });
    }

    const { cleared: whalesyncPlanSubscriptionCleared } =
      await this.stripePaymentService.clearWhalesyncPlanSubscription(realScratchUser, {
        throwOnRealSubscriptionConflict: false,
      });

    const { revokedWhalesyncSessionTokenCount } = await this.usersService.unlinkUserFromWhalesyncIdentity(
      realScratchUser.id,
    );

    WSLogger.info({
      source: LOG_SOURCE,
      message: `Deprovisioned Whalesync identity from real Scratch user ${realScratchUser.id} by unlinking it: kept the user and organization, deleted ${liveExportWorkbookIdsCreatedByUser.length} Live Export workbook(s), whalesyncPlanSubscriptionCleared=${whalesyncPlanSubscriptionCleared}, revoked ${revokedWhalesyncSessionTokenCount} session token(s)`,
      deprovisionBranch: 'unlink',
      scratchUserId: realScratchUser.id,
      whalesyncUserId,
      organizationId: realScratchUser.organizationId ?? undefined,
    });
  }
}
