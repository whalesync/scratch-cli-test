import { z } from 'zod';

/**
 * Types for the **marketplace-initiated ("inbound") OAuth install** flow — where a
 * connector's marketplace (e.g. the GoHighLevel App Marketplace) starts the OAuth,
 * not Scratch. Connector-agnostic: keyed by `service`, so any OAuth connector reuses
 * the same endpoints and claim page.
 *
 * Flow: marketplace → public web page `/oauth/install/:service?code=…` → that page
 * POSTs the code to `POST /oauth/install/:service` (redeems immediately and stashes
 * the tokens under an unguessable `installId`) → navigates to the claim page
 * `/connect/:service?install=<installId>` → the authenticated user claims it via
 * `POST /oauth/pending-install/:installId/claim`.
 */

/** Request body for `POST /oauth/install/:service` — the one-time code the marketplace delivered. */
export const redeemInboundInstallSchema = z.object({
  code: z.string().min(1),
});
export type RedeemInboundInstallDto = z.infer<typeof redeemInboundInstallSchema>;

/** Response for `POST /oauth/install/:service` — the single-use installId the claim page then redeems. */
export interface RedeemInboundInstallResponse {
  installId: string;
  service: string;
}

/** Public metadata about a pending inbound install (never includes tokens). Response for `GET /oauth/pending-install/:installId`. */
export interface PendingOAuthInstallInfo {
  /** Connector service key, e.g. "GOHIGHLEVEL". */
  service: string;
  /**
   * Human-friendly service name resolved on the server (e.g. "HighLevel"), so the claim page can
   * render it without any connector-specific knowledge of its own.
   */
  serviceDisplayName: string;
  /** The external workspace/location id the tokens are scoped to (e.g. GHL locationId), if any. */
  workspaceId: string | null;
  /** Human-friendly label for the claim page, if resolvable. */
  displayName: string | null;
  /** ISO-8601 expiry — after this the install link is dead and the user must re-install. */
  expiresAt: string;
}

/** Response for `POST /oauth/pending-install/:installId/claim` — the connection + workbook the claim created. */
export interface ClaimInboundInstallResponse {
  connectorAccountId: string;
  workbookId: string;
}
