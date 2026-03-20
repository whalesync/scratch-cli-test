import { CallHandler, ExecutionContext, Inject, Injectable, NestInterceptor } from '@nestjs/common';
import { TokenType } from '@spinner/shared-types';
import type { Request } from 'express';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';
import { AuthenticatedUser } from '../auth/types';
import { CustomMetric } from '../metrics/custom-metrics';
import { CustomMetricsService } from '../metrics/custom-metrics-service';
import { CustomMetricDimension } from '../metrics/types';

/**
 * Determines the auth source category for metrics from the authenticated request.
 * Categories: web (Clerk JWT or WebSocket token), cli, mcp, unauthenticated.
 */
function getAuthSource(request: Request): string {
  const user = (request as Request & { user?: AuthenticatedUser | boolean }).user;

  if (!user || typeof user === 'boolean') {
    return 'unauthenticated';
  }

  const authenticatedUser = user;

  // MCP token
  if (authenticatedUser.authSource === 'mcp' || authenticatedUser.apiToken?.type === (TokenType.MCP as string)) {
    return 'mcp';
  }

  // CLI source
  if (
    authenticatedUser.authSource === 'cli' ||
    (authenticatedUser.apiToken?.type === (TokenType.USER as string) &&
      authenticatedUser.apiToken.scopes?.includes('cli'))
  ) {
    return 'cli';
  }

  // Web: Clerk JWT or WebSocket API token
  return 'web';
}

@Injectable()
export class ApiRequestMetricsInterceptor implements NestInterceptor {
  constructor(@Inject(CustomMetricsService) private readonly metricsService: CustomMetricsService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    return next.handle().pipe(
      tap(() => {
        const request = context.switchToHttp().getRequest<Request>();
        const authSource = getAuthSource(request);
        this.metricsService.logValue(CustomMetric.API_REQUEST, 1, {
          name: CustomMetricDimension.AUTH_SOURCE,
          value: authSource,
        });
      }),
    );
  }
}
