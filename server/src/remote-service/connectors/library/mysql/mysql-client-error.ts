import { type ConnectorErrorCode } from '@spinner/shared-types';
import { type UserFriendlyError } from '../../error';

/**
 * Every failure the MySQL connector raises itself (as opposed to errors the MySQL server or the network
 * returns). The problem code is for tests and logs; users only ever see `userFriendlyMessage`.
 */
export enum MySqlClientProblem {
  /** The per-connection `SET SESSION time_zone / sql_mode` failed, so the connection can't be used safely. */
  SessionSetupFailed = 'SESSION_SETUP_FAILED',
  InvalidFilter = 'INVALID_FILTER',
  InvalidModifiedAtField = 'INVALID_MODIFIED_AT_FIELD',
  TableNotFound = 'TABLE_NOT_FOUND',
  /** The table's storage engine can't roll back a partly-applied write (MyISAM, MEMORY, ...). */
  UnsupportedStorageEngine = 'UNSUPPORTED_STORAGE_ENGINE',
  /** Creates need MySQL to generate the id (AUTO_INCREMENT) so the new row can be read back. */
  CreateRequiresAutoIncrementId = 'CREATE_REQUIRES_AUTO_INCREMENT_ID',
  InsertIdMissing = 'INSERT_ID_MISSING',
  InsertCountMismatch = 'INSERT_COUNT_MISMATCH',
  UpdateMatchedMultipleRows = 'UPDATE_MATCHED_MULTIPLE_ROWS',
  DeleteMatchedMultipleRows = 'DELETE_MATCHED_MULTIPLE_ROWS',
  /** An update matched no row: the record was deleted (or its id changed) in MySQL since the last pull. */
  RecordNotFound = 'RECORD_NOT_FOUND',
  /**
   * An update's change set edits the id column. The row is found by its id, so publishing the new value would
   * update whichever row already has it (or none) instead of this record's row.
   */
  IdColumnEdited = 'ID_COLUMN_EDITED',
  /**
   * A pull returned two rows with the same id: the table's chosen ID field isn't unique, so rows sharing a value
   * would collapse into one record.
   */
  PulledDuplicateId = 'PULLED_DUPLICATE_ID',
  InvalidTemporalValue = 'INVALID_TEMPORAL_VALUE',
  NonStringTemporalValue = 'NON_STRING_TEMPORAL_VALUE',
  /** A schema-creation request that can't be carried out as asked (no database chosen, a system database, ...). */
  InvalidSchemaCreationRequest = 'INVALID_SCHEMA_CREATION_REQUEST',
}

/**
 * The single error class for connector-raised MySQL failures. `message === userFriendlyMessage` on purpose:
 * several surfaces (`connector-account.service.ts` health messages, job `failedReason`) store `error.message`
 * verbatim, so it must never carry SQL, bound values, IPs or credentials.
 */
export class MySqlClientError extends Error implements UserFriendlyError {
  public readonly userFriendlyMessage: string;
  public readonly errorCode?: ConnectorErrorCode;

  constructor(
    public readonly problem: MySqlClientProblem,
    userFriendlyMessage: string,
    options?: { cause?: unknown; errorCode?: ConnectorErrorCode },
  ) {
    super(userFriendlyMessage, { cause: options?.cause });
    this.name = 'MySqlClientError';
    this.userFriendlyMessage = userFriendlyMessage;
    this.errorCode = options?.errorCode;
  }
}
