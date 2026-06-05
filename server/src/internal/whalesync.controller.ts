import { Body, Controller, Delete, HttpCode, Param, Post, UseGuards } from '@nestjs/common';
import { ScratchAdminGuard } from 'src/auth/scratch-admin.guard';
import {
  WhalesyncRevokeSessionsResponse,
  WhalesyncSessionResponse,
  WhalesyncShadowUserDto,
  WhalesyncUserResponse,
} from './dto/whalesync-internal.dto';
import { WhalesyncInternalService } from './whalesync-internal.service';

/**
 * Internal, admin-only endpoints for the Whalesync → Scratch integration. Guarded by
 * {@link ScratchAdminGuard} (shared-secret `X-Scratch-Admin-Token`) — deliberately NOT `ScratchAuthGuard`
 * (there is no user session) and NOT `ApiRateLimitGuard` (server-to-server, and the limiter only acts on
 * `api-token` requests anyway). Bottlenose is the only caller. The global ValidationPipe enforces the
 * required `WhalesyncShadowUserDto` fields, so handlers can trust `whalesyncUserId`/`email` are present.
 */
@Controller('internal/whalesync')
@UseGuards(ScratchAdminGuard)
export class WhalesyncController {
  constructor(private readonly whalesyncInternalService: WhalesyncInternalService) {}

  /** Ensure the shadow user exists and mint a 10-minute session token. Idempotent on `whalesyncUserId`. */
  @Post('sessions')
  async createSession(@Body() body: WhalesyncShadowUserDto): Promise<WhalesyncSessionResponse> {
    const result = await this.whalesyncInternalService.ensureSessionForWhalesyncUser(
      body.whalesyncUserId,
      body.email,
      body.name,
    );
    return {
      scratchUserId: result.scratchUserId,
      apiToken: result.apiToken,
      expiresAt: result.expiresAt.toISOString(),
    };
  }

  /** Ensure (create-if-missing) a shadow user without minting a token. For eager provisioning. */
  @Post('users')
  async ensureUser(@Body() body: WhalesyncShadowUserDto): Promise<WhalesyncUserResponse> {
    return this.whalesyncInternalService.ensureWhalesyncUser(body.whalesyncUserId, body.email, body.name);
  }

  /** Bulk-revoke a shadow user's session tokens (logout). Idempotent if the user does not exist. */
  @Delete('users/:whalesyncUserId/sessions')
  async revokeSessions(@Param('whalesyncUserId') whalesyncUserId: string): Promise<WhalesyncRevokeSessionsResponse> {
    return this.whalesyncInternalService.revokeSessionsForWhalesyncUser(whalesyncUserId);
  }

  /** Deprovision a shadow user (workbooks, org, user, tokens). Idempotent if the user does not exist. */
  @Delete('users/:whalesyncUserId')
  @HttpCode(204)
  async deprovisionUser(@Param('whalesyncUserId') whalesyncUserId: string): Promise<void> {
    await this.whalesyncInternalService.deprovisionWhalesyncUser(whalesyncUserId);
  }
}
