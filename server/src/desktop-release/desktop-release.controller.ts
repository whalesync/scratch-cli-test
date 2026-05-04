import { Controller, Get } from '@nestjs/common';
import { DesktopReleaseResponse } from '@spinner/shared-types';
import { DesktopReleaseService } from './desktop-release.service';

/**
 * Serves metadata for the latest Scratch Desktop and Scratch CLI releases so the web client
 * can render download/install pages without talking to GitHub directly. Unauthenticated on
 * purpose — the download pages are reachable before the user signs in.
 */
@Controller('desktop-release')
export class DesktopReleaseController {
  constructor(private readonly desktopReleaseService: DesktopReleaseService) {}

  @Get('latest')
  async getLatestDesktopRelease(): Promise<DesktopReleaseResponse> {
    return this.desktopReleaseService.getLatestDesktopRelease();
  }

  @Get('cli/latest')
  async getLatestCliRelease(): Promise<DesktopReleaseResponse> {
    return this.desktopReleaseService.getLatestCliRelease();
  }
}
