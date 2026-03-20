import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { TokenType } from '@spinner/shared-types';
import { Request } from 'express';
import { AuthenticatedUser } from 'src/auth/types';
import { UsersService } from 'src/users/users.service';

/**
 * Guard that validates MCP Bearer tokens. Looks up the token in the ApiToken table
 * with type=MCP and validates it hasn't expired.
 */
@Injectable()
export class McpAuthGuard implements CanActivate {
  constructor(private readonly usersService: UsersService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const authHeader = request.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new UnauthorizedException('Missing or invalid Authorization header');
    }

    const token = authHeader.substring(7);
    const user = await this.usersService.getUserFromAPIToken(token);

    if (!user) {
      throw new UnauthorizedException('Invalid or expired MCP token');
    }

    // Verify the token is an MCP token
    const mcpToken = user.apiTokens.find((t) => t.token === token && t.type === (TokenType.MCP as string));
    if (!mcpToken) {
      throw new UnauthorizedException('Token is not an MCP token');
    }

    // Attach user to request
    (request as Request & { user: AuthenticatedUser }).user = {
      ...user,
      authType: 'api-token',
      authSource: 'mcp',
      apiToken: mcpToken,
    };

    return true;
  }
}
