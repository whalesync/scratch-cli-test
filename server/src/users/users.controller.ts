import {
  Body,
  ClassSerializerInterceptor,
  Controller,
  Get,
  HttpCode,
  NotFoundException,
  Patch,
  Post,
  Req,
  UnauthorizedException,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { BillableActions, ValidatedUpdateSettingsDto } from '@spinner/shared-types';
import { ScratchAuthGuard } from 'src/auth/scratch-auth.guard';
import type { RequestWithUser } from 'src/auth/types';
import { ScratchConfigService } from 'src/config/scratch-config.service';
import { ExperimentsService } from 'src/experiments/experiments.service';
import { ApiRateLimitGuard } from 'src/rate-limiter/api-rate-limit.guard';
import { SlackFormatters } from 'src/slack/slack-formatters';
import { SlackNotificationService } from 'src/slack/slack-notification.service';
import { UpdateSettingsDto } from './dto/update-settings.dto';
import { User } from './entities/user.entity';
import { SubscriptionService } from './subscription.service';
import { UsersService } from './users.service';

@Controller('users')
@UseGuards(ScratchAuthGuard, ApiRateLimitGuard)
@UseInterceptors(ClassSerializerInterceptor)
export class UsersController {
  constructor(
    private readonly usersService: UsersService,
    private readonly experimentsService: ExperimentsService,
    private readonly subscriptionService: SubscriptionService,
    private readonly slackNotificationService: SlackNotificationService,
  ) {}

  @Get('current')
  async currentUser(@Req() req: RequestWithUser): Promise<User> {
    if (!req.user) {
      throw new UnauthorizedException();
    }

    const flagValues = await this.experimentsService.resolveClientFeatureFlagsForUser(req.user);

    // Get monthly publish count for the organization
    const billableActions: BillableActions = {
      monthlyPublishCount: req.user.organizationId
        ? await this.subscriptionService.countMonthlyPublishActions(req.user.organizationId)
        : 0,
    };

    return new User(req.user, flagValues, billableActions);
  }

  @Patch('current/settings')
  @HttpCode(204)
  async updateUserSettings(@Req() req: RequestWithUser, @Body() updateSettingsDto: UpdateSettingsDto): Promise<void> {
    const dto = updateSettingsDto as ValidatedUpdateSettingsDto;
    const user = await this.usersService.findOne(req.user.id);

    if (!user) {
      throw new NotFoundException(`User ${req.user.id} not found`);
    }

    await this.usersService.updateUserSettings(user, dto);
  }

  @Post('current/api-token')
  async generateApiToken(@Req() req: RequestWithUser): Promise<{ apiToken: string }> {
    if (!req.user) {
      throw new UnauthorizedException();
    }

    const apiToken = await this.usersService.generateUserApiToken(req.user.id);
    return { apiToken };
  }

  @Patch('current/last-workbook')
  @HttpCode(204)
  async updateLastWorkbook(@Req() req: RequestWithUser, @Body() body: { workbookId: string | null }): Promise<void> {
    if (!req.user) {
      throw new UnauthorizedException();
    }

    await this.usersService.updateLastWorkbook(req.user.id, body.workbookId);
  }

  @Post('current/request-access')
  @HttpCode(204)
  async requestAccess(@Req() req: RequestWithUser): Promise<void> {
    if (!req.user) {
      throw new UnauthorizedException();
    }

    const approveUrl = `${ScratchConfigService.getClientBaseUrl()}/settings/dev/waitlist`;
    await this.slackNotificationService.sendMessage(SlackFormatters.waitlistAccessRequest(req.user, approveUrl));
  }
}
