import { Controller, Get } from '@nestjs/common';
import { DesktopReleaseResponse } from '@spinner/shared-types';
import { DesktopReleaseService } from './desktop-release.service';

/**
 * Serves metadata for the latest Scratch Desktop release so the web client can render
 * a download page without talking to GitHub directly. Unauthenticated on purpose — the
 * download page is reachable before the user signs in.
 */
@Controller('desktop-release')
export class DesktopReleaseController {
  constructor(private readonly desktopReleaseService: DesktopReleaseService) {}

  @Get('latest')
  async getLatestDesktopRelease(): Promise<DesktopReleaseResponse> {
    return this.desktopReleaseService.getLatestDesktopRelease();
  }
}
