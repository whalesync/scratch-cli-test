import { IncrementalPullSupport, Service } from '../enums/enums';
import { DataFolderId, WorkbookId } from '../ids';
import { Schedule } from './schedule';

///
/// NOTE: Keep this in sync with server/prisma/schema.prisma DataFolder model
/// Begin "keep in sync" section
///

export interface DataFolder {
  id: DataFolderId;
  createdAt: string;
  updatedAt: string;
  name: string;
  workbookId: WorkbookId;
  connectorAccountId: string | null;
  connectorDisplayName: string | null;
  connectorService: Service | null;
  path: string | null;
  // Deep link to this table in the external service's own web UI (a URL on THEIR
  // site, e.g. https://airtable.com/{baseId}/{tableId}). Null when the service has
  // no constructible deep link. Lets the client offer an "open in {service}" link.
  remoteWebUrl: string | null;
  // TODO - instead of returning the raw lock this should be a status object that denotes "downloading" or "syncing"
  lock: string | null;
  version: number;
  tableId: string[];
  isAssetTable: boolean;
  options: Record<string, unknown> | null;
  schedules: Schedule[];
  lastFullPullAt: string | null;
  lastIncrementalPullAt: string | null;
  // Denormalized count of record files in this folder (direct-child, non-dotfile blobs on
  // `main` — matches the folder viewer). Git-sourced; refreshed after a pull and by cron, so
  // it can briefly lag local edits between refreshes.
  recordCount: number;

  ///
  /// End "keep in sync" section
  ///

  /**
   * Computed by the REST API (NOT a persisted column): whether this folder can
   * currently run an incremental pull. See {@link IncrementalPullSupport}.
   */
  incrementalPullSupport: IncrementalPullSupport;
}

export interface DataFolderGroup {
  name: string;
  service: Service | null;
  dataFolders: DataFolder[];
}

/**
 * Name of the group that holds standalone, connector-less "scratch" folders (DEV-10424). Shared so
 * the server (which emits the group) and the frontends (which sort it first and render it) agree on
 * the literal string.
 */
export const SCRATCH_GROUP_NAME = 'Scratch';
