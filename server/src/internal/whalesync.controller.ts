import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { ScratchAdminGuard } from 'src/auth/scratch-admin.guard';
import { ScratchConfigService } from 'src/config/scratch-config.service';
import { WSLogger } from 'src/logger';
import {
  WhalesyncClearSubscriptionResponse,
  WhalesyncListLiveExportsResponse,
  WhalesyncRevokeSessionsResponse,
  WhalesyncSessionResponse,
  WhalesyncShadowUserDto,
  WhalesyncUpdateSubscriptionDto,
  WhalesyncUpdateSubscriptionResponse,
  WhalesyncUserResponse,
} from './dto/whalesync-internal.dto';
import { WhalesyncInternalService } from './whalesync-internal.service';

const LOG_SOURCE = 'WhalesyncController';

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
    // Local-dev only: the body carries the shadow user's email/name, which we don't want in cloud logs.
    if (ScratchConfigService.getScratchEnvironment() === 'development') {
      WSLogger.info({
        source: LOG_SOURCE,
        message: 'POST /internal/whalesync/sessions',
        requestBody: body,
      });
    }
    const result = await this.whalesyncInternalService.ensureSessionForWhalesyncUser(
      body.whalesyncUserId,
      body.email,
      body.name,
      body.subscription,
    );
    return {
      scratchUserId: result.scratchUserId,
      apiToken: result.apiToken,
      expiresAt: result.expiresAt.toISOString(),
    };
  }

  /**
   * Apply a Whalesync subscription status change (expire / cancel / upgrade) to the shadow user's Whalesync
   * plan. Returns 409 if the user holds a real Scratch Stripe subscription (only a `WHALESYNC_PLAN` row is
   * mutated). Idempotent if the user does not exist.
   */
  @Patch('subscription')
  async updateSubscription(@Body() body: WhalesyncUpdateSubscriptionDto): Promise<WhalesyncUpdateSubscriptionResponse> {
    // Local-dev only, same as `createSession` above — keep request bodies out of cloud logs.
    if (ScratchConfigService.getScratchEnvironment() === 'development') {
      WSLogger.info({
        source: LOG_SOURCE,
        message: 'PATCH /internal/whalesync/subscription',
        requestBody: body,
      });
    }
    return this.whalesyncInternalService.updateWhalesyncSubscription(body.whalesyncUserId, body.subscription);
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

  /**
   * List a shadow user's Live Exports, newest first, for Whalesync's admin dev tools. Returns an empty list if
   * the user does not exist (never creates one).
   */
  @Get('users/:whalesyncUserId/live-exports')
  async listLiveExports(@Param('whalesyncUserId') whalesyncUserId: string): Promise<WhalesyncListLiveExportsResponse> {
    return this.whalesyncInternalService.listLiveExportsForWhalesyncUser(whalesyncUserId);
  }

  /**
   * Clear a shadow user's internal Whalesync-plan subscription (revoke the free access granted for
   * their Whalesync subscription). Returns 409 if the user has a real Scratch Stripe subscription.
   * Idempotent if the user does not exist or has no Whalesync plan.
   */
  @Delete('users/:whalesyncUserId/subscription')
  async clearSubscription(
    @Param('whalesyncUserId') whalesyncUserId: string,
  ): Promise<WhalesyncClearSubscriptionResponse> {
    return this.whalesyncInternalService.clearWhalesyncSubscriptionForWhalesyncUser(whalesyncUserId);
  }

  /** Deprovision a shadow user (workbooks, org, user, tokens). Idempotent if the user does not exist. */
  @Delete('users/:whalesyncUserId')
  @HttpCode(204)
  async deprovisionUser(@Param('whalesyncUserId') whalesyncUserId: string): Promise<void> {
    await this.whalesyncInternalService.deprovisionWhalesyncUser(whalesyncUserId);
  }
}
