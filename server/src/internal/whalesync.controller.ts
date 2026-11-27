import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Put, UseGuards } from '@nestjs/common';
import { ScratchAdminGuard } from 'src/auth/scratch-admin.guard';
import { ScratchConfigService } from 'src/config/scratch-config.service';
import { WSLogger } from 'src/logger';
import {
  WhalesyncListLiveExportsResponse,
  WhalesyncLiveExportAccessDto,
  WhalesyncSessionResponse,
  WhalesyncSetLiveExportAccessResponse,
  WhalesyncShadowUserDto,
  WhalesyncUpdateSubscriptionDto,
  WhalesyncUpdateSubscriptionResponse,
} from './dto/whalesync-internal.dto';
import { WhalesyncInternalService } from './whalesync-internal.service';

const LOG_SOURCE = 'WhalesyncController';

/**
 * Internal, admin-only endpoints for the Whalesync → Scratch integration. Guarded by
 * {@link ScratchAdminGuard} (shared-secret `X-Scratch-Admin-Token`) — deliberately NOT `ScratchAuthGuard`
 * (there is no user session) and NOT `ApiRateLimitGuard` (server-to-server, and the limiter only acts on
 * `api-token` requests anyway). Bottlenose is the only caller. The global ZodValidationPipe enforces the request
 * bodies and strips keys the schemas don't name.
 *
 * A shadow user holds the Live Exports of one Whalesync team (DEV-13019), and every route names it by team. Scratch
 * knows nothing about the people in a team. Whalesync decides what the team's Live Exports may do and sends it as the
 * team's Live Export access (DEV-12983); Scratch never reads a Whalesync subscription.
 */
@Controller('internal/whalesync')
@UseGuards(ScratchAdminGuard)
export class WhalesyncController {
  constructor(private readonly whalesyncInternalService: WhalesyncInternalService) {}

  /**
   * Ensure the team's shadow user exists, apply the Live Export access the session carries, and mint a 10-minute
   * session token for it. Idempotent on `whalesyncTeamId`.
   */
  @Post('sessions')
  async createSession(@Body() body: WhalesyncShadowUserDto): Promise<WhalesyncSessionResponse> {
    // Local-dev only: keep request bodies out of cloud logs.
    if (ScratchConfigService.getScratchEnvironment() === 'development') {
      WSLogger.info({
        source: LOG_SOURCE,
        message: 'POST /internal/whalesync/sessions',
        requestBody: body,
      });
    }
    const result = await this.whalesyncInternalService.ensureSessionForWhalesyncTeam(
      body.whalesyncTeamId,
      body.name,
      body.liveExportAccess,
      body.subscription,
    );
    return {
      scratchUserId: result.scratchUserId,
      apiToken: result.apiToken,
      expiresAt: result.expiresAt.toISOString(),
    };
  }

  /**
   * Set the team's Live Export access: whether its Live Exports are paused, how many records they may hold, and how
   * fast they may run on a schedule (DEV-12983). Pausing refuses every run and leaves schedules as they are, so the
   * same call with `paused: false` resumes them. Idempotent; a team with no shadow user gets `updated: false`, and
   * nothing is created.
   */
  @Put('teams/:whalesyncTeamId/live-export-access')
  async setTeamLiveExportAccess(
    @Param('whalesyncTeamId') whalesyncTeamId: string,
    @Body() body: WhalesyncLiveExportAccessDto,
  ): Promise<WhalesyncSetLiveExportAccessResponse> {
    // Local-dev only, same as `createSession` above — keep request bodies out of cloud logs.
    if (ScratchConfigService.getScratchEnvironment() === 'development') {
      WSLogger.info({
        source: LOG_SOURCE,
        message: `PUT /internal/whalesync/teams/${whalesyncTeamId}/live-export-access`,
        requestBody: body,
      });
    }
    return this.whalesyncInternalService.setLiveExportAccessForWhalesyncTeam(whalesyncTeamId, body);
  }

  /**
   * The old way to set the team's Live Export access, from a Whalesync backend before DEV-12983 MR 3.2: the
   * subscription payload is mapped onto an access (paused unless its status is `active`). Idempotent if the team has
   * no shadow user.
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
    return this.whalesyncInternalService.updateWhalesyncSubscription(body.whalesyncTeamId, body.subscription);
  }

  /** List a team's Live Exports, newest first. Returns an empty list if the team has no shadow user. */
  @Get('teams/:whalesyncTeamId/live-exports')
  async listTeamLiveExports(
    @Param('whalesyncTeamId') whalesyncTeamId: string,
  ): Promise<WhalesyncListLiveExportsResponse> {
    return this.whalesyncInternalService.listLiveExportsForWhalesyncTeam(whalesyncTeamId);
  }

  /**
   * Deprovision a team's shadow user: delete it with its organization and Live Exports. Idempotent if the team has no
   * shadow user.
   */
  @Delete('teams/:whalesyncTeamId')
  @HttpCode(204)
  async deprovisionTeam(@Param('whalesyncTeamId') whalesyncTeamId: string): Promise<void> {
    await this.whalesyncInternalService.deprovisionWhalesyncTeam(whalesyncTeamId);
  }
}
