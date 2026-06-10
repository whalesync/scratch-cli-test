import { IsBoolean, IsNotEmpty, IsOptional, IsString } from 'class-validator';

/**
 * Keep in sync with spinner/client/src/types/server-entities/oauth.ts:OAuthInitiateOptionsDto.
 */
export class OAuthInitiateOptionsDto {
  /**
   * This is the `(http|https)://<host>(:<port>)` part of the URL for the browser location that is about to kick off an
   * OAuth request. This is needed so the client can know where to redirect back to (stored in the URL `state` param)
   * after the remote OAuth service redirects back to the browser.
   *
   * The main purpose of this is so that you can redirect back to `localhost` for OAuth services that don't support
   * this.
   */
  @IsString()
  @IsNotEmpty()
  redirectPrefix?: string;

  @IsString()
  @IsOptional()
  connectionMethod?: 'OAUTH_SYSTEM' | 'OAUTH_CUSTOM';

  @IsString()
  @IsOptional()
  customClientId?: string;

  @IsString()
  @IsOptional()
  customClientSecret?: string;

  @IsString()
  @IsOptional()
  connectionName?: string;

  @IsString()
  @IsOptional()
  returnPage?: string;

  @IsString()
  @IsOptional()
  connectorAccountId?: string;

  @IsString()
  @IsNotEmpty()
  workbookId?: string;

  @IsString()
  @IsOptional()
  shopDomain?: string;

  @IsBoolean()
  @IsOptional()
  quickbooksSandbox?: boolean;

  /** Zoho multi-datacenter selection (US | EU | IN | AU | JP | CA | CN | SA). */
  @IsString()
  @IsOptional()
  zohoDataCenter?: string;
}

export type ValidatedOAuthInitiateOptionsDto = Required<
  Pick<OAuthInitiateOptionsDto, 'redirectPrefix' | 'workbookId'>
> &
  Pick<
    OAuthInitiateOptionsDto,
    | 'connectionMethod'
    | 'customClientId'
    | 'customClientSecret'
    | 'connectionName'
    | 'returnPage'
    | 'connectorAccountId'
    | 'shopDomain'
    | 'quickbooksSandbox'
    | 'zohoDataCenter'
  >;
