import { Body, Controller, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type {
  ClaimInboundInstallResponse,
  PendingOAuthInstallInfo,
  RedeemInboundInstallResponse,
} from '@spinner/shared-types';
import { ScratchAuthGuard } from 'src/auth/scratch-auth.guard';
import type { RequestWithUser } from 'src/auth/types';
import { userToActor } from 'src/users/types';
import { RedeemInboundInstallDtoClass } from './dto/redeem-inbound-install.dto';
import { OAuthInstallService } from './oauth-install.service';

/**
 * Marketplace-initiated ("inbound") OAuth install endpoints — connector-agnostic.
 *
 * Separate from the app-initiated `OAuthController` because the redeem endpoint
 * must be PUBLIC (the public web page calls it pre-auth), whereas every route in
 * OAuthController is auth-gated. Keyed by `:service`, so any OAuth connector
 * (GoHighLevel, Webflow, …) reuses these routes and the web `/connect/[service]`
 * claim page with only a provider — no per-connector code.
 *
 * Like Scratch's app-initiated OAuth, the marketplace redirect lands on the WEB app
 * (`app.scratch.md/oauth/install/:service`), not this API host — that public page
 * posts the code here to redeem it. Keeping the redirect on the web host means the
 * `redirect_uri` we echo on the token exchange derives straight from `REDIRECT_URI`'s
 * origin (no API-host knowledge, no `x-forwarded` reconstruction).
 */
@Controller('oauth')
export class OAuthInstallController {
  constructor(
    private readonly oauthInstallService: OAuthInstallService,
    private readonly configService: ConfigService,
  ) {}

  /**
   * PUBLIC. Called (pre-auth) by the web `/oauth/install/[service]` page the
   * marketplace redirected to. Redeems the one-time `code` immediately (it expires
   * in minutes — can't survive a sign-up/login detour), stashes the tokens under an
   * unguessable `installId`, and returns it for the page to carry to the claim step.
   */
  @Post('install/:service')
  async redeemInboundInstall(
    @Param('service') service: string,
    @Body() body: RedeemInboundInstallDtoClass,
  ): Promise<RedeemInboundInstallResponse> {
    return this.oauthInstallService.redeemAndStashInstall(service, body.code, this.installRedirectUri(service));
  }

  /** AUTH. Claim-page metadata for a pending install (never returns tokens). */
  @UseGuards(ScratchAuthGuard)
  @Get('pending-install/:installId')
  async getPendingInstall(@Param('installId') installId: string): Promise<PendingOAuthInstallInfo> {
    return this.oauthInstallService.getPendingInstall(installId);
  }

  /** AUTH. An authenticated user claims the pending install (auto-creates a workbook). */
  @UseGuards(ScratchAuthGuard)
  @Post('pending-install/:installId/claim')
  async claimInboundInstall(
    @Param('installId') installId: string,
    @Req() req: RequestWithUser,
  ): Promise<ClaimInboundInstallResponse> {
    return this.oauthInstallService.claimInstall(installId, userToActor(req.user));
  }

  /**
   * The public URL the marketplace redirected the install `code` to — which the token
   * exchange must echo back as `redirect_uri` (OAuth requires them to match). The
   * redirect lives on the web app, so it's `<REDIRECT_URI origin>/oauth/install/:service`
   * (e.g. `https://app.scratch.md/oauth/install/gohighlevel`). This MUST equal the
   * redirect URL configured on the connector's marketplace listing.
   */
  private installRedirectUri(service: string): string {
    return `${this.clientOrigin()}/oauth/install/${encodeURIComponent(service)}`;
  }

  /**
   * The web app origin, derived from `REDIRECT_URI` (which already points at the web
   * app's `/oauth/callback`). Falls back to stripping the known callback suffix if
   * the value isn't a parseable URL.
   */
  private clientOrigin(): string {
    const redirectUri = this.configService.get<string>('REDIRECT_URI') ?? '';
    try {
      return new URL(redirectUri).origin;
    } catch {
      return redirectUri.replace(/\/oauth\/callback\/?$/, '');
    }
  }
}
