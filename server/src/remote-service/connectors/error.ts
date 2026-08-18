import { InternalServerErrorException } from '@nestjs/common';
import { AxiosError, HttpStatusCode, isAxiosError } from 'axios';
import _, { isString } from 'lodash';
import { WSLogger } from '../../logger';
import { Connector } from './connector';
import { describeRequestUrlForLogging } from './connector-http-logging';
import { getServiceDisplayName } from './display-names';
import { ConnectorErrorDetails } from './types';

// Handled with exception filter in exception-filters module
export class ConnectorInstantiationError extends Error {
  public readonly service: string;
  constructor(message: string, service: string, cause?: Error) {
    super(message, { cause });
    this.name = 'ConnectorInstantiationError';
    this.service = service;
  }
}

// Handled with exception filter in exception-filters module
export class ConnectorAuthError extends Error {
  public readonly userFriendlyMessage: string;
  public readonly service: string;
  constructor(message: string, userFriendlyMessage: string, service: string, cause?: Error) {
    super(message, { cause });
    this.name = 'ConnectorAuthError';
    this.userFriendlyMessage = userFriendlyMessage;
    this.service = service;
  }
}

// Use for asserting that an exception has a userFriendlyMessage attached
export interface UserFriendlyError extends Error {
  userFriendlyMessage: string;
}

export function isUserFriendlyError(error: unknown): error is UserFriendlyError {
  return error instanceof Error && 'userFriendlyMessage' in error;
}

/**
 * Thrown by a connector's `updateRecords` / `createRecords` when a user's
 * publish payload changes a field the service treats as read-only / non-writable.
 *
 * Per the product principle "Surface failures; never silently succeed" (root
 * `CLAUDE.md`) and the connector guide ("Do NOT silently strip read-only
 * fields"), a connector must NOT quietly drop such an edit and report success.
 * It throws this instead, which the publish runner routes through the normal
 * per-record failure path (`failed-patches.json` / "Publish failed"), exactly
 * like a service-side rejection of a writable field. Affinity is the reference
 * implementation.
 *
 * The message is service-agnostic on purpose: each connector's
 * `extractConnectorErrorDetails` fallback prefixes the service name (e.g.
 * "Airtable error: Field …"), so the message must not repeat it.
 */
export class ReadonlyFieldEditError extends Error implements UserFriendlyError {
  public readonly userFriendlyMessage: string;
  constructor(message: string) {
    super(message);
    this.name = 'ReadonlyFieldEditError';
    this.userFriendlyMessage = message;
  }
}

/**
 * Build the standard user-facing message for {@link ReadonlyFieldEditError}.
 * Service-agnostic — the connector error-detail fallback adds the service name.
 */
export function readonlyFieldEditErrorMessage(readonlyFieldNames: string[]): string {
  const quotedFieldNames = readonlyFieldNames.map((fieldName) => `"${fieldName}"`).join(', ');
  const isPlural = readonlyFieldNames.length > 1;
  return (
    `${isPlural ? 'Fields' : 'Field'} ${quotedFieldNames} ${isPlural ? 'are' : 'is'} read-only and cannot be published. ` +
    `Undo the change to ${isPlural ? 'these fields' : 'this field'}, then publish again.`
  );
}

export class ErrorMessageTemplates {
  // API issues.
  static readonly API_UNAUTHORIZED = (serviceName: string) =>
    `The credentials Scratch uses to communicate with ${serviceName} are no longer valid.`;
  static readonly API_FORBIDDEN = (serviceName: string) =>
    `Scratch's connection to ${serviceName} doesn't have permission to perform this action. You may need to reconnect it and grant the required permissions.`;
  static readonly API_QUOTA_EXCEEDED = (serviceName: string) =>
    `You have exceeded the service API quota for ${serviceName}.`;
  static readonly API_TIMEOUT = (serviceName: string) => `Request to ${serviceName} timed out. Please try again.`;
  static readonly RESPONSE_TOO_LARGE = (serviceName: string) => `Response from ${serviceName} is too large to process.`;
  static readonly UNKNOWN_ERROR = (serviceName: string) =>
    `An unknown error occurred while connecting to ${serviceName}.`;
}

/**
 * True when `error` is the service rejecting our credentials rather than the
 * request failing on our side — HTTP 401 (the token is not valid) or 403 (the
 * token is valid but lacks the scope/permission the call needs).
 *
 * Both are user-fixable *connection* problems, so they must never surface as a
 * 500: a customer whose Webflow token was generated without `cms:read` got an
 * opaque "Couldn't load tables" on every attempt, with nothing logged and no
 * hint that regenerating the token would fix it (DEV-11321).
 */
export function isConnectorCredentialRejection(error: unknown): boolean {
  return (
    isAxiosError(error) &&
    (error.response?.status === HttpStatusCode.Unauthorized || error.response?.status === HttpStatusCode.Forbidden)
  );
}

