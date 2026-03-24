import {
  BadRequestException,
  Body,
  ClassSerializerInterceptor,
  Controller,
  Post,
  Req,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { CliAuthGuard } from 'src/auth/cli-auth.guard';
import { ScratchAuthGuard } from 'src/auth/scratch-auth.guard';
import type { RequestWithUser } from 'src/auth/types';
import { ApiRateLimitGuard } from 'src/rate-limiter/api-rate-limit.guard';
import { CliAuthService } from './cli-auth.service';
import {
  AuthInitiateResponseDto,
  AuthPollRequestDto,
  AuthPollResponseDto,
  AuthVerifyRequestDto,
  AuthVerifyResponseDto,
} from './dtos/cli-auth.dto';

/**
 * Controller for CLI authorization flow.
 * Similar to gcloud auth login - user authorizes CLI via browser.
 *
 * Flow:
 * 1. CLI calls POST /cli/v1/auth/initiate - gets userCode and pollingCode
 * 2. CLI opens browser to verification URL, displays userCode
 * 3. User logs in via Clerk on web, enters userCode
 * 4. Web calls POST /cli/v1/auth/verify with userCode (requires Clerk JWT)
 * 5. CLI polls POST /cli/v1/auth/poll with pollingCode until approved
 * 6. CLI receives API token and stores it locally
 */
@Controller('cli/v1/auth')
@UseInterceptors(ClassSerializerInterceptor)
export class CliAuthController {
  constructor(private readonly cliAuthService: CliAuthService) {}

  /**
   * Initiate authorization flow.
   * Called by CLI to get user code and polling code.
   * Protected by CLI auth guard (User-Agent check).
   */
  @Post('initiate')
  @UseGuards(CliAuthGuard)
  async initiateAuth(): Promise<AuthInitiateResponseDto> {
    return this.cliAuthService.initiateAuth();
  }

  /**
   * Poll for authorization status.
   * Called by CLI to check if user has approved.
   * Protected by CLI auth guard (User-Agent check).
   */
  @Post('poll')
  @UseGuards(CliAuthGuard)
  async pollAuth(@Body() dto: AuthPollRequestDto): Promise<AuthPollResponseDto> {
    if (!dto.pollingCode) {
      throw new BadRequestException('Polling code is required');
    }
    return this.cliAuthService.pollAuth(dto.pollingCode);
  }

  /**
   * Verify user code and approve authorization.
   * Called from web UI by logged-in user.
   * Protected by Scratch auth guard (requires Clerk JWT).
   */
  @Post('verify')
  @UseGuards(ScratchAuthGuard, ApiRateLimitGuard)
  async verifyAuth(@Req() req: RequestWithUser, @Body() dto: AuthVerifyRequestDto): Promise<AuthVerifyResponseDto> {
    if (!dto.userCode) {
      throw new BadRequestException('User code is required');
    }
    return this.cliAuthService.verifyAuth(dto.userCode, req.user.id);
  }
}
