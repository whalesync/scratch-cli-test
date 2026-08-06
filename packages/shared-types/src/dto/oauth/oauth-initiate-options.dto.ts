import { z } from 'zod';

/**
 * Keep in sync with spinner/client/src/types/server-entities/oauth.ts:OAuthInitiateOptionsDto.
 */
export const oauthInitiateOptionsSchema = z.object({
  /**
   * Absolute URL the OAuth callback forwards the result to (the "exit") once the provider redirects
   * back. Web: `${origin}/oauth/callback-step-2`. Desktop: `scratch://oauth-callback`. Whalesync
   * (Live Export): its own landing page. NEVER the OAuth redirect_uri / connector callback itself,
   * or the handler would forward to itself. Subject to the callback's host-based redirect allowlist.
   * Optional for now: every initiator still also sends the legacy `redirectPrefix` during the
   * transition, so old and new callbacks both work regardless of deploy order.
   */
  resultForwardUrl: z.string().min(1).optional(),
  /**
   * The `(http|https)://<host>(:<port>)` origin of the browser location kicking off an OAuth request,
   * so the callback knows which origin to bounce back to (stored in the URL `state` param). Mainly to
   * redirect back to `localhost` for OAuth services that don't support it natively.
   *
   * @deprecated Superseded by `resultForwardUrl`. Still required — and still sent by every initiator —
   * during the transition; it becomes optional and is then removed at cutoff.
   */
  redirectPrefix: z.string().min(1),
  connectionMethod: z.enum(['OAUTH_SYSTEM', 'OAUTH_CUSTOM']).optional(),
  customClientId: z.string().optional(),
  customClientSecret: z.string().optional(),
  connectionName: z.string().optional(),
  returnPage: z.string().optional(),
  connectorAccountId: z.string().optional(),
  workbookId: z.string().min(1),
  quickbooksSandbox: z.boolean().optional(),
  /** Zoho multi-datacenter selection (US | EU | IN | AU | JP | CA | CN | SA). */
  zohoDataCenter: z.string().optional(),
  /**
   * YouTube: raw, user-entered list of extra channel IDs (brand/managed channels
   * that `channels.list?mine=true` does not return). Comma/space/newline
   * separated; parsed into `ConnectorAccount.extras.additionalChannels` on connect.
   */
  youtubeAdditionalChannels: z.string().optional(),
  /**
   * Google Sheets: raw, user-entered spreadsheet URL(s) (or bare ids) from the
   * connect form. The spreadsheets-only OAuth scope can't browse Drive, so the
   * spreadsheets a connection works with are the ones the user points it at —
   * this seeds that list at connect time. Comma/whitespace/newline separated;
   * parsed into `ConnectorAccount.extras.spreadsheetIds` on connect.
   */
  googleSheetsSpreadsheetUrls: z.string().optional(),
});

export type OAuthInitiateOptionsDto = z.infer<typeof oauthInitiateOptionsSchema>;

// `redirectPrefix` and `workbookId` are already required by the schema.
export type ValidatedOAuthInitiateOptionsDto = OAuthInitiateOptionsDto;
