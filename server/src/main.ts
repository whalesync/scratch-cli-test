import { ShutdownSignal, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { ZodValidationPipe } from 'nestjs-zod';
import { AppModule } from './app.module';
import { ScratchConfigService } from './config/scratch-config.service';
import {
  ConnectorAuthErrorExceptionFilter,
  ConnectorInstantiationErrorExceptionFilter,
} from './exception-filters/connector.exception-filter';
import {
  BadRequestExceptionFilter,
  NotFoundExceptionFilter,
} from './exception-filters/generic-errors.exception-filter';
import { SyncExceptionFilter } from './exception-filters/sync.exception-filter';
import { ZodValidationExceptionFilter } from './exception-filters/zod-validation.exception-filter';
import { LoggingInterceptor } from './interceptors/logging.interceptor';
import { WSLogger, WSLoggerShim } from './logger';

/** Give our server a max amount of time to start before we fail. */
const STARTUP_TIMEOUT_SECONDS = 10;
const STARTUP_TIMEOUT_MS = STARTUP_TIMEOUT_SECONDS * 1000;

// Use a higher stack trace depth (number of lines) than the default of 10.
const STACK_TRACE_LIMIT = 20;

async function bootstrap(): Promise<void> {
  let startupFinished = false;

  setTimeout(() => {
    if (!startupFinished) {
      WSLogger.error({
        source: 'main',
        message: `Server failed to finish startup within ${STARTUP_TIMEOUT_SECONDS} seconds. Server will now exit.`,
      });
      process.exit(1);
    }
  }, STARTUP_TIMEOUT_MS);

  Error.stackTraceLimit = STACK_TRACE_LIMIT;

  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bodyParser: false, bufferLogs: true });

  // Trust the first proxy (load balancer) so that req.protocol and req.ip
  // reflect the original client request rather than the LB→server hop.
  // Without this, req.protocol is always 'http' behind TLS-terminating proxies,
  // which causes generated URLs (e.g. git clone URLs) to use http:// instead of https://.
  app.set('trust proxy', 1);

  // Turn on validation for body and URL params (DTOs).
  // - `ValidationPipe` validates class-validator DTOs (the existing pattern).
  // - `ZodValidationPipe` validates `createZodDto(...)` DTOs against their zod
  //   schema and passes every non-ZodDto metatype through untouched, so the two
  //   coexist and endpoints can migrate to zod one at a time.
  app.useGlobalPipes(new ValidationPipe(), new ZodValidationPipe());

  // Enable CORS — restrict to known client origins for the current environment.
  const clientOrigin = ScratchConfigService.getClientBaseUrl();
  WSLogger.info({ source: 'main', message: `CORS primary client origin: ${clientOrigin}` });
  app.enableCors({
    origin: ScratchConfigService.getCorsAllowedOrigins(),
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Cache-Control', 'X-Requested-With'],
    exposedHeaders: ['Content-Type', 'Cache-Control', 'Content-Disposition'],
    credentials: true,
  });

  // Apply global logging interceptor
  app.useGlobalInterceptors(new LoggingInterceptor());

  // Apply global exception filters for connector errors
  app.useGlobalFilters(
    // Must precede BadRequestExceptionFilter: ZodValidationException extends
    // BadRequestException, so the first matching filter in this list wins.
    new ZodValidationExceptionFilter(),
    new BadRequestExceptionFilter(),
    new NotFoundExceptionFilter(),
    new ConnectorInstantiationErrorExceptionFilter(),
    new ConnectorAuthErrorExceptionFilter(),
    new SyncExceptionFilter(),
  );

  app.useLogger(new WSLoggerShim());
  const port = process.env.PORT ?? 3010;
  WSLogger.info({ source: 'main', message: `==========================================` });
  WSLogger.info({ source: 'main', message: `Listening on port: ${port}` });
  WSLogger.info({ source: 'main', message: `Microservice Type: ${process.env.SERVICE_TYPE?.toUpperCase()}` });
  WSLogger.info({ source: 'main', message: `==========================================` });

  // Enable NestJS shutdown hooks so a Cloud Run SIGTERM (deploy / scale-down) runs the
  // destroy/shutdown lifecycle instead of hard-killing the process: the BullMQ worker drains
  // in-flight jobs (bounded — see QueueService.onModuleDestroy) and the Prisma / OTel-metrics
  // shutdown hooks flush cleanly. Without this, in-flight jobs are orphaned and re-dispatched as
  // stalls (DEV-11184). Scoped to the signals Cloud Run and local dev actually send.
  app.enableShutdownHooks([ShutdownSignal.SIGTERM, ShutdownSignal.SIGINT]);

  await app.listen(port);
  startupFinished = true;

  if (process.env.SERVER_STARTUP_CHECK) {
    WSLogger.info({ source: 'main', message: 'The app started up successfully! Exiting with return code 0.' });
    process.exit(0);
  }
}
void bootstrap();
