import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ScratchAdminGuard } from 'src/auth/scratch-admin.guard';
import { ScratchConfigService } from 'src/config/scratch-config.service';
import { WSLogger } from 'src/logger';
import {
  WhalesyncClearSubscriptionResponse,
  WhalesyncLinkTeamsDto,
  WhalesyncLinkTeamsResponse,
  WhalesyncListLiveExportsResponse,
  WhalesyncPendingTeamLinksResponse,
  WhalesyncRevokeSessionsResponse,
  WhalesyncSessionResponse,
  WhalesyncShadowUserDto,
  WhalesyncUpdateSubscriptionDto,
  WhalesyncUpdateSubscriptionResponse,
  WhalesyncUserResponse,
} from './dto/whalesync-internal.dto';
import { WhalesyncInternalService } from './whalesync-internal.service';

const LOG_SOURCE = 'WhalesyncController';

/** The team a session or shadow user request names, or undefined when it names only a person. */
function teamOfShadowUserRequest(
  body: WhalesyncShadowUserDto,
): { whalesyncTeamId: string; actingUserIsTeamsOnlyMember: boolean } | undefined {
  return body.whalesyncTeamId
    ? {
        whalesyncTeamId: body.whalesyncTeamId,
        actingUserIsTeamsOnlyMember: body.whalesyncUserIsTeamsOnlyMember === true,
      }
    : undefined;
}

/**
 * Internal, admin-only endpoints for the Whalesync → Scratch integration. Guarded by
 * {@link ScratchAdminGuard} (shared-secret `X-Scratch-Admin-Token`) — deliberately NOT `ScratchAuthGuard`
 * (there is no user session) and NOT `ApiRateLimitGuard` (server-to-server, and the limiter only acts on
 * `api-token` requests anyway). Bottlenose is the only caller. The global ValidationPipe enforces the
 * required `WhalesyncShadowUserDto` fields, so handlers can trust `whalesyncUserId`/`email` are present.
 *
 * A shadow user holds the Live Exports of one Whalesync team (DEV-13019). The `teams/:whalesyncTeamId` routes and a
 * `whalesyncTeamId` in a body name it by team. The `users/:whalesyncUserId` routes name it by the person it was made
 * for before teams, and stay until Whalesync no longer calls them. Where a team route takes a `whalesyncUserId`
 * query parameter, it is the team's one member, used to find a shadow user that has no team id yet.
 */
@Controller('internal/whalesync')
@UseGuards(ScratchAdminGuard)
export class WhalesyncController {
  constructor(private readonly whalesyncInternalService: WhalesyncInternalService) {}

  /**
   * Ensure the shadow user exists and mint a 10-minute session token. Idempotent on `whalesyncTeamId`, or on
   * `whalesyncUserId` when the body names no team.
   */
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
      teamOfShadowUserRequest(body),
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
    return this.whalesyncInternalService.updateWhalesyncSubscription(
      { whalesyncTeamId: body.whalesyncTeamId, whalesyncUserId: body.whalesyncUserId },
      body.subscription,
    );
  }

  /** Ensure (create-if-missing) a shadow user without minting a token. For eager provisioning. */
  @Post('users')
  async ensureUser(@Body() body: WhalesyncShadowUserDto): Promise<WhalesyncUserResponse> {
    return this.whalesyncInternalService.ensureWhalesyncUser(
      body.whalesyncUserId,
      body.email,
      body.name,
      undefined,
      teamOfShadowUserRequest(body),
    );
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

  /** List a team's Live Exports, newest first. Returns an empty list if the team has no shadow user. */
  @Get('teams/:whalesyncTeamId/live-exports')
  async listTeamLiveExports(
    @Param('whalesyncTeamId') whalesyncTeamId: string,
    @Query('whalesyncUserId') whalesyncUserIdOfTeamsOnlyMember?: string,
  ): Promise<WhalesyncListLiveExportsResponse> {
    return this.whalesyncInternalService.listLiveExportsForWhalesyncTeam(
      whalesyncTeamId,
      whalesyncUserIdOfTeamsOnlyMember || undefined,
    );
  }

  /**
   * Deprovision the Scratch user that holds a team's Live Exports: delete a pure shadow user, unlink a real Scratch
   * account. Idempotent if the team has no shadow user.
   */
  @Delete('teams/:whalesyncTeamId')
  @HttpCode(204)
  async deprovisionTeam(
    @Param('whalesyncTeamId') whalesyncTeamId: string,
    @Query('whalesyncUserId') whalesyncUserIdOfTeamsOnlyMember?: string,
  ): Promise<void> {
    await this.whalesyncInternalService.deprovisionWhalesyncTeam(
      whalesyncTeamId,
      whalesyncUserIdOfTeamsOnlyMember || undefined,
    );
  }

  /**
   * The Whalesync user ids of shadow users that have no team id yet, a page at a time: pass the last id of a page
   * as `after`. Whalesync answers with each one's team on `POST team-links`.
   */
  @Get('team-links/pending')
  async listPendingTeamLinks(@Query('after') after?: string): Promise<WhalesyncPendingTeamLinksResponse> {
    return this.whalesyncInternalService.listPendingTeamLinks(after || undefined);
  }

  /** Record the team of each shadow user made before teams. Idempotent; a link that can't be made is reported. */
  @Post('team-links')
  @HttpCode(200)
  async linkTeams(@Body() body: WhalesyncLinkTeamsDto): Promise<WhalesyncLinkTeamsResponse> {
    return this.whalesyncInternalService.linkTeams(body.links);
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

  /**
   * Deprovision the Scratch user linked to a Whalesync user. A pure shadow user is deleted (workbooks, org, user,
   * tokens). A real Scratch account is only unlinked: its Live Exports, Whalesync plan, and session tokens go, and the
   * user, org, and native workbooks stay. Idempotent if the user does not exist or is already unlinked.
   */
  @Delete('users/:whalesyncUserId')
  @HttpCode(204)
  async deprovisionUser(@Param('whalesyncUserId') whalesyncUserId: string): Promise<void> {
    await this.whalesyncInternalService.deprovisionWhalesyncUser(whalesyncUserId);
  }
}
