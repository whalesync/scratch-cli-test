import {
  Body,
  ClassSerializerInterceptor,
  Controller,
  Param,
  Post,
  Req,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { OAuthInitiateOptionsDto, ValidatedOAuthInitiateOptionsDto } from '@spinner/shared-types';
import { ScratchAuthGuard } from '../auth/scratch-auth.guard';
import type { RequestWithUser } from '../auth/types';
import { userToActor } from '../users/types';
import type { OAuthCallbackRequest, OAuthInitiateResponse } from './oauth.service';
import { OAuthService } from './oauth.service';

@Controller('oauth')
@UseGuards(ScratchAuthGuard)
@UseInterceptors(ClassSerializerInterceptor)
export class OAuthController {
  constructor(private readonly oauthService: OAuthService) {}

  /**
   * Gets the OAuth authorization request redirect URL for a connector (service).
   */
  @Post(':service/initiate')
  async initiateOAuth(
    @Param('service') service: string,
    @Req() req: RequestWithUser,
    @Body() body: OAuthInitiateOptionsDto,
  ): Promise<OAuthInitiateResponse> {
    const dto = body as ValidatedOAuthInitiateOptionsDto;
    return this.oauthService.initiateOAuth(service, userToActor(req.user), dto);
  }

  @Post(':service/callback')
  async handleOAuthCallback(
    @Param('service') service: string,
    @Req() req: RequestWithUser,
    @Body() callbackData: OAuthCallbackRequest,
  ): Promise<{ connectorAccountId: string }> {
    return this.oauthService.handleOAuthCallback(service, userToActor(req.user), callbackData);
  }

  @Post('refresh')
  async refreshOAuthTokens(@Body() body: { connectorAccountId: string }): Promise<{ success: boolean }> {
    await this.oauthService.refreshOAuthTokens(body.connectorAccountId);
    return { success: true };
  }
}
