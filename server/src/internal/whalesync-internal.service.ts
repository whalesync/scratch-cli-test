import { Injectable } from '@nestjs/common';
import { WorkbookId } from '@spinner/shared-types';
import { WSLogger } from 'src/logger';
import { userToActor } from 'src/users/types';
import { UsersService } from 'src/users/users.service';
import { WorkbookService } from 'src/workbook/workbook.service';

const LOG_SOURCE = 'WhalesyncInternalService';

/**
 * Orchestrates the server-to-server operations Bottlenose drives over the admin channel: provisioning
 * shadow users, minting/revoking their short-lived browser session tokens, and deprovisioning them.
 *
 * This service (rather than {@link UsersService}) owns deprovisioning because tearing a shadow user down
 * must route through {@link WorkbookService.delete} (the CLAUDE.md cleanup rule), and `WorkbookModule`
 * already imports `UserModule` — injecting `WorkbookService` into `UsersService` would be a circular
 * dependency. The internal module sits above both, so it can compose them cleanly.
 */
@Injectable()
export class WhalesyncInternalService {
  constructor(
    private readonly usersService: UsersService,
    private readonly workbookService: WorkbookService,
  ) {}

  /** Ensure the shadow user exists, then mint a fresh 10-minute session token. Idempotent on `whalesyncUserId`. */
  public async ensureSessionForWhalesyncUser(
    whalesyncUserId: string,
    email: string,
    name?: string,
  ): Promise<{ scratchUserId: string; apiToken: string; expiresAt: Date }> {
    const shadowUser = await this.usersService.getOrCreateShadowUserFromWhalesync(whalesyncUserId, email, name);
    const { token, expiresAt } = await this.usersService.mintWhalesyncSessionToken(shadowUser.id);
    return { scratchUserId: shadowUser.id, apiToken: token, expiresAt };
  }

  /** Ensure (create-if-missing) the shadow user without minting a token. For eager provisioning. */
  public async ensureWhalesyncUser(
    whalesyncUserId: string,
    email: string,
    name?: string,
  ): Promise<{ scratchUserId: string }> {
    const shadowUser = await this.usersService.getOrCreateShadowUserFromWhalesync(whalesyncUserId, email, name);
    return { scratchUserId: shadowUser.id };
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
   * Deprovision a shadow user: delete every workbook they own through {@link WorkbookService.delete}
   * (so repos/jobs/tables are cleaned up), then remove the user (cascading its tokens) and the
   * auto-created organization. Idempotent: a user that doesn't exist is a no-op.
   */
  public async deprovisionWhalesyncUser(whalesyncUserId: string): Promise<void> {
    const shadowUser = await this.usersService.findByWhalesyncUserId(whalesyncUserId);
    if (!shadowUser) {
      // Already gone (or never provisioned) — idempotent success.
      return;
    }

    const actor = userToActor(shadowUser);
    const workbooks = await this.workbookService.findAllForUser(actor);

    WSLogger.info({
      source: LOG_SOURCE,
      message: `Deprovisioning shadow user ${shadowUser.id}: deleting ${workbooks.length} workbook(s)`,
      whalesyncUserId,
    });

    for (const workbook of workbooks) {
      await this.workbookService.delete(workbook.id as WorkbookId, actor);
    }

    await this.usersService.deleteShadowUserAndOrganization(shadowUser.id, shadowUser.organizationId ?? undefined);
  }
}
