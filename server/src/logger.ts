import { LoggerService } from '@nestjs/common';
import { networkInterfaces } from 'os';
import winston from 'winston';

type RequiredFields = { source: string; message: string };
type Fields = RequiredFields & Record<string, unknown>;

// Needs to match the NPM log level strings:
// https://github.com/winstonjs/winston?tab=readme-ov-file#logging-levels
export enum LogLevel {
  ERROR = 'error',
  WARN = 'warn',
  INFO = 'info',
  HTTP = 'http',
  VERBOSE = 'verbose',
  DEBUG = 'debug',
  SILLY = 'silly',
}

const nodeEnv = process.env.NODE_ENV ?? 'production';
const runningInCloud = process.env.RUNNING_IN_CLOUD === 'true';

const logFormatGcp = winston.format.combine(
  // By default Error objects do not spread properly into JSON, so we need to unpack them.
  expandedErrorsFormat(),
  // We need to manually add the severity field, using google's custom levels, to have it picked up in Logging.
  withGCSSeverityFormat(),
  winston.format.json(),
);
const logFormatPlain =
  nodeEnv === 'development'
    ? winston.format.combine(
        // By default Error objects do not spread properly into JSON, so we need to unpack them.
        expandedErrorsFormat(),
        winston.format.colorize(),
        winston.format.simple(),
      )
    : winston.format.combine(expandedErrorsFormat(), winston.format.simple());

const devLogFile = process.env.LOG_FILE
  ? new winston.transports.File({ filename: process.env.LOG_FILE, format: logFormatPlain })
  : null;

export class WSLogger {
  private static logger = winston.createLogger({
    level: 'info',
    transports: [
      new winston.transports.Console({
        format: runningInCloud ? logFormatGcp : logFormatPlain,
      }),
      ...(devLogFile ? [devLogFile] : []),
    ],
  });

  /** Static methods for convenience, don't DI this around, it's annoying. */
  private constructor() {}

  static error(data: Fields): void {
    this.logger.error(data);
  }

  static warn(data: Fields): void {
    this.logger.warn(data);
  }

  static info(data: Fields): void {
    this.logger.info(data);
  }

  static verbose(data: Fields): void {
    this.logger.verbose(data);
  }

  static debug(data: Fields): void {
    this.logger.debug(data);
  }

  /**
   * Note: looking up memory usage seems to take <2ms, usually <1ms, but that's not nothing!
   */
  static logMemoryStats(source: string): void {
    const usage = process.memoryUsage();
    this.info({
      source,
      message: 'Memory Usage Stats',
      rss: `${(usage.rss / 1024 / 1024).toPrecision(4)} MiB`,
      heapTotal: `${(usage.heapTotal / 1024 / 1024).toPrecision(4)} MiB`,
      heapUsed: `${(usage.heapUsed / 1024 / 1024).toPrecision(4)} MiB`,
      external: `${(usage.external / 1024 / 1024).toPrecision(4)} MiB`,
      arrayBuffers: `${(usage.arrayBuffers / 1024 / 1024).toPrecision(4)} MiB`,
    });
  }

  static async logIpAddresses(): Promise<void> {
    try {
      // Get our list of local IP addresses.
      const localInterfaces = networkInterfaces();
      const localAddresses = Object.entries(localInterfaces).flatMap(([interfaceName, details]) =>
        details?.map((detail) => `[${interfaceName}: ${detail.address}]`),
      );

      // Send out a ping to figure out our external IP address.
      const ipifyResponse = await fetch('https://api.ipify.org');
      const externalAddress = await ipifyResponse.text();
      this.info({ source: 'WSLogger.logIpAddresses', message: 'My IP addresses', localAddresses, externalAddress });
    } catch (e) {
      this.error({ source: 'Logger.logIpAddresses', message: 'Failed to get IP addresses', error: e });
    }
  }

  /** Only output this and lower. */
  static setOutputLevel(level: LogLevel): void {
    // Don't use the logger to log this!

    console.log('Setting log level to', level);
    this.logger.level = level;
  }
}

/**
 * Winston formatter to expand Error objects into their constituent parts.
 * By default, the JSON output stream just spreads objects, which turns Error into `{}` because it's weird.
 */
function expandedErrorsFormat(): winston.Logform.Format {
  return winston.format((info) => {
    for (const [key, value] of Object.entries(info)) {
      if (value instanceof Error) {
        info[key] = {
          ...value,
          name: value.name,
          message: value.message,
          stack: value.stack,
        };
      }
    }
    return info;
  })();
}

export class WSLoggerShim implements LoggerService {
  log(raw: unknown, ...optionalParams: unknown[]): void {
    WSLogger.info({ source: 'unknown', message: pickMessage(raw), raw, ...optionalParams });
  }

  error(raw: unknown, ...optionalParams: unknown[]): void {
    WSLogger.error({ source: 'unknown', message: pickMessage(raw), raw, ...optionalParams });
  }

  warn(raw: unknown, ...optionalParams: unknown[]): void {
    WSLogger.warn({ source: 'unknown', message: pickMessage(raw), raw, ...optionalParams });
  }

  debug(raw: unknown, ...optionalParams: unknown[]): void {
    WSLogger.debug({ source: 'unknown', message: pickMessage(raw), raw, ...optionalParams });
  }

  verbose(raw: unknown, ...optionalParams: unknown[]): void {
    WSLogger.verbose({ source: 'unknown', message: pickMessage(raw), raw, ...optionalParams });
  }

  fatal(raw: unknown, ...optionalParams: unknown[]): void {
    WSLogger.error({ source: 'unknown', message: pickMessage(raw), raw, ...optionalParams });
  }
}

function pickMessage(raw: unknown): string {
  if (typeof raw === 'string') {
    return raw;
  } else if (raw instanceof Error) {
    return raw.message;
  }
  return 'unknown';
}

function withGCSSeverityFormat(): winston.Logform.Format {
  return winston.format((info) => {
    info['severity'] = toGCSSeverity(info.level);

    // Tell GCP Error Reporting to bucket this as an error.
    // https://cloud.google.com/error-reporting/docs/formatting-error-messages
    if (info.level === 'error') {
      info['@type'] = 'type.googleapis.com/google.devtools.clouderrorreporting.v1beta1.ReportedErrorEvent';
    }
    return info;
  })();
}

function toGCSSeverity(level: string): string {
  switch (level) {
    case 'error':
      return 'ERROR';
    case 'warn':
      return 'WARNING';
    case 'info':
      return 'INFO';
    case 'http':
      return 'INFO';
    case 'verbose':
    case 'debug':
    case 'silly':
      return 'DEBUG';
    default:
      return 'DEFAULT';
  }
}
