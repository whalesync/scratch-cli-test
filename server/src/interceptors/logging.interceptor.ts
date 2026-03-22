import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import type { Request } from 'express';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';
import { WSLogger } from '../logger';

@Injectable()
export class LoggingInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<Request>();
    const { method, url } = request;

    // Log the incoming request
    WSLogger.debug({
      source: 'RequestLog',
      message: url,
      method,
    });

    return next.handle().pipe(tap(() => {}));
  }
}
