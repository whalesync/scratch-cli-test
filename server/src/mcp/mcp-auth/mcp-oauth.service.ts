import { BadRequestException, Injectable, UnauthorizedException } from '@nestjs/common';
import { createApiTokenId, createMcpClientId, TokenType } from '@spinner/shared-types';
import { createHash, randomUUID } from 'crypto';
import IORedis from 'ioredis';
import { ScratchConfigService } from 'src/config/scratch-config.service';
import { DbService } from 'src/db/db.service';
import { WSLogger } from 'src/logger';
import { generateApiToken } from 'src/users/tokens';

const AUTH_CODE_PREFIX = 'mcp:auth_code:';
const AUTH_CODE_TTL = 300; // 5 minutes

const REFRESH_TOKEN_PREFIX = 'mcp:refresh_token:';
const REFRESH_TOKEN_TTL = 60 * 60 * 24 * 30; // 30 days

const ACCESS_TOKEN_TTL = 60 * 60 * 12; // 12 hours

interface StoredAuthCode {
  code: string;
  clientId: string;
  userId: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  redirectUri: string;
  scopes: string[];
}

interface StoredRefreshToken {
  clientId: string;
  userId: string;
  scopes: string[];
}

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  token_type: string;
  expires_in: number;
  scope: string;
}

@Injectable()
export class McpOAuthService {
  private redis: IORedis;

  constructor(
    private readonly configService: ScratchConfigService,
    private readonly db: DbService,
  ) {
    this.redis = new IORedis({
      host: this.configService.getRedisHost(),
      port: this.configService.getRedisPort(),
      password: this.configService.getRedisPassword(),
      maxRetriesPerRequest: null,
    });
  }

  getProtectedResourceMetadata(): Record<string, unknown> {
    const serverUrl = this.configService.getScratchServerUrl();

    return {
      resource: `${serverUrl}/mcp`,
      authorization_servers: [serverUrl],
      scopes_supported: ['read:workbooks', 'read:files'],
      bearer_methods_supported: ['header'],
    };
  }

  getOAuthMetadata(): Record<string, unknown> {
    const serverUrl = this.configService.getScratchServerUrl();

    return {
      issuer: serverUrl,
      authorization_endpoint: `${serverUrl}/mcp-auth/authorize`,
      token_endpoint: `${serverUrl}/mcp-auth/token`,
      registration_endpoint: `${serverUrl}/mcp-auth/register`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      scopes_supported: ['read:workbooks', 'read:files'],
    };
  }

  async registerClient(body: {
    client_name?: string;
    redirect_uris?: string[];
  }): Promise<{ client_id: string; client_name?: string; redirect_uris: string[] }> {
    const clientId = randomUUID();
    const redirectUris = body.redirect_uris ?? [];

    await this.db.client.mcpClient.create({
      data: {
        id: createMcpClientId(),
        clientId,
        clientName: body.client_name ?? null,
        redirectUris,
      },
    });

    WSLogger.info({
      source: 'McpOAuthService.registerClient',
      message: 'Registered MCP OAuth client',
      clientId,
    });

    return {
      client_id: clientId,
      client_name: body.client_name,
      redirect_uris: redirectUris,
    };
  }

  buildAuthorizeRedirectUrl(params: {
    client_id: string;
    redirect_uri: string;
    code_challenge: string;
    code_challenge_method: string;
    state?: string;
    scope?: string;
  }): string {
    const clientUrl = this.configService.getMcpClientUrl();

    // Encode the OAuth params into a base64 state payload for the consent page
    const consentState = Buffer.from(
      JSON.stringify({
        client_id: params.client_id,
        redirect_uri: params.redirect_uri,
        code_challenge: params.code_challenge,
        code_challenge_method: params.code_challenge_method,
        original_state: params.state,
        scope: params.scope,
      }),
    ).toString('base64url');

    return `${clientUrl}/mcp/authorize?state=${consentState}`;
  }

  async approveAuthorization(userId: string, consentState: string): Promise<{ redirectUri: string }> {
    let params: {
      client_id: string;
      redirect_uri: string;
      code_challenge: string;
      code_challenge_method: string;
      original_state?: string;
      scope?: string;
    };

    try {
      params = JSON.parse(Buffer.from(consentState, 'base64url').toString()) as typeof params;
    } catch {
      throw new BadRequestException('Invalid consent state');
    }

    // Validate client exists
    const client = await this.db.client.mcpClient.findUnique({
      where: { clientId: params.client_id },
    });

    if (!client) {
      throw new BadRequestException('Unknown client_id');
    }

    // Validate redirect URI if client has registered URIs
    if (client.redirectUris.length > 0 && !client.redirectUris.includes(params.redirect_uri)) {
      throw new BadRequestException('Invalid redirect_uri');
    }

    // Link client to the first user who authorizes it
    if (!client.userId) {
      await this.db.client.mcpClient.update({
        where: { id: client.id },
        data: { userId },
      });
    }

    // Generate authorization code and store in Redis
    const code = randomUUID();
    const scopes = params.scope ? params.scope.split(' ') : ['read:workbooks', 'read:files'];

    const storedCode: StoredAuthCode = {
      code,
      clientId: params.client_id,
      userId,
      codeChallenge: params.code_challenge,
      codeChallengeMethod: params.code_challenge_method,
      redirectUri: params.redirect_uri,
      scopes,
    };

    await this.redis.set(`${AUTH_CODE_PREFIX}${code}`, JSON.stringify(storedCode), 'EX', AUTH_CODE_TTL);

    // Build redirect back to Claude with the authorization code
    const redirectUrl = new URL(params.redirect_uri);
    redirectUrl.searchParams.set('code', code);
    if (params.original_state) {
      redirectUrl.searchParams.set('state', params.original_state);
    }

    return { redirectUri: redirectUrl.toString() };
  }

