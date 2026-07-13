import type { ClerkClient } from '@clerk/backend';
import { verifyToken } from '@clerk/backend';
import { TokenVerificationError } from '@clerk/backend/errors';
import { CanActivate, ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { WsException } from '@nestjs/websockets';
import { ScratchConfigService } from 'src/config/scratch-config.service';
import { WSLogger } from 'src/logger';
import { UsersService } from 'src/users/users.service';
import { resolveImpersonatorFromActorClaim } from './impersonation';
import { AuthenticatedUser, ScratchJwtPayload, SocketWithUser } from './types';

@Injectable()
export class WebSocketAuthGuard implements CanActivate {
  constructor(
    @Inject('ClerkClient')
    private readonly clerkClient: ClerkClient,
    private readonly configService: ScratchConfigService,
    private readonly userService: UsersService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const client: SocketWithUser = context.switchToWs().getClient<SocketWithUser>();

    // 1. Extract the token from the handshake
    const token = client.handshake.auth?.token as string;

    if (!token) {
      WSLogger.error({ source: 'WsAuthGuard', message: 'No authentication token provided' });
      throw new WsException('Unauthorized: No token provided.');
    }

    // 2. First try API token authentication
    const apiTokenUser = await this.validateAPIToken(token);
    if (apiTokenUser) {
      client.user = apiTokenUser;
      return true;
    }

    // 3. Fall back to JWT authentication
    const jwtUser = await this.validateJWT(token);
    if (jwtUser) {
      client.user = jwtUser;
      return true;
    }

    // 4. If both fail, throw unauthorized
    WSLogger.error({ source: 'WsAuthGuard', message: 'Invalid authentication token' });
    throw new WsException('Unauthorized: Invalid token.');
  }

  private async validateAPIToken(token: string): Promise<AuthenticatedUser | null> {
    try {
      const user = await this.userService.getUserFromAPIToken(token);

      if (!user) {
        return null;
      }

      return {
        ...user,
        authType: 'api-token',
        authSource: 'user',
      };
    } catch (error) {
      WSLogger.error({
        source: 'WsAuthGuard',
        message: 'API token validation error',
        error,
      });
      return null;
    }
  }

  private async validateJWT(token: string): Promise<AuthenticatedUser | null> {
    try {
      const tokenPayload = (await verifyToken(token, {
        secretKey: this.configService.getClerkSecretKey(),
      })) as ScratchJwtPayload;

      // verifying the JWT is enough to validate the session, no need to fetch the user from clerk with every request
      // The `sub` field in the token payload is a clerk user id
      const user = await this.userService.getOrCreateUserFromClerk(tokenPayload.sub);

      if (!user) {
        return null;
      }

      const impersonator = await resolveImpersonatorFromActorClaim(tokenPayload, user, this.userService, 'WsAuthGuard');

      return {
        ...user,
        authType: 'jwt',
        authSource: 'user',
        impersonator,
      };
    } catch (error) {
      if (error instanceof TokenVerificationError) {
        WSLogger.error({
          source: 'WsAuthGuard',
          message: 'JWT token failed to verify',
          reason: error.reason,
          action: error.action,
        });
      } else {
        WSLogger.error({
          source: 'WsAuthGuard',
          message: 'JWT token validation error',
          error,
        });
      }
      return null;
    }
  }
}
