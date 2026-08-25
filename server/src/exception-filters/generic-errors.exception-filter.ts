import { ArgumentsHost, BadRequestException, Catch, ExceptionFilter, NotFoundException } from '@nestjs/common';
import { Request, type Response } from 'express';
import { WSLogger } from 'src/logger';

// NOTE: These ExceptionFilters need to be registered in either main.ts or through a module.

@Catch(BadRequestException)
export class BadRequestExceptionFilter implements ExceptionFilter {
  catch(exception: BadRequestException, host: ArgumentsHost): void {
    const request = host.switchToHttp().getRequest<Request>();

    WSLogger.error({
      source: 'ExceptionFilters',
      message: `Caught BadRequestException`,
      error: exception.message,
      stack: exception.stack,
      method: request.method,
      path: request.url,
    });

    const response = host.switchToHttp().getResponse<Response>();
    response.status(exception.getStatus()).json(exception.getResponse());
  }
}

@Catch(NotFoundException)
export class NotFoundExceptionFilter implements ExceptionFilter {
  catch(exception: NotFoundException, host: ArgumentsHost): void {
    const request = host.switchToHttp().getRequest<Request>();

    // NestJS's built-in not-found handler throws NotFoundException with a message of the form
    // `Cannot ${METHOD} ${path}` for any unmatched route. These are overwhelmingly internet
    // vulnerability scanners probing for WordPress files, `.env`/`.git` secrets, and webshells,
    // so they are logged at WARN to keep them out of Cloud Error Reporting. A NotFoundException
    // thrown deliberately by application code carries its own message and stays at ERROR.
    const isUnmatchedRouteFromScannerTraffic = /^Cannot [A-Z]+ /.test(exception.message);

    const notFoundLogFields = {
      source: 'ExceptionFilters',
      message: `Caught NotFoundException`,
      error: exception.message,
      stack: exception.stack,
      method: request.method,
      path: request.url,
    };

    if (isUnmatchedRouteFromScannerTraffic) {
      WSLogger.warn(notFoundLogFields);
    } else {
      WSLogger.error(notFoundLogFields);
    }

    const response = host.switchToHttp().getResponse<Response>();
    response.status(exception.getStatus()).json(exception.getResponse());
  }
}