  async handleTokenRequest(body: {
    grant_type: string;
    code?: string;
    redirect_uri?: string;
    code_verifier?: string;
    client_id: string;
    refresh_token?: string;
  }): Promise<TokenResponse> {
    if (body.grant_type === 'authorization_code') {
      return this.exchangeCodeForToken(
        body as {
          grant_type: string;
          code: string;
          redirect_uri: string;
          code_verifier: string;
          client_id: string;
        },
      );
    }

    if (body.grant_type === 'refresh_token') {
      return this.refreshAccessToken(body.client_id, body.refresh_token);
    }

    throw new BadRequestException('Unsupported grant_type');
  }

  private async exchangeCodeForToken(body: {
    grant_type: string;
    code: string;
    redirect_uri: string;
    code_verifier: string;
    client_id: string;
  }): Promise<TokenResponse> {
    // Retrieve stored auth code from Redis
    const storedData = await this.redis.get(`${AUTH_CODE_PREFIX}${body.code}`);
    if (!storedData) {
      throw new UnauthorizedException('Invalid or expired authorization code');
    }

    // Delete code immediately (one-time use)
    await this.redis.del(`${AUTH_CODE_PREFIX}${body.code}`);

    const stored = JSON.parse(storedData) as StoredAuthCode;

    // Validate client_id matches
    if (stored.clientId !== body.client_id) {
      throw new UnauthorizedException('client_id mismatch');
    }

    // Validate redirect_uri matches
    if (stored.redirectUri !== body.redirect_uri) {
      throw new UnauthorizedException('redirect_uri mismatch');
    }

    // Validate PKCE code_verifier
    const expectedChallenge = createHash('sha256').update(body.code_verifier).digest('base64url');

    if (expectedChallenge !== stored.codeChallenge) {
      throw new UnauthorizedException('Invalid code_verifier');
    }

    return this.issueTokenPair(stored.userId, stored.clientId, stored.scopes);
  }

  private async refreshAccessToken(clientId: string, refreshToken?: string): Promise<TokenResponse> {
    if (!refreshToken) {
      throw new BadRequestException('refresh_token is required');
    }

    // Retrieve and delete the refresh token atomically (one-time use / rotation)
    const storedData = await this.redis.get(`${REFRESH_TOKEN_PREFIX}${refreshToken}`);
    if (!storedData) {
      throw new UnauthorizedException('Invalid or expired refresh token');
    }

    await this.redis.del(`${REFRESH_TOKEN_PREFIX}${refreshToken}`);

    const stored = JSON.parse(storedData) as StoredRefreshToken;

    if (stored.clientId !== clientId) {
      throw new UnauthorizedException('client_id mismatch');
    }

    WSLogger.info({
      source: 'McpOAuthService.refreshAccessToken',
      message: 'Refreshed MCP access token',
      userId: stored.userId,
    });

    return this.issueTokenPair(stored.userId, stored.clientId, stored.scopes);
  }

  private async issueTokenPair(userId: string, clientId: string, scopes: string[]): Promise<TokenResponse> {
    // Delete expired MCP tokens for this user
    await this.db.client.apiToken.deleteMany({
      where: { userId, type: TokenType.MCP, expiresAt: { lt: new Date() } },
    });

    // Create access token
    const accessToken = generateApiToken();
    const expiresAt = new Date(Date.now() + ACCESS_TOKEN_TTL * 1000);

    await this.db.client.apiToken.create({
      data: {
        id: createApiTokenId(),
        userId,
        token: accessToken,
        expiresAt,
        type: TokenType.MCP,
        scopes,
      },
    });

    // Create refresh token and store in Redis
    const refreshToken = randomUUID();
    const refreshData: StoredRefreshToken = { clientId, userId, scopes };

    await this.redis.set(
      `${REFRESH_TOKEN_PREFIX}${refreshToken}`,
      JSON.stringify(refreshData),
      'EX',
      REFRESH_TOKEN_TTL,
    );

    WSLogger.info({
      source: 'McpOAuthService.issueTokenPair',
      message: 'Issued MCP access token',
      userId,
      scopes,
    });

    return {
      access_token: accessToken,
      refresh_token: refreshToken,
      token_type: 'Bearer',
      expires_in: ACCESS_TOKEN_TTL,
      scope: scopes.join(' '),
    };
  }
}
