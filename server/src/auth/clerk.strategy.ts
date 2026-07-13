import type { ClerkClient } from '@clerk/backend';
import { verifyToken } from '@clerk/backend';
import { TokenVerificationError } from '@clerk/backend/errors';
import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import type { Request } from 'express';
import { Strategy } from 'passport-custom';
import { ScratchConfigService } from 'src/config/scratch-config.service';
import { UserCluster } from 'src/db/cluster-types';
import { WSLogger } from 'src/logger';
import { UsersService } from 'src/users/users.service';
import { resolveImpersonatorFromActorClaim } from './impersonation';
import { AuthenticatedUser, ScratchJwtPayload } from './types';

@Injectable()
export class ClerkStrategy extends PassportStrategy(Strategy, 'clerk') {
  constructor(
    @Inject('ClerkClient')
    private readonly clerkClient: ClerkClient,
    private readonly configService: ScratchConfigService,
    private readonly userService: UsersService,
  ) {
    super();
  }

  async validate(req: Request): Promise<AuthenticatedUser> {
    const parts = req.headers.authorization?.split(' ');

    const tokenPrefix = parts?.[0];

    const token = parts?.[1];

    if (!token || tokenPrefix !== 'Bearer') {
      throw new UnauthorizedException('No token provided');
    }

    let scratchPayload: ScratchJwtPayload;
    try {
      const jwtPayload = await verifyToken(token, {
        secretKey: this.configService.getClerkSecretKey(),
      });
      scratchPayload = jwtPayload as ScratchJwtPayload;
    } catch (error) {
      if (error instanceof TokenVerificationError) {
        WSLogger.error({
          source: 'ClerkStrategy',
          message: 'JWT token failed to verify',
          reason: error.reason,
          action: error.action,
        });
      } else {
        WSLogger.error({
          source: 'ClerkStrategy',
          message: 'JWT token validation error',
          error,
        });
      }

      throw new UnauthorizedException('Invalid JWT token');
    }

    let user: UserCluster.User | null = null;
    try {
      user = await this.userService.getOrCreateUserFromClerk(
        scratchPayload.sub,
        scratchPayload.fullName,
        scratchPayload.primaryEmail,
      );
    } catch (error) {
      WSLogger.error({
        source: 'ClerkStrategy',
        message: 'Error querying database for user',
        error,
      });
      throw new UnauthorizedException('Error loading user');
    }

    if (!user) {
      throw new UnauthorizedException('No Scratch user found');
    }

    const impersonator = await resolveImpersonatorFromActorClaim(
      scratchPayload,
      user,
      this.userService,
      'ClerkStrategy',
    );

    return {
      ...user,
      authType: 'jwt',
      authSource: 'user',
      impersonator,
    };
  }
}
