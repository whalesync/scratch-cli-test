import { LoggerService } from '@nestjs/common';
import { AxiosError, isAxiosError } from 'axios';
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

  /** Whether a log line at the given level would currently be emitted. */
  static isLevelEnabled(level: LogLevel): boolean {
    return this.logger.isLevelEnabled(level);
  }

  /** Only output this and lower. */
  static setOutputLevel(level: LogLevel): void {
    // Don't use the logger to log this!

    console.log('Setting log level to', level);
    this.logger.level = level;
  }
}

/**
 * How many container levels below a top-level log field {@link expandedErrorsFormat} searches for AxiosErrors. Deeper
 * values are logged untouched: an AxiosError ten levels down is implausible, while blanking deep debug payloads would
 * visibly degrade the logs. Cycles are handled separately.
 */
const MAXIMUM_CONTAINER_DEPTH_SEARCHED_FOR_AXIOS_ERRORS_IN_A_LOG_FIELD = 10;

/**
 * Stands in for a reference back to a container that is still being walked. It is exactly what safe-stable-stringify
 * (behind logform's `json()` and `simple()`) prints for a cycle, so cyclic values log as before. The reference itself
 * can't be kept: once the walk copies that container, a kept reference points the serializer back at the ORIGINAL
 * container, raw AxiosError included.
 */
const CIRCULAR_REFERENCE_PLACEHOLDER_FOR_LOGS = '[Circular]';

/**
 * Stands in for a log field whose sanitizing threw (a throwing getter, a revoked Proxy, a bug here). Fails closed, and
 * keeps the exception away from the caller of `WSLogger.*`: winston-transport rethrows a format's error synchronously,
 * which inside a `catch` block would replace the error being handled.
 */
const UNLOGGABLE_LOG_FIELD_PLACEHOLDER = '[unloggable value]';

/** axios' own absolute-URL rule (`lib/helpers/isAbsoluteURL.js`): a `scheme://` or a protocol-relative `//`. */
const AXIOS_ABSOLUTE_URL_PATTERN = /^([a-z][a-z\d+\-.]*:)?\/\//i;

