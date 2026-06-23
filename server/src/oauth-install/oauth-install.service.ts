import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ClaimInboundInstallResponse, PendingOAuthInstallInfo, WorkbookId } from '@spinner/shared-types';
import { randomBytes } from 'crypto';
import { CredentialEncryptionService } from 'src/credential-encryption/credential-encryption.service';
import { DbService } from 'src/db/db.service';
import { OAuthTokenResponse } from 'src/oauth/oauth-provider.interface';
import { OAuthService } from 'src/oauth/oauth.service';
import { DecryptedCredentials } from 'src/remote-service/connector-account/types/encrypted-credentials.interface';
import { getServiceDisplayName } from 'src/remote-service/connectors/display-names';
import { Actor } from 'src/users/types';
import { EncryptedData } from 'src/utils/encryption';
import { WorkbookService } from 'src/workbook/workbook.service';

/**
 * How long a marketplace-initiated ("inbound") install stays claimable. Bounds how
 * long a brand-new user has to sign up + verify email before the link expires, and
 * is the max useful lifetime of an orphan (never-claimed) token. 1 hour.
 */
const INBOUND_INSTALL_TTL_MS = 60 * 60 * 1000;

/**
 * Maps a public install URL slug → the canonical connector service key, for the rare
 * connector whose marketplace forbids its own brand in redirect URLs. GoHighLevel
 * rejects any redirect URL containing its brand ("highlevel", "gohighlevel", "ghl"),
 * so its inbound install uses the slug `hl`, mapped here back to `GOHIGHLEVEL`. Every
 * other connector's slug is just its lowercased service key, so the default
 * (uppercasing the slug) covers them with no entry here.
 */
const INSTALL_SLUG_TO_SERVICE_KEY: Record<string, string> = {
  hl: 'GOHIGHLEVEL',
};

function resolveInstallSlugToServiceKey(slug: string): string {
  return INSTALL_SLUG_TO_SERVICE_KEY[slug.toLowerCase()] ?? slug.toUpperCase();
}

/**
 * Owns the **marketplace-initiated ("inbound") OAuth install** flow end to end —
 * connector-agnostic, keyed by `service`. Lives in its own module (which imports
 * both {@link OAuthModule} and the workbook module) so it can create a workbook on
 * claim without forming the dependency cycle that would arise if OAuthModule itself
 * depended on the workbook module (workbook → connectors → oauth).
 *
 * OAuthService contributes only the two generic OAuth primitives this flow needs
 * (`exchangeInboundCodeForTokens`, `createConnectorAccountFromOAuthTokens`); the
 * pending-install bookkeeping (stash, TTL, single-use claim) all lives here.
 */
@Injectable()
export class OAuthInstallService {
  constructor(
    private readonly db: DbService,
    private readonly oauthService: OAuthService,
    private readonly workbookService: WorkbookService,
    private readonly credentialEncryptionService: CredentialEncryptionService,
  ) {}

  /**
   * Step 1 (PUBLIC). Redeem the marketplace's one-time `code` NOW — it expires in
   * minutes and can't survive a sign-up/login detour — and stash the resulting
   * tokens, encrypted, under a fresh unguessable single-use `installId`.
   *
   * `redirectUri` is the install endpoint the marketplace sent the code to; it's
   * forwarded to the token exchange so its `redirect_uri` matches.
   */
  async redeemAndStashInstall(
    service: string,
    code: string,
    redirectUri?: string,
  ): Promise<{ installId: string; service: string }> {
    // `service` is the public URL slug (e.g. "hl"); resolve it to the canonical key.
    const serviceKey = resolveInstallSlugToServiceKey(service);
    const tokenResponse = await this.oauthService.exchangeInboundCodeForTokens(serviceKey, code, redirectUri);

    const credentials: DecryptedCredentials = {
      oauthAccessToken: tokenResponse.access_token,
      oauthRefreshToken: tokenResponse.refresh_token,
      oauthExpiresAt: tokenResponse.expires_in
        ? new Date(Date.now() + tokenResponse.expires_in * 1000).toISOString()
        : undefined,
      oauthWorkspaceId: tokenResponse.workspace_id,
    };
    const encryptedCredentials = await this.credentialEncryptionService.encryptCredentials(credentials);

    // High-entropy, unguessable, single-use bearer secret (see inbound-oauth-plan §7).
    const installId = `pin_${randomBytes(32).toString('base64url')}`;
    await this.db.client.pendingOAuthInstall.create({
      data: {
        id: installId,
        service: serviceKey,
        encryptedCredentials: encryptedCredentials as unknown as Prisma.InputJsonValue,
        workspaceId: tokenResponse.workspace_id ?? null,
        displayName: tokenResponse.workspace_id ?? null,
        expiresAt: new Date(Date.now() + INBOUND_INSTALL_TTL_MS),
      },
    });

    return { installId, service: serviceKey };
  }

