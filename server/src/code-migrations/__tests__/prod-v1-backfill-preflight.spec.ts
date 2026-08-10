/**
 * Offline pre-flight for the `sync-mapping-v2-backfill` code migration.
 *
 * The migration declares `supportsDryRun: false`, so there is no way to preview
 * a production run through the admin endpoint. This spec substitutes for one:
 * it replays the exact decision tree of `backfillSyncMappingRow` steps 1-2
 * (`syncMappingV1Schema.parse` → `transformV1ToV2`) against a read-only dump of
 * every production row that still has `mappingsV2 IS NULL`, and reports which
 * rows would come back `transformed` and which would come back `errored`.
 *
 * The dump is produced read-only and is gitignored:
 *
 *   ./terraform/tools/connect_to_gcp_db_readonly.sh production "
 *     COPY (SELECT json_build_object('id', s.id, 'name', s.\"displayName\", 'mappings', s.mappings)::text
 *           FROM \"Sync\" s WHERE s.\"mappingsV2\" IS NULL ORDER BY s.\"createdAt\" ASC) TO STDOUT;
 *   " 2>/dev/null | grep '^{' > .context/v1-syncs-prod.jsonl
 *
 * Skips itself when the dump is absent, so it is inert in CI.
 */
import { transformV1ToV2 } from '@spinner/shared-types';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { syncMappingV1Schema } from '../../sync/sync-mapping.schema';

const PROD_V1_SYNC_DUMP_PATH = join(__dirname, '../../../../.context/v1-syncs-prod.jsonl');

/** One line of the read-only dump: a candidate `Sync` row still on the v1 shape. */
interface DumpedV1SyncRow {
  id: string;
  name: string;
  mappings: unknown;
}

function readDumpedV1SyncRows(dumpPath: string): DumpedV1SyncRow[] {
  return readFileSync(dumpPath, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as DumpedV1SyncRow);
}

describe('sync-mapping-v2-backfill production pre-flight', () => {
  it('every production v1 sync parses and transforms cleanly', () => {
    if (!existsSync(PROD_V1_SYNC_DUMP_PATH)) {
      console.warn(`pre-flight dump not found at ${PROD_V1_SYNC_DUMP_PATH} — skipping`);
      return;
    }

    const dumped_sync_rows = readDumpedV1SyncRows(PROD_V1_SYNC_DUMP_PATH);

    const rows_that_would_transform: string[] = [];
    const rows_that_would_error: Array<{ id: string; name: string; reason: string }> = [];

    for (const row of dumped_sync_rows) {
      try {
        const parsed_v1_mappings = syncMappingV1Schema.parse(row.mappings);
        transformV1ToV2(parsed_v1_mappings as never);
        rows_that_would_transform.push(row.id);
      } catch (error) {
        rows_that_would_error.push({
          id: row.id,
          name: row.name,
          reason: error instanceof Error ? error.message.slice(0, 400) : String(error),
        });
      }
    }

    console.info(
      `PRE-FLIGHT: ${dumped_sync_rows.length} candidates — ` +
        `${rows_that_would_transform.length} would transform, ${rows_that_would_error.length} would error`,
    );
    for (const errored_row of rows_that_would_error) {
      console.info(`  ERROR ${errored_row.id} ("${errored_row.name}"): ${errored_row.reason}`);
    }

    expect(rows_that_would_error).toEqual([]);
  });
});
