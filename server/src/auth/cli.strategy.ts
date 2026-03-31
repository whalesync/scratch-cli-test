import { BadRequestException, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { Request } from 'express';
import { Strategy } from 'passport-custom';

import { UsersService } from 'src/users/users.service';
import { AuthenticatedUser, CliConnectorCredentials } from './types';

/**
 * Extended Express Request type for CLI endpoints with optional connector credentials and user.
 */
interface CliRequestExtension extends Request {
  connectorCredentials?: CliConnectorCredentials;
  user?: AuthenticatedUser;
}

/**
 * This strategy inspects the request for a User-Agent header and validates it matches "Scratch-cli/1.0".
 * It also parses the optional X-Scratch-Connector header for connector credentials.
 * If an Authorization header with API-Token is present, it optionally loads the user.
 * This is a simple authentication mechanism for CLI requests.
 */
@Injectable()
export class CliStrategy extends PassportStrategy(Strategy, 'CLI_STRATEGY') {
  constructor(private readonly usersService: UsersService) {
    super();
  }

  async validate(req: Request): Promise<AuthenticatedUser | boolean> {
    const userAgent = req.headers['user-agent'];

    const ua = userAgent?.toLowerCase() ?? '';
    if (!ua.startsWith('scratch-cli/') && !ua.startsWith('scratchdesktop/') && !ua.includes('electron/')) {
      throw new UnauthorizedException('Invalid User-Agent');
    }

    // Cast to extended request type to attach connector credentials
    const cliReq = req as CliRequestExtension;

    // Parse optional X-Scratch-Connector header
    const connectorHeader = req.headers['x-scratch-connector'];
    if (connectorHeader) {
      const headerValue = Array.isArray(connectorHeader) ? connectorHeader[0] : connectorHeader;
      try {
        const parsed: unknown = JSON.parse(headerValue);
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
          throw new BadRequestException('X-Scratch-Connector header must contain a valid JSON object');
        }
        // Attach parsed credentials to the request object
        cliReq.connectorCredentials = parsed as CliConnectorCredentials;
      } catch (error) {
        if (error instanceof BadRequestException) {
          throw error;
        }
        throw new BadRequestException('X-Scratch-Connector header contains invalid JSON');
      }
    }

    // Load user from API token if Authorization header is present
    // Return the user so Passport attaches it to req.user
    const authHeader = req.headers['authorization'];
    if (authHeader && typeof authHeader === 'string' && authHeader.startsWith('API-Token ')) {
      const token = authHeader.slice('API-Token '.length);
      if (token) {
        const user = await this.usersService.getUserFromAPIToken(token);
        if (!user) {
          throw new ForbiddenException('Invalid or expired API token');
        }
        const tokenUsed = user.apiTokens.find((t) => t.token === token);
        const authenticatedUser: AuthenticatedUser = {
          ...user,
          authType: 'api-token',
          authSource: 'cli',
          apiToken: tokenUsed,
        };
        // Return the user - Passport will set req.user to this value
        return authenticatedUser;
      }
    }

    // No user authenticated, but request is valid
    return true;
  }
}
