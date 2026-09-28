import type { RunStoreKey } from './run-store-client';

/**
 * How a Live Export run lays out its data in the run store (see `run-store-client.ts`). Every
 * collection name and entry key the adapters use is built here, so the layout is documented in one
 * place:
 *
 * | collection                                  | key                                   | meta                                   | body                  |
 * |---------------------------------------------|---------------------------------------|----------------------------------------|-----------------------|
 * | `schemas`                                   | `<connectorAccountId>:<folderPath>`   | —                                      | table spec JSON       |
 * | `records:<dataFolderId>`                    | record path `<folderPath>/<id>.json`  | `{ recordId }`                         | record JSON (verbatim)|
 * | `sync-output:<destinationDataFolderId>`     | record path                           | `{ deleted: boolean }`                 | record JSON / null    |
 * | `sync-output-staging:<folderId>:<attempt>`  | record path                           | `{ deleted: false }`                   | record JSON           |
 * | `plan`                                      | zero-padded operation sequence        | phase, status, filePath, … (see plan)  | `{ content, changedFields }` |
 * | `plan-state`                                | `plan:<connectorAccountId>`           | plan status + totals                   | —                     |
 * | `created`                                   | record path                           | `{ remoteRecordId }`                   | —                     |
 *
 * `folderPath` is the DataFolder's path without its leading slash — the same connection-relative
 * paths the classic engine uses for record files, so sync-assigned paths and `@/…` pseudo-refs line
 * up exactly as they do on git.
 */

export const RUN_STORE_SCHEMAS_COLLECTION = 'schemas';
export const RUN_STORE_CREATED_RECORDS_COLLECTION = 'created';

export function runStoreRecordsCollection(dataFolderId: string): string {
  return `records:${dataFolderId}`;
}

export function runStoreSyncOutputCollection(destinationDataFolderId: string): string {
  return `sync-output:${destinationDataFolderId}`;
}

export function runStoreSyncOutputStagingCollection(destinationDataFolderId: string, attemptId: string): string {
  return `sync-output-staging:${destinationDataFolderId}:${attemptId}`;
}

/** One plan per destination connection (a run can publish to several). */
export function runStorePlanCollection(connectorAccountId: string): string {
  return `plan:${connectorAccountId}`;
}

export const RUN_STORE_PLAN_STATE_COLLECTION = 'plan-state';

export function runStorePlanStateKey(connectorAccountId: string): string {
  return `plan:${connectorAccountId}`;
}

/** A DataFolder path with no leading slash (`''` for a folder at the root). */
export function folderPathWithoutLeadingSlash(folderPath: string | null | undefined): string {
  return (folderPath ?? '').replace(/^\/+/, '');
}

export function runStoreTableSpecKey(connectorAccountId: string | null, folderPath: string): string {
  return `${connectorAccountId ?? ''}:${folderPathWithoutLeadingSlash(folderPath)}`;
}

/**
 * The path a pulled record is stored under. The record id is percent-encoded so every distinct id
 * gets a distinct, slash-free filename (the classic pull's human-readable filenames need a FileIndex
 * to stay stable across runs; a run store starts fresh every run, so the id itself is the name).
 */
export function runStorePulledRecordPath(folderPath: string | null | undefined, recordId: string): string {
  const folder = folderPathWithoutLeadingSlash(folderPath);
  const fileName = `${encodeURIComponent(recordId)}.json`;
  return folder === '' ? fileName : `${folder}/${fileName}`;
}

/** Sort-stable key for the n-th plan operation. */
export function runStorePlanOperationKey(sequenceNumber: number): string {
  return String(sequenceNumber).padStart(10, '0');
}

/**
 * The publish pipeline id of a Live Export run-store publish: one plan per (run, destination
 * connection). Surfaced as the routine step's `pipelineId`, so failure lookups can find the run.
 */
export function runStorePublishPipelineId(runStoreKey: RunStoreKey, connectorAccountId: string): string {
  return `${runStoreKey}.${connectorAccountId}`;
}

/** The inverse of {@link runStorePublishPipelineId}; null for a classic (PublishPlan) pipeline id. */
export function parseRunStorePublishPipelineId(
  pipelineId: string,
): { runStoreKey: RunStoreKey; connectorAccountId: string } | null {
  const match = /^(le-[A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(pipelineId);
  if (!match) return null;
  return { runStoreKey: match[1] as RunStoreKey, connectorAccountId: match[2] };
}
