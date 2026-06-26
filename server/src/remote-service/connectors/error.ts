import { InternalServerErrorException } from '@nestjs/common';
import { AxiosError, HttpStatusCode } from 'axios';
import _, { isString } from 'lodash';
import { Connector } from './connector';
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

/** Utility function to throw a standardised exception for a connector error. */
export function exceptionForConnectorError(error: unknown, connector: Connector): InternalServerErrorException {
  const details = connector.extractConnectorErrorDetails(error);
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
  if (error.response?.status === HttpStatusCode.Unauthorized) {
    return {
      userFriendlyMessage: ErrorMessageTemplates.API_UNAUTHORIZED(getServiceDisplayName(connector.service)),
      description: error.message,
      additionalContext: {
        status: error.response?.status,
        statusText: error.response?.statusText,
        url: error.config?.url,
      },
    };
  }

  if (error.response?.status === HttpStatusCode.Forbidden) {
    return {
      userFriendlyMessage: ErrorMessageTemplates.API_FORBIDDEN(getServiceDisplayName(connector.service)),
      description: error.message,
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