/** The scheme and host of an absolute URL: everything before its path, query or fragment. */
const ABSOLUTE_URL_SCHEME_AND_HOST_PATTERN = /^([a-z][a-z\d+\-.]*:)?\/\/[^/?#]*/i;

/**
 * A `user:password@` after a `//`. Greedy up to the last `@` before the next slash, which is where WHATWG URL parsing ends
 * the userinfo of `https://user:p@ss@host/`, and global, so an absolute URL appended to a `baseURL` is covered too.
 */
const URL_USERINFO_AFTER_DOUBLE_SLASH_PATTERN = /(\/\/)[^/\\]*@/g;

/** Ends a URL whose path {@link describeAxiosRequestUrlForLogs} withheld, so the log doesn't read as a request to `/`. */
const OMITTED_URL_PATH_MARKER = '/[path omitted]';

/** What the logs keep of an AxiosError. Names match `AxiosError#toJSON()` where they overlap, so log queries still work. */
interface LogSafeAxiosErrorSummary {
  name: string;
  message: string;
  code: string | undefined;
  status: number | undefined;
  method: string | undefined;
  url: string | undefined;
  stack: string | undefined;
}

/** The fields of an axios request config that say where the request went. */
interface AxiosRequestLocationFieldsForLogs {
  url?: unknown;
  baseURL?: unknown;
  allowAbsoluteUrls?: unknown;
}

/**
 * Winston formatter that makes every top-level log field serializable without leaking credentials:
 *  - An Error is expanded into its constituent parts. By default the JSON output stream just spreads objects, and an
 *    Error's `name`, `message` and `stack` aren't enumerable, so it would log as `{}`.
 *  - An AxiosError is reduced to {@link describeAxiosErrorForLogs} instead (DEV-12581). Its own `config` (headers and all,
 *    so `Authorization: Bearer <token>`), `request` (the raw header block) and `response` (both again) would otherwise be
 *    written out, and its `toJSON()` serializes `config` too.
 *  - An AxiosError nested anywhere below a field (an `HttpException`'s enumerable `cause` and `options.cause`,
 *    `{ details: { error } }`, an array, a class instance) is reduced the same way, see
 *    {@link replaceEveryAxiosErrorWithALogSafeSummary}.
 *
 * Must stay a TRANSPORT format: winston-transport hands it `Object.assign({}, info)`, so reassigning a top-level field
 * never touches the caller's object, whereas at the logger level `info` IS the caller's object. Nested containers are
 * copied, never mutated. Exported for tests.
 */
export function expandedErrorsFormat(): winston.Logform.Format {
  return winston.format((info) => {
    for (const [logFieldName, logFieldValue] of Object.entries(info)) {
      let logSafeLogFieldValue: unknown;
      try {
        logSafeLogFieldValue = toLogSafeTopLevelLogFieldValue(logFieldValue);
      } catch {
        logSafeLogFieldValue = UNLOGGABLE_LOG_FIELD_PLACEHOLDER;
      }
      if (logSafeLogFieldValue !== logFieldValue) {
        info[logFieldName] = logSafeLogFieldValue;
      }
    }
    return info;
  })();
}

/** One top-level log field made log-safe (see {@link expandedErrorsFormat}); the same reference when nothing changed. */
function toLogSafeTopLevelLogFieldValue(logFieldValue: unknown): unknown {
  if (logFieldValue instanceof Error && !isAxiosError(logFieldValue)) {
    const errorExpandedWithItsNonEnumerableFields = {
      ...logFieldValue,
      name: logFieldValue.name,
      message: logFieldValue.message,
      stack: logFieldValue.stack,
    };
    // The original error counts as an ancestor, so a property pointing back at it logs as a cycle.
    return replaceEveryAxiosErrorWithALogSafeSummary(
      errorExpandedWithItsNonEnumerableFields,
      MAXIMUM_CONTAINER_DEPTH_SEARCHED_FOR_AXIOS_ERRORS_IN_A_LOG_FIELD,
      new Set<object>([logFieldValue]),
    );
  }
  return replaceEveryAxiosErrorWithALogSafeSummary(
    logFieldValue,
    MAXIMUM_CONTAINER_DEPTH_SEARCHED_FOR_AXIOS_ERRORS_IN_A_LOG_FIELD,
    new Set<object>(),
  );
}

/**
 * `valueBeingLogged` with every AxiosError in it, itself included, replaced by {@link describeAxiosErrorForLogs}.
 * Copy-on-write: only the containers on the path to a replacement are shallowly copied, so the caller's objects are never
 * mutated, and a value with no AxiosError in it comes back as the very same reference. Walks exactly what the serializer
 * writes out property by property ({@link isWrittenOutPropertyByPropertyInLogs}), class instances and Errors included. A
 * nested non-Axios Error on a copied path is copied as its own enumerable properties only, which is all the serializer
 * ever printed of it.
 */
function replaceEveryAxiosErrorWithALogSafeSummary(
  valueBeingLogged: unknown,
  remainingContainerDepthToSearch: number,
  containersOnTheCurrentPathForCycleDetection: Set<object>,
): unknown {
  if (valueBeingLogged === null || typeof valueBeingLogged !== 'object') return valueBeingLogged;
  if (isAxiosError(valueBeingLogged)) return describeAxiosErrorForLogs(valueBeingLogged);
  if (containersOnTheCurrentPathForCycleDetection.has(valueBeingLogged)) return CIRCULAR_REFERENCE_PLACEHOLDER_FOR_LOGS;
  if (remainingContainerDepthToSearch <= 0 || !isWrittenOutPropertyByPropertyInLogs(valueBeingLogged)) {
    return valueBeingLogged;
  }

  containersOnTheCurrentPathForCycleDetection.add(valueBeingLogged);
  try {
    if (Array.isArray(valueBeingLogged)) {
      const arrayBeingLogged: readonly unknown[] = valueBeingLogged;
      let arrayCopyWithAxiosErrorsReplaced: unknown[] | undefined;
      for (let elementIndex = 0; elementIndex < arrayBeingLogged.length; elementIndex++) {
        const originalElement = arrayBeingLogged[elementIndex];
        const logSafeElement = replaceEveryAxiosErrorWithALogSafeSummary(
          originalElement,
          remainingContainerDepthToSearch - 1,
          containersOnTheCurrentPathForCycleDetection,
        );
        if (logSafeElement !== originalElement) {
          arrayCopyWithAxiosErrorsReplaced ??= arrayBeingLogged.slice();
          arrayCopyWithAxiosErrorsReplaced[elementIndex] = logSafeElement;
        }
      }
      return arrayCopyWithAxiosErrorsReplaced ?? arrayBeingLogged;
    }

    const objectBeingLogged = valueBeingLogged as Record<string, unknown>;
    let objectCopyWithAxiosErrorsReplaced: Record<string, unknown> | undefined;
    for (const propertyName of Object.keys(objectBeingLogged)) {
      const originalPropertyValue = objectBeingLogged[propertyName];
      const logSafePropertyValue = replaceEveryAxiosErrorWithALogSafeSummary(
        originalPropertyValue,
        remainingContainerDepthToSearch - 1,
        containersOnTheCurrentPathForCycleDetection,
      );
      if (logSafePropertyValue !== originalPropertyValue) {
        objectCopyWithAxiosErrorsReplaced ??= { ...objectBeingLogged };
        objectCopyWithAxiosErrorsReplaced[propertyName] = logSafePropertyValue;
      }
    }
    return objectCopyWithAxiosErrorsReplaced ?? objectBeingLogged;
  } finally {
    containersOnTheCurrentPathForCycleDetection.delete(valueBeingLogged);
  }
}

/**
 * Whether the log serializer (safe-stable-stringify) writes this object out as its own enumerable properties (plain
 * objects, arrays, Errors, class instances), which is how a nested AxiosError rides into a log line. Not when it uses
 * the object's `toJSON()` instead (Date, Buffer, AxiosHeaders, Decimal, URL), and not for typed arrays, whose elements
 * are only numbers.
 */
function isWrittenOutPropertyByPropertyInLogs(candidate: object): boolean {
  if (ArrayBuffer.isView(candidate)) return false;
  return typeof (candidate as { toJSON?: unknown }).toJSON !== 'function';
}

/**
 * The log-safe stand-in for an AxiosError: which request failed (its method, and the URL from
 * {@link describeAxiosRequestUrlForLogs}) and how (code, status, message, stack). Drops `config` (its headers hold the
 * live `Authorization`, and it also carries `auth` and the request body), `request` (its raw header block) and `response`
 * (config and request again, plus a body that may echo credentials).
 *
 * Every field is type-checked: `isAxiosError` only tests `payload.isAxiosError === true`, so spread copies and
 * lookalikes get here too. There is deliberately no `isAxiosError` field, so a summary that reaches the formatter again
 * isn't summarized a second time, which would lose its method and URL.
 */
function describeAxiosErrorForLogs(axiosError: AxiosError): LogSafeAxiosErrorSummary {
  const failedRequestConfigIfAny: unknown = axiosError.config;
  const failedRequestConfig =
    typeof failedRequestConfigIfAny === 'object' && failedRequestConfigIfAny !== null
      ? (failedRequestConfigIfAny as AxiosRequestLocationFieldsForLogs & { method?: unknown })
      : undefined;
  const failedRequestMethodIfAny = failedRequestConfig?.method;
  const responseStatusIfAny: unknown = axiosError.response?.status ?? axiosError.status;
  return {
    name: typeof axiosError.name === 'string' ? axiosError.name : 'AxiosError',
    message: typeof axiosError.message === 'string' ? axiosError.message : '',
    code: typeof axiosError.code === 'string' ? axiosError.code : undefined,
    status: typeof responseStatusIfAny === 'number' ? responseStatusIfAny : undefined,
    method: typeof failedRequestMethodIfAny === 'string' ? failedRequestMethodIfAny.toUpperCase() : undefined,
    url: failedRequestConfig ? describeAxiosRequestUrlForLogs(failedRequestConfig) : undefined,
    stack: typeof axiosError.stack === 'string' ? axiosError.stack : undefined,
  };
}

/**
 * Where a failed axios request went, as far as it is safe to log. Never its query or fragment, which is where API keys,
 * signatures and OAuth codes travel. Dropping all of it is deliberate: this is the safety net for errors nobody curated,
 * so it can't rely on a list of sensitive parameter names. Never a `user:pass@` either.
 *  - The request's `url` was appended to the client's `baseURL` (how every connector calls its endpoints): the joined
 *    URL, path included, since the path names the endpoint.
 *  - The request was handed a whole absolute URL (a webhook, an OAuth or pagination link, an asset download): only the
 *    scheme and host, then {@link OMITTED_URL_PATH_MARKER}. Such a path can be the credential itself, as a Slack incoming
 *    webhook's is.
 *  - Neither: undefined.
 */
function describeAxiosRequestUrlForLogs(failedRequestConfig: AxiosRequestLocationFieldsForLogs): string | undefined {
  const requestedUrl = typeof failedRequestConfig.url === 'string' ? failedRequestConfig.url : '';
  const baseUrl = typeof failedRequestConfig.baseURL === 'string' ? failedRequestConfig.baseURL : '';
  const isRequestedUrlAbsolute = AXIOS_ABSOLUTE_URL_PATTERN.test(requestedUrl);
  // Same rule as axios' `buildFullPath`.
  const isRequestedUrlAppendedToBaseUrl =
    baseUrl !== '' && (!isRequestedUrlAbsolute || failedRequestConfig.allowAbsoluteUrls === false);

  if (isRequestedUrlAppendedToBaseUrl) {
    const fullRequestUrl =
      requestedUrl === '' ? baseUrl : `${baseUrl.replace(/\/+$/, '')}/${requestedUrl.replace(/^\/+/, '')}`;
    const fullRequestUrlWithoutQueryOrFragment = fullRequestUrl.split(/[?#]/, 1)[0];
    return fullRequestUrlWithoutQueryOrFragment.replace(URL_USERINFO_AFTER_DOUBLE_SLASH_PATTERN, '$1');
  }

  const requestedUrlSchemeAndHost = isRequestedUrlAbsolute
    ? ABSOLUTE_URL_SCHEME_AND_HOST_PATTERN.exec(requestedUrl)?.[0]
    : undefined;
  if (!requestedUrlSchemeAndHost) return undefined;
  return requestedUrlSchemeAndHost.replace(URL_USERINFO_AFTER_DOUBLE_SLASH_PATTERN, '$1') + OMITTED_URL_PATH_MARKER;
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