/**
 * Convert a connector error into the exception the HTTP layer should throw.
 *
 * Credential rejections (401/403) become a {@link ConnectorAuthError}, which
 * `ConnectorAuthErrorExceptionFilter` renders as a 400 carrying the
 * user-friendly message — the user can act on "reconnect and grant the required
 * permissions"; they cannot act on a 500. Everything else stays an
 * `InternalServerErrorException`, as before.
 *
 * Every connector error is logged here. Both branches produce an exception that
 * Nest's default filter does not log, so without this line an entire class of
 * customer-facing failure is invisible in prod — DEV-11321 produced 59 failed
 * requests over five hours and not one application log line.
 */
export function exceptionForConnectorError(
  error: unknown,
  connector: Connector,
): InternalServerErrorException | ConnectorAuthError {
  const details = connector.extractConnectorErrorDetails(error);
  const isCredentialRejection = isConnectorCredentialRejection(error);

  // NEVER pass the raw `error` to the logger. `expandedErrorsFormat` (logger.ts)
  // expands an Error by spreading its own enumerable properties, and an
  // `AxiosError` carries `config` — whose `headers.Authorization` the shared
  // api-client interceptor has already set to the customer's live token by the
  // time the request fails. Under the cloud JSON format that writes the
  // credential straight into Cloud Logging, on every connector failure, with
  // 401/403 being precisely where a valid credential is in play. Log a curated
  // set of fields instead, and route the URL through the redaction helper the
  // outbound-HTTP logger already uses (some APIs take credentials in the query
  // string).
  WSLogger.error({
    source: 'exceptionForConnectorError',
    message: `${connector.service} connector call failed: ${details.userFriendlyMessage}`,
    service: connector.service,
    isCredentialRejection,
    errorMessage: error instanceof Error ? error.message : String(error),
    errorDescription: details.description,
    stack: error instanceof Error ? error.stack : undefined,
    ...(isAxiosError(error)
      ? {
          status: error.response?.status,
          method: error.config?.method,
          url: error.config ? describeRequestUrlForLogging(error.config) : undefined,
        }
      : {}),
  });

  if (isCredentialRejection) {
    // `message` is deliberately the user-friendly text, NOT `details.description`.
    // Callers outside the HTTP layer read `.message` and show it verbatim: a failed
    // pull job stores it as the job's `failedReason` (`bull-worker.service.ts`),
    // which the web client renders as "Pull failed: <failedReason>" and the desktop
    // publish modal renders raw. `description` can be as unhelpful as "Request
    // failed with status code 401" for any service whose body this file can't
    // mine, so using it here would degrade those surfaces. The HTTP layer is
    // unaffected either way — `ConnectorAuthErrorExceptionFilter` renders
    // `userFriendlyMessage` — and the raw error is logged in full just above.
    return new ConnectorAuthError(
      details.userFriendlyMessage,
      details.userFriendlyMessage,
      connector.service,
      error instanceof Error ? error : undefined,
    );
  }

  return new InternalServerErrorException(details.userFriendlyMessage, {
    cause: error as Error,
    description: details.description,
    ...details.additionalContext,
  });
}

/*
 * Utilities to extract error messages from Axios errors for internally built Rest API clients like Airtable.
 */
function isContentLengthExceededError(error: AxiosError): boolean {
  return error.code === 'ERR_BAD_RESPONSE' && error.message.includes('maxContentLength size');
}

/**
 * The longest service-supplied explanation we are willing to paste into a
 * user-facing message. Anything longer is almost certainly an HTML error page or
 * a stack dump rather than a sentence written for a human.
 */
const MAX_SERVICE_PROVIDED_MESSAGE_LENGTH = 300;

/**
 * Where services put the human-readable half of an auth failure, most specific
 * first, so a descriptive sentence wins over a terse code. Webflow uses top-level
 * `message`; Airtable nests it (`{"error":{"type":"AUTHENTICATION_REQUIRED",
 * "message":…}}`) — mining only the top level silently produced nothing for the
 * nested shapes, which is how "Request failed with status code 401" ended up
 * standing in for a real explanation. OAuth-style bodies pair a terse `error`
 * code with a prose `error_description`, so `error` is checked last.
 */
const SERVICE_AUTH_MESSAGE_BODY_PATHS = ['message', 'error.message', 'error_description', 'error'];

/**
 * The service's own explanation of an auth failure, read from the **response
 * body only**.
 *
 * This is the part worth showing the user: Webflow answers a scope-deficient
 * token with `{"message":"OAuthForbidden: You are missing the following scopes -
 * 'cms:read'","code":"missing_scopes"}`, which names the exact fix. Our generic
 * "you may need to reconnect" template alone leaves them guessing (DEV-11321).
 *
 * Deliberately does NOT fall back to `statusText`: appending "Forbidden" to a
 * sentence that already says the connection lacks permission adds noise, not
 * information. Returns `undefined` when the body carries nothing usable.
 */
