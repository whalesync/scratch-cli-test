import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import {
  ConnectorAuthErrorExceptionFilter,
  ConnectorInstantiationErrorExceptionFilter,
} from './exception-filters/connector.exception-filter';
import {
  BadRequestExceptionFilter,
  NotFoundExceptionFilter,
} from './exception-filters/generic-errors.exception-filter';
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

  const app = await NestFactory.create(AppModule, { bodyParser: false, bufferLogs: true });

  // Turn on class validation for body and URL params (DTOs).
  app.useGlobalPipes(new ValidationPipe());

  // Enable CORS
  app.enableCors({
    origin: '*', // Allow any origin for development
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Cache-Control', 'X-Requested-With'],
    exposedHeaders: ['Content-Type', 'Cache-Control', 'Content-Disposition'],
    credentials: true,
  });

  // Apply global logging interceptor
  app.useGlobalInterceptors(new LoggingInterceptor());

  // Apply global exception filters for connector errors
  app.useGlobalFilters(
    new BadRequestExceptionFilter(),
    new NotFoundExceptionFilter(),
    new ConnectorInstantiationErrorExceptionFilter(),
    new ConnectorAuthErrorExceptionFilter(),
  );

  app.useLogger(new WSLoggerShim());
  const port = process.env.PORT ?? 3010;
  WSLogger.info({ source: 'main', message: `==========================================` });
  WSLogger.info({ source: 'main', message: `Listening on port: ${port}` });
  WSLogger.info({ source: 'main', message: `Microservice Type: ${process.env.SERVICE_TYPE?.toUpperCase()}` });
  WSLogger.info({ source: 'main', message: `==========================================` });

  await app.listen(port);
  startupFinished = true;

  if (process.env.SERVER_STARTUP_CHECK) {
    WSLogger.info({ source: 'main', message: 'The app started up successfully! Exiting with return code 0.' });
    process.exit(0);
  }
}
void bootstrap();