  /**
   * Step 1.5 (AUTH). Public metadata for the claim page. Never returns tokens.
   * Throws if the install is missing, already claimed, or expired.
   */
  async getPendingInstall(installId: string): Promise<PendingOAuthInstallInfo> {
    const row = await this.db.client.pendingOAuthInstall.findUnique({ where: { id: installId } });
    if (!row || row.claimedAt || row.expiresAt < new Date()) {
      throw new NotFoundException('This install link is invalid or has expired. Re-install from the marketplace.');
    }
    return {
      service: row.service,
      serviceDisplayName: getServiceDisplayName(row.service),
      workspaceId: row.workspaceId,
      displayName: row.displayName,
      expiresAt: row.expiresAt.toISOString(),
    };
  }

  /**
   * Step 2 (AUTH). An authenticated user claims a pending install: auto-create a
   * fresh workbook, move the stashed tokens into a real ConnectorAccount, and
   * consume the single-use pending row. Atomically reserves the row FIRST, before
   * creating anything, so a double-submit can't spawn two connections.
   */
  async claimInstall(installId: string, actor: Actor): Promise<ClaimInboundInstallResponse> {
    // Atomic reserve: only one caller flips claimedAt from null while unexpired.
    const reserved = await this.db.client.pendingOAuthInstall.updateMany({
      where: { id: installId, claimedAt: null, expiresAt: { gt: new Date() } },
      data: { claimedAt: new Date(), claimedByUserId: actor.userId },
    });
    if (reserved.count !== 1) {
      throw new BadRequestException(
        'This install link is invalid, already claimed, or expired. Re-install from the marketplace.',
      );
    }

    const row = await this.db.client.pendingOAuthInstall.findUniqueOrThrow({ where: { id: installId } });
    let createdWorkbookId: WorkbookId | undefined;
    try {
      const credentials = await this.credentialEncryptionService.decryptCredentials(
        row.encryptedCredentials as unknown as EncryptedData,
      );
      // Rebuild a token response so we can reuse the standard account-creation tail.
      // expires_in is derived from the stored absolute expiry so the re-computed
      // expiry lands on the instant the marketplace issued.
      const tokenResponse: OAuthTokenResponse = {
        access_token: credentials.oauthAccessToken ?? '',
        refresh_token: credentials.oauthRefreshToken,
        expires_in: credentials.oauthExpiresAt
          ? Math.max(0, Math.floor((new Date(credentials.oauthExpiresAt).getTime() - Date.now()) / 1000))
          : undefined,
        workspace_id: credentials.oauthWorkspaceId,
      };

      const workbook = await this.workbookService.create({ name: getServiceDisplayName(row.service) }, actor);
      createdWorkbookId = workbook.id as WorkbookId;
      const account = await this.oauthService.createConnectorAccountFromOAuthTokens(
        row.service,
        createdWorkbookId,
        actor,
        tokenResponse,
      );

      // Single-use: consume the pending row once successfully claimed.
      await this.db.client.pendingOAuthInstall.delete({ where: { id: installId } });
      return { connectorAccountId: account.id, workbookId: workbook.id };
    } catch (error) {
      // Roll back a half-finished claim: delete any workbook we created and release
      // the reservation so the user can retry within the TTL.
      if (createdWorkbookId) {
        await this.workbookService.delete(createdWorkbookId, actor).catch(() => undefined);
      }
      await this.db.client.pendingOAuthInstall
        .updateMany({ where: { id: installId }, data: { claimedAt: null, claimedByUserId: null } })
        .catch(() => undefined);
      throw error;
    }
  }
}
