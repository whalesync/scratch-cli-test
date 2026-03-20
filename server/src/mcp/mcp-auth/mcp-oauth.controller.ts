import { Body, Controller, Get, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { ScratchAuthGuard } from 'src/auth/scratch-auth.guard';
import type { RequestWithUser } from 'src/auth/types';
import { McpOAuthService } from './mcp-oauth.service';

/**
 * OAuth 2.1 endpoints for MCP authentication.
 *
 * These endpoints implement the OAuth authorization server that Claude's MCP client
 * uses to authenticate users.
 */
@Controller()
export class McpOAuthController {
  constructor(private readonly mcpOAuthService: McpOAuthService) {}

  /**
   * OAuth Protected Resource Metadata (RFC 9728).
   * Claude discovers which authorization server protects the MCP endpoint.
   */
  @Get('.well-known/oauth-protected-resource')
  getProtectedResourceMetadata(): Record<string, unknown> {
    return this.mcpOAuthService.getProtectedResourceMetadata();
  }

  /**
   * OAuth Authorization Server Metadata (RFC 8414).
   * Claude discovers auth endpoints from this well-known URL.
   */
  @Get('.well-known/oauth-authorization-server')
  getMetadata(): Record<string, unknown> {
    return this.mcpOAuthService.getOAuthMetadata();
  }

  /**
   * Dynamic Client Registration (RFC 7591).
   * Claude calls this on first connect to get a client_id.
   */
  @Post('mcp-auth/register')
  async registerClient(
    @Body() body: { client_name?: string; redirect_uris?: string[] },
  ): Promise<{ client_id: string; client_name?: string; redirect_uris: string[] }> {
    return this.mcpOAuthService.registerClient(body);
  }

  /**
   * OAuth Authorization Endpoint.
   * Redirects the user to the consent page in the React client.
   */
  @Get('mcp-auth/authorize')
  authorize(
    @Query('client_id') clientId: string,
    @Query('redirect_uri') redirectUri: string,
    @Query('code_challenge') codeChallenge: string,
    @Query('code_challenge_method') codeChallengeMethod: string,
    @Query('state') state: string | undefined,
    @Query('scope') scope: string | undefined,
    @Res() res: Response,
  ): void {
    const redirectUrl = this.mcpOAuthService.buildAuthorizeRedirectUrl({
      client_id: clientId,
      redirect_uri: redirectUri,
      code_challenge: codeChallenge,
      code_challenge_method: codeChallengeMethod,
      state,
      scope,
    });

    res.redirect(302, redirectUrl);
  }

  /**
   * Consent approval endpoint. Called by the React consent page after the user
   * approves access. Requires Clerk authentication.
   */
  @Post('mcp-auth/approve')
  @UseGuards(ScratchAuthGuard)
  async approve(@Req() req: RequestWithUser, @Body() body: { state: string }): Promise<{ redirect_uri: string }> {
    const result = await this.mcpOAuthService.approveAuthorization(req.user.id, body.state);
    return { redirect_uri: result.redirectUri };
  }

  /**
   * OAuth Token Endpoint.
   * Exchanges an authorization code or refresh token for an access token.
   */
  @Post('mcp-auth/token')
  async token(
    @Body()
    body: {
      grant_type: string;
      code?: string;
      redirect_uri?: string;
      code_verifier?: string;
      client_id: string;
      refresh_token?: string;
    },
  ): Promise<{
    access_token: string;
    refresh_token: string;
    token_type: string;
    expires_in: number;
    scope: string;
  }> {
    return this.mcpOAuthService.handleTokenRequest(body);
  }
}
