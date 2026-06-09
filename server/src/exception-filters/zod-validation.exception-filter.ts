import { ArgumentsHost, Catch, ExceptionFilter, HttpStatus } from '@nestjs/common';
import { Request, type Response } from 'express';
import { ZodValidationException } from 'nestjs-zod';
import { WSLogger } from 'src/logger';
import { ZodError } from 'zod';

/**
 * Maps nestjs-zod's `ZodValidationException` into Scratch's standard API error
 * envelope so that zod-validated endpoints return the same shape the rest of the
 * app does (`message` + `userFacingMessage`), rather than nestjs-zod's default
 * `{ message: 'Validation failed', errors }` body.
 *
 * `ZodValidationException` extends `BadRequestException`, so this filter must be
 * registered BEFORE `BadRequestExceptionFilter` in `main.ts` for it to win the
 * match — otherwise the generic BadRequest filter would catch it first.
 */
@Catch(ZodValidationException)
export class ZodValidationExceptionFilter implements ExceptionFilter {
  catch(exception: ZodValidationException, host: ArgumentsHost): void {
    const request = host.switchToHttp().getRequest<Request>();

    const zodError = exception.getZodError();
    const issues = zodError instanceof ZodError ? zodError.issues : [];

    // Build a human-readable, user-facing message like
    // "returnPath: Expected string, received number; planType: Required".
    const userFacingMessage = issues.length
      ? issues.map((issue) => `${issue.path.map(String).join('.') || '(body)'}: ${issue.message}`).join('; ')
      : 'The submitted data was invalid.';

    WSLogger.error({
      source: 'ExceptionFilters',
      message: 'Caught ZodValidationException',
      error: userFacingMessage,
      stack: exception.stack,
      method: request.method,
      path: request.url,
    });

    const response = host.switchToHttp().getResponse<Response>();
    response.status(HttpStatus.BAD_REQUEST).json({
      statusCode: HttpStatus.BAD_REQUEST,
      error: 'Bad Request',
      message: userFacingMessage,
      userFacingMessage,
      issues,
    });
  }
}
