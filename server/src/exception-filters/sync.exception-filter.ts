import { ArgumentsHost, Catch, ExceptionFilter, HttpStatus } from '@nestjs/common';
import { ConstantTypeMismatchError, SyncMappingNormalizeError, SyncMappingVersionError } from '@spinner/shared-types';
import { Request, type Response } from 'express';
import { WSLogger } from 'src/logger';

// NOTE: This ExceptionFilter is registered in main.ts (see useGlobalFilters).

/**
 * Errors raised while normalizing or validating a Sync's mapping JSON.
 *
 * `SyncMappingNormalizeError` / `SyncMappingVersionError` are thrown by
 * `transformV1ToV2` on the read/execute path (e.g. the `sync-one-record`
 * endpoint) when a stored v1 mapping is structurally corrupt or carries an
 * unknown version. `ConstantTypeMismatchError` is thrown by the save path
 * when a constant column mapping's literal value conflicts with its
 * destination column's type.
 *
 * Without this filter all three surface as opaque HTTP 500 "Internal server
 * error" bodies; here they become stable, machine-readable responses with a
 * known `error` code (and `syncId` for the read/execute errors so ops can
 * correlate them to a specific sync).
 */
type SyncMappingException = SyncMappingNormalizeError | SyncMappingVersionError | ConstantTypeMismatchError;

interface MappedSyncException {
  status: number;
  body: Record<string, unknown>;
}

@Catch(SyncMappingNormalizeError, SyncMappingVersionError, ConstantTypeMismatchError)
export class SyncExceptionFilter implements ExceptionFilter {
  catch(exception: SyncMappingException, host: ArgumentsHost): void {
    const request = host.switchToHttp().getRequest<Request>();
    const response = host.switchToHttp().getResponse<Response>();

    // syncId is a route param on the per-sync endpoints
    // (/workbooks/:workbookId/syncs/:syncId/...). It is absent on create
    // (POST .../syncs); null there is correct and expected.
    const syncId = (request.params.syncId as string | undefined) ?? null;

    const { status, body } = this.mapException(exception, syncId);

    WSLogger.error({
      source: 'SyncExceptionFilter',
      message: `Caught ${exception.name}`,
      error: exception.message,
      stack: exception.stack,
      method: request.method,
      path: request.url,
      syncId,
    });

    response.status(status).json(body);
  }

  private mapException(exception: SyncMappingException, syncId: string | null): MappedSyncException {
    if (exception instanceof SyncMappingNormalizeError) {
      return {
        status: HttpStatus.INTERNAL_SERVER_ERROR,
        body: { error: 'SYNC_MAPPING_NORMALIZE_FAILED', syncId, detail: exception.detail },
      };
    }

    if (exception instanceof SyncMappingVersionError) {
      return {
        status: HttpStatus.INTERNAL_SERVER_ERROR,
        body: { error: 'SYNC_MAPPING_UNKNOWN_VERSION', syncId, version: exception.receivedVersion },
      };
    }

    // ConstantTypeMismatchError — the only remaining member of the union.
    return {
      status: HttpStatus.BAD_REQUEST,
      body: {
        error: 'INVALID_CONSTANT_TYPE',
        destinationColumnId: exception.destinationColumnId,
        expected: exception.expected,
        got: exception.got,
      },
    };
  }
}