function serviceProvidedAuthMessage(error: AxiosError): string | undefined {
  const responseBody = error.response?.data;
  const candidate = isString(responseBody)
    ? responseBody
    : SERVICE_AUTH_MESSAGE_BODY_PATHS.map((path): unknown => _.get(responseBody, path)).find((value): value is string =>
        isString(value),
      );

  if (!candidate) {
    return undefined;
  }
  const trimmed = candidate.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_SERVICE_PROVIDED_MESSAGE_LENGTH || trimmed.startsWith('<')) {
    return undefined;
  }
  return trimmed;
}

/** Append the service's own auth-failure explanation to `template`, when it offered one. */
function withServiceProvidedAuthDetail(template: string, error: AxiosError, serviceName: string): string {
  const serviceMessage = serviceProvidedAuthMessage(error);
  return serviceMessage ? `${template} ${serviceName} says: ${serviceMessage}` : template;
}

/**
 * Evaluates an Axios error from a connector and attempts return error details for common scenarios like unauthorized, timeout, etc.
 * @param connector - The connector that the error occurred for.
 * @param error - The error to extract the message from.
 * @returns A common object describing the error for the user. or null if no common details are found.
 */
export function extractCommonDetailsFromAxiosError(
  connector: Connector,
  error: AxiosError,
): ConnectorErrorDetails | null {
  // 401 (invalid/expired token) and 403 (valid token, insufficient permission —
  // e.g. an OAuth connection missing a required scope) are distinct problems and
  // need distinct guidance: 401 → reconnect/refresh credentials; 403 → the
  // connection lacks permission for this action (often a missing scope).
  const serviceDisplayName = getServiceDisplayName(connector.service);

  if (error.response?.status === HttpStatusCode.Unauthorized) {
    return {
      userFriendlyMessage: withServiceProvidedAuthDetail(
        ErrorMessageTemplates.API_UNAUTHORIZED(serviceDisplayName),
        error,
        serviceDisplayName,
      ),
      description: serviceProvidedAuthMessage(error) ?? error.message,
      additionalContext: {
        status: error.response?.status,
        statusText: error.response?.statusText,
        url: error.config?.url,
      },
    };
  }

  if (error.response?.status === HttpStatusCode.Forbidden) {
    return {
      userFriendlyMessage: withServiceProvidedAuthDetail(
        ErrorMessageTemplates.API_FORBIDDEN(serviceDisplayName),
        error,
        serviceDisplayName,
      ),
      description: serviceProvidedAuthMessage(error) ?? error.message,
      additionalContext: {
        status: error.response?.status,
        statusText: error.response?.statusText,
        url: error.config?.url,
      },
    };
  }

  if (
    error.response?.status === HttpStatusCode.RequestTimeout ||
    error.response?.status === HttpStatusCode.GatewayTimeout ||
    error.code === 'ECONNABORTED'
  ) {
    return {
      userFriendlyMessage: ErrorMessageTemplates.API_TIMEOUT(getServiceDisplayName(connector.service)),
      description: error.message,
      additionalContext: {
        status: error.response?.status,
        statusText: error.response?.statusText,
        url: error.config?.url,
      },
    };
  }

  return null;
}

/**
 * Extracts the error message from an Axios error. This is used for internally built Rest API clients like Airtable.
 * @param service - The service that the error occurred for.
 * @param error - The error to extract the message from.
 * @param errorKeys - Optional. A list of keys to search for in the response data to pull a message from.
 * @returns The error message. or a default if no message is found.
 */
export function extractErrorMessageFromAxiosError(
  service: string,
  error: AxiosError,
  errorKeys: string[] = [],
): string {
  // In order of preference:
  // - error.response.data[any key in errorKeys (or `data` itself if the errorKey is '')]
  // - error.response.statusText
  // - generic fallback
  for (const key of errorKeys) {
    const responseMessage = key === '' ? error.response?.data : (_.get(error.response?.data, key) as unknown);
    if (!responseMessage) {
      continue;
    }
    if (isString(responseMessage)) {
      return responseMessage;
    }
    if (typeof responseMessage === 'object') {
      return JSON.stringify(responseMessage);
    }
  }

  const statusText = error.response?.statusText;
  if (statusText) {
    return statusText;
  }
  if (isContentLengthExceededError(error)) {
    return ErrorMessageTemplates.RESPONSE_TOO_LARGE(getServiceDisplayName(service));
  }

  return ErrorMessageTemplates.UNKNOWN_ERROR(getServiceDisplayName(service));
}
