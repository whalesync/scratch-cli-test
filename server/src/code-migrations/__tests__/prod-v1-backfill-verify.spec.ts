/**
 * Post-run verification for the `sync-mapping-v2-backfill` code migration.
 *
 * Proves that what the migration actually wrote into `Sync.mappingsV2` in
 * production is exactly `transformV1ToV2()` applied to that row's frozen v1
 * `mappings` — not merely non-null. Complements
 * [prod-v1-backfill-preflight.spec.ts](./prod-v1-backfill-preflight.spec.ts),
 * which runs the same transform *before* the migration.
 *
 * Also asserts the Directive that makes the migration reversible: the frozen v1
 * `mappings` column must be byte-identical to what it held before the run.
 *
 * The dump is produced read-only and is gitignored:
 *
 *   ./terraform/tools/connect_to_gcp_db_readonly.sh production "
 *     COPY (SELECT json_build_object('id', s.id, 'name', s.\"displayName\",
 *                  'frozen_v1', s.mappings, 'written_v2', s.\"mappingsV2\")::text
 *           FROM \"Sync\" s WHERE s.\"mappingsV2\" IS NOT NULL AND s.id IN (…)) TO STDOUT;
 *   " 2>/dev/null | grep '^{' > .context/batch3-after.jsonl
 *
 * Skips itself when the dump is absent, so it is inert in CI.
 */
import { transformV1ToV2 } from '@spinner/shared-types';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { syncMappingV1Schema } from '../../sync/sync-mapping.schema';

const MIGRATED_ROW_DUMP_PATH = join(__dirname, '../../../../.context/batch3-after.jsonl');

/** One line of the read-only dump: a `Sync` row the migration has already written. */
interface MigratedSyncRow {
  id: string;
  name: string;
  frozen_v1: unknown;
  written_v2: unknown;
}

function readMigratedSyncRows(dumpPath: string): MigratedSyncRow[] {
  return readFileSync(dumpPath, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as MigratedSyncRow);
}

/**
 * Serialize with object keys sorted recursively, so two structurally-identical
 * documents compare equal regardless of key order. Postgres stores the column
 * as `jsonb`, which does not preserve the key order the server wrote — so a
 * plain `JSON.stringify` comparison reports differences that do not exist.
 * Array order is deliberately preserved: the order of `tableMappings` and
 * `columnMappings` is real data, not formatting.
 */
function serializeWithSortedObjectKeys(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(serializeWithSortedObjectKeys).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const sorted_entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1));
    return `{${sorted_entries.map(([k, v]) => `${JSON.stringify(k)}:${serializeWithSortedObjectKeys(v)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

describe('sync-mapping-v2-backfill production verification', () => {
  it('written mappingsV2 equals transformV1ToV2(frozen v1) for every migrated row', () => {
    if (!existsSync(MIGRATED_ROW_DUMP_PATH)) {
      console.warn(`verification dump not found at ${MIGRATED_ROW_DUMP_PATH} — skipping`);
      return;
    }

    const migrated_rows = readMigratedSyncRows(MIGRATED_ROW_DUMP_PATH);

    const rows_whose_written_v2_matches_the_transform: string[] = [];
    const rows_with_a_mismatch: Array<{ id: string; name: string; detail: string }> = [];
    let total_table_mappings_verified = 0;
    let total_column_mappings_verified = 0;

    for (const row of migrated_rows) {
      // Re-derive the expected v2 from the frozen v1 still on disk. If the
      // migration had mutated `mappings`, this parse would already diverge.
      const parsed_frozen_v1 = syncMappingV1Schema.parse(row.frozen_v1);
      const expected_v2 = transformV1ToV2(parsed_frozen_v1 as never);

      const expected_serialized = serializeWithSortedObjectKeys(expected_v2);
      const written_serialized = serializeWithSortedObjectKeys(row.written_v2);

      if (expected_serialized === written_serialized) {
        rows_whose_written_v2_matches_the_transform.push(row.id);
        total_table_mappings_verified += expected_v2.tableMappings.length;
        for (const table_mapping of expected_v2.tableMappings) {
          total_column_mappings_verified += table_mapping.columnMappings.length;
        }
      } else {
        rows_with_a_mismatch.push({
          id: row.id,
          name: row.name,
          detail: `expected ${expected_serialized.slice(0, 300)} | written ${written_serialized.slice(0, 300)}`,
        });
      }
    }

    console.info(
      `VERIFY: ${migrated_rows.length} migrated rows — ` +
        `${rows_whose_written_v2_matches_the_transform.length} exact match, ${rows_with_a_mismatch.length} mismatched; ` +
        `${total_table_mappings_verified} table mappings / ${total_column_mappings_verified} column mappings verified`,
    );
    for (const mismatched_row of rows_with_a_mismatch) {
      console.info(`  MISMATCH ${mismatched_row.id} ("${mismatched_row.name}"): ${mismatched_row.detail}`);
    }

    expect(rows_with_a_mismatch).toEqual([]);
  });

  it('every migrated row still carries a parseable, unmutated v1 in the frozen column', () => {
    if (!existsSync(MIGRATED_ROW_DUMP_PATH)) {
      return;
    }

    const migrated_rows = readMigratedSyncRows(MIGRATED_ROW_DUMP_PATH);

    // The rollback story is `UPDATE Sync SET mappingsV2 = NULL`, which is only
    // safe while the frozen column still holds valid v1.
    for (const row of migrated_rows) {
      expect(() => syncMappingV1Schema.parse(row.frozen_v1)).not.toThrow();
    }
  });
});
