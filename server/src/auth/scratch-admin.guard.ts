import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { timingSafeEqual } from 'crypto';
import { Request } from 'express';
import { ScratchConfigService } from 'src/config/scratch-config.service';

/**
 * Guards the internal Whalesync channel (`/internal/whalesync/*`), the server-to-server path Bottlenose
 * uses to provision shadow users and mint short-lived session tokens. Unlike {@link ScratchAuthGuard},
 * this is a shared-secret gate, not a Passport strategy: there is no user session to resolve, so it sets
 * no `req.user` and the guarded endpoints act on the user named in the request body.
 *
 * The presented `X-Scratch-Admin-Token` header is compared, in constant time, against the secrets from
 * {@link ScratchConfigService.getScratchAdminApiKeys} (current + optional previous, for rotation). When no
 * secret is configured the guard denies every request (fail closed).
 *
 * Hardening note: the `/internal/*` prefix should additionally be network/IP-restricted at ingress so a
 * leaked secret alone is insufficient (tracked as infra, not enforced here).
 */
@Injectable()
export class ScratchAdminGuard implements CanActivate {
  constructor(private readonly configService: ScratchConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const presentedToken = request.header('X-Scratch-Admin-Token');
    const acceptedTokens = this.configService.getScratchAdminApiKeys();

    if (!presentedToken || acceptedTokens.length === 0) {
      throw new UnauthorizedException('Invalid admin token');
    }

    // timingSafeEqual requires equal-length buffers; the length pre-check is not secret-dependent
    // (token length is not sensitive) and guards against the throw on mismatched buffer sizes.
    const presentedTokenBuffer = Buffer.from(presentedToken);
    const matchesAnAcceptedToken = acceptedTokens.some(
      (acceptedToken) =>
        acceptedToken.length === presentedToken.length &&
        timingSafeEqual(presentedTokenBuffer, Buffer.from(acceptedToken)),
    );

    if (!matchesAnAcceptedToken) {
      throw new UnauthorizedException('Invalid admin token');
    }

    return true;
  }
}
