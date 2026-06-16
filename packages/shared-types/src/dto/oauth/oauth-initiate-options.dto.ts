import { z } from 'zod';

/**
 * Keep in sync with spinner/client/src/types/server-entities/oauth.ts:OAuthInitiateOptionsDto.
 */
export const oauthInitiateOptionsSchema = z.object({
  /**
   * The `(http|https)://<host>(:<port>)` part of the URL for the browser location kicking off an
   * OAuth request, so the client knows where to redirect back to (stored in the URL `state` param)
   * after the remote OAuth service redirects back. Mainly used to redirect back to `localhost` for
   * OAuth services that don't support it natively.
   */
  redirectPrefix: z.string().min(1),
  connectionMethod: z.enum(['OAUTH_SYSTEM', 'OAUTH_CUSTOM']).optional(),
  customClientId: z.string().optional(),
  customClientSecret: z.string().optional(),
  connectionName: z.string().optional(),
  returnPage: z.string().optional(),
  connectorAccountId: z.string().optional(),
  workbookId: z.string().min(1),
  shopDomain: z.string().optional(),
  quickbooksSandbox: z.boolean().optional(),
  /** Zoho multi-datacenter selection (US | EU | IN | AU | JP | CA | CN | SA). */
  zohoDataCenter: z.string().optional(),
  /**
   * YouTube: raw, user-entered list of extra channel IDs (brand/managed channels
   * that `channels.list?mine=true` does not return). Comma/space/newline
   * separated; parsed into `ConnectorAccount.extras.additionalChannels` on connect.
   */
  youtubeAdditionalChannels: z.string().optional(),
});

export type OAuthInitiateOptionsDto = z.infer<typeof oauthInitiateOptionsSchema>;

// `redirectPrefix` and `workbookId` are already required by the schema.
export type ValidatedOAuthInitiateOptionsDto = OAuthInitiateOptionsDto;
