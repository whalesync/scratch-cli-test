import { z } from 'zod';

/**
 * A yes/no connect-form option (a connector's `boolean` OAuth credential field). Scratch's web client sends a
 * boolean, but Whalesync's Live Export connect form sends every field value as a string, so `"true"` / `"false"`
 * are accepted too and parsed to the boolean.
 */
const connectFormYesNoOptionSchema = z.union([
  z.boolean(),
  z.enum(['true', 'false']).transform((yesNoText) => yesNoText === 'true'),
]);

/**
 * Keep in sync with spinner/client/src/types/server-entities/oauth.ts:OAuthInitiateOptionsDto.
 */
export const oauthInitiateOptionsSchema = z.object({
  /**
   * Absolute URL the OAuth callback forwards the result to (the "exit") once the provider redirects
   * back. Web: `${origin}/oauth/callback-step-2`. Desktop: `scratch://oauth-callback`. Whalesync
   * (Live Export): its own landing page. NEVER the OAuth redirect_uri / connector callback itself,
   * or the handler would forward to itself. Subject to the callback's host-based redirect allowlist.
   */
  resultForwardUrl: z.string().min(1),
  connectionMethod: z.enum(['OAUTH_SYSTEM', 'OAUTH_CUSTOM']).optional(),
  customClientId: z.string().optional(),
  customClientSecret: z.string().optional(),
  connectionName: z.string().optional(),
  /**
   * Web-only: in-app path to land on once the connection completes, read at
   * `/oauth/callback-step-2`. Not a forward target — that is `resultForwardUrl`.
   */
  returnPage: z.string().optional(),
  connectorAccountId: z.string().optional(),
  workbookId: z.string().min(1),
  quickbooksSandbox: connectFormYesNoOptionSchema.optional(),
  /** Zoho multi-datacenter selection (US | EU | IN | AU | JP | CA | CN | SA). */
  zohoDataCenter: z.string().optional(),
  /** Salesforce: the org is a sandbox, which signs in at test.salesforce.com instead of login.salesforce.com. */
  salesforceSandbox: connectFormYesNoOptionSchema.optional(),
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

// `resultForwardUrl` and `workbookId` are already required by the schema.
export type ValidatedOAuthInitiateOptionsDto = OAuthInitiateOptionsDto;
