import { z } from 'zod';

/**
 * Contracts for `GET /cli/v1/workbooks/:workbookId/table-specs` (DEV-13025). `scratchmd` (and Scratch Desktop through
 * its bundled `scratchmd`) uses it to keep the local cache `<ws>/.scratch/connections/scratch/<conn>/<folder>/` —
 * `schema.json` and `views/default.json` — in step with Postgres, instead of copying them from the connection repo's
 * git `.scratch/` mirror.
 */

/** Query params. Both are optional: with neither, the response lists every linked folder in the workbook. */
export const cliListWorkbookTableSpecsQuerySchema = z.object({
  /** Limits the response to one connection. A connection that isn't in the workbook is a 404. */
  connectorAccountId: z.string().min(1).optional(),
  /**
   * When true, every `present` artifact leaves out `content` and keeps only its `sha256`, so a client can tell which
   * files changed without downloading them. `z.stringbool` coerces the `?metadataOnly=true` query string.
   */
  metadataOnly: z.stringbool().optional(),
});
export type CliListWorkbookTableSpecsQueryDto = z.infer<typeof cliListWorkbookTableSpecsQuerySchema>;

/**
 * Bumped only on a breaking change to {@link CliWorkbookTableSpecsResponse}. New fields are additive and don't bump
 * it, so a client must ignore fields it doesn't know and must refuse a version newer than it understands.
 */
export const CLI_WORKBOOK_TABLE_SPECS_FORMAT_VERSION = 1;

/** Why a stored artifact couldn't be served. */
export type CliTableSpecArtifactUnreadableReason = 'stored-content-not-a-json-object';

/**
 * One stored file — a folder's table spec or its default view — and how the client should treat its local copy.
 * The statuses are the same for both files.
 */
export type CliTableSpecArtifact =
  /** Postgres holds this file. Write the local copy when its bytes differ. */
  | {
      status: 'present';
      /**
       * Lowercase hex SHA-256 of the UTF-8 bytes of `content`. It equals the SHA-256 of the file the client writes,
       * so the client can compare it with its local copy without downloading `content`.
       */
      sha256: string;
      /**
       * The stored text, exactly as stored: never parsed and re-serialized, so the bytes (and therefore the
       * DEV-10518 schema hash the CLI computes over them) are stable. Left out when `metadataOnly=true`.
       */
      content?: string;
    }
  /** Postgres holds no such file for the folder (no row, or a row with no default view). Delete the local copy. */
  | { status: 'absent' }
  /** Postgres holds something that can't be served. Keep the local copy and warn. */
  | { status: 'unreadable'; reason: CliTableSpecArtifactUnreadableReason };

/** One linked folder (a DataFolder with a path) and its two stored files. */
export interface CliWorkbookTableSpecsDataFolder {
  dataFolderId: string;
  /** `DataFolder.path`: starts with `/`; `/` is the connection's root folder. */
  path: string;
  /**
   * ISO-8601 time the folder's stored row last changed, or null when it has no row. Only for breaking ties between
   * two folders that map to the same local directory; it is NOT a change-detection signal (use `sha256`).
   */
  storedRowUpdatedAt: string | null;
  tableSpec: CliTableSpecArtifact;
  defaultView: CliTableSpecArtifact;
}

/** One connection in the workbook and all of its linked folders. */
export interface CliWorkbookTableSpecsConnectorAccount {
  connectorAccountId: string;
  /** Every linked folder in the connection, sorted by `path`. Empty when it has none. */
  dataFolders: CliWorkbookTableSpecsDataFolder[];
}

/**
 * A complete listing for its scope (the workbook, or the one connection asked for): a connection with no linked
 * folders appears with an empty `dataFolders`, so "no folders" and "not listed" can't be confused, and a client may
 * remove local files for folders the listing doesn't contain.
 */
export interface CliWorkbookTableSpecsResponse {
  formatVersion: typeof CLI_WORKBOOK_TABLE_SPECS_FORMAT_VERSION;
  workbookId: string;
  /** Sorted by `connectorAccountId`. */
  connectorAccounts: CliWorkbookTableSpecsConnectorAccount[];
}
