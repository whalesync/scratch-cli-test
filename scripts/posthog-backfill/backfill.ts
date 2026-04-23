/**
 * Set a PostHog person property for many users from a CSV (optional migration-style ingest).
 *
 * Self-contained: only `posthog-node` and `csv-parse` (see this folder’s package.json).
 * Not a Yarn workspace — run `yarn install` inside `scripts/posthog-backfill` (root `yarn` does not install it).
 *
 * CSV: header row, then first column = distinct id (user id in PostHog), second column = value for the property
 * (values are sent as strings; pre-format the CSV, e.g. YYYY-MM-DD for dates). Extra columns are ignored.
 *
 * Required: `--property <name>` (or first positional if you pass two positionals: property, file).
 * File: `--file <path>`, `-f`, or a single positional (when property is set via flag).
 *
 * By default the value is sent with $set_once (unchanged on duplicate runs). Use `--overwrite` to use $set instead.
 *
 * Examples:
 *   yarn backfill -- --property signed_up_at -f path/to.csv
 *   yarn backfill -- --property signed_up_at --dry-run path/to.csv
 *   yarn backfill -- signed_up_at path/to.csv
 *   yarn backfill -- -p my_flag --file users.csv --limit 5 --overwrite
 *
 * Env: POSTHOG_API_KEY, POSTHOG_HOST (e.g. https://us.i.posthog.com)
 */
import { parse } from 'csv-parse/sync';
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { PostHog } from 'posthog-node';

const BACKFILL_EVENT = 'person_property_backfill';
const FLUSH_EVERY = 100;

function isValidPropertyName(name: string): boolean {
  const t = name.trim();
  if (t.length === 0) {
    return false;
  }
  if (t.startsWith('$')) {
    return false;
  }
  return true;
}

function getFirstTwoByColumnOrder(row: Record<string, string>): { distinctId: string; value: string } {
  const keys = Object.keys(row);
  if (keys.length < 2) {
    throw new Error('Row must have at least two columns (distinct id, value).');
  }
  const k0 = keys[0]!;
  const k1 = keys[1]!;
  return { distinctId: row[k0]!.trim(), value: row[k1]!.trim() };
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      property: { type: 'string', short: 'p' },
      file: { type: 'string', short: 'f' },
      'dry-run': { type: 'boolean', default: false },
      limit: { type: 'string' },
      overwrite: { type: 'boolean', default: false },
    },
  });

  let filePath: string | undefined = values.file;
  let property: string | undefined = values.property;

  if (positionals.length === 2 && !property) {
    property = positionals[0]!.trim();
    filePath = filePath ?? positionals[1]!;
  } else if (positionals.length === 1) {
    filePath = filePath ?? positionals[0]!;
  } else if (positionals.length > 2) {
    console.error('Error: at most two positionals: <property> <file>, or one file path with --property.');
    process.exit(1);
  }

  if (property === undefined || property.length === 0) {
    console.error('Error: pass --property <name> (or -p) or use two positionals: property path.csv');
    process.exit(1);
  }

  if (!isValidPropertyName(property)) {
    console.error('Error: property name must be non-empty and must not start with "$" (PostHog reserved prefix).');
    process.exit(1);
  }
  const propertyName = property.trim();

  if (filePath === undefined || filePath.length === 0) {
    console.error('Error: pass a CSV path with --file or as a positional argument.');
    process.exit(1);
  }

  const dryRun = values['dry-run'] === true;
  const useSet = values.overwrite === true;

  const apiKey = process.env.POSTHOG_API_KEY;
  const host = process.env.POSTHOG_HOST;
  let phApiKey: string;
  let phHost: string;
  if (dryRun) {
    phApiKey = apiKey ?? '';
    phHost = host ?? '';
  } else {
    if (apiKey === undefined || apiKey.length === 0) {
      console.error('Error: set POSTHOG_API_KEY in the environment (not required for --dry-run).');
      process.exit(1);
    }
    if (host === undefined || host.length === 0) {
      console.error('Error: set POSTHOG_HOST in the environment, e.g. https://us.i.posthog.com (not required for --dry-run).');
      process.exit(1);
    }
    phApiKey = apiKey;
    phHost = host;
  }

  let limit: number | undefined;
  if (values.limit !== undefined) {
    const n = Number.parseInt(values.limit, 10);
    if (Number.isNaN(n) || n < 0) {
      console.error('Error: --limit must be a non-negative number.');
      process.exit(1);
    }
    limit = n;
  }

  const raw = readFileSync(filePath, 'utf8');
  const records = parse(raw, { columns: true, skip_empty_lines: true, trim: true, relax_column_count: true }) as Record<
    string,
    string
  >[];

  if (records.length === 0) {
    console.error('Error: no data rows in CSV (after the header).');
    process.exit(1);
  }

  const posthog = dryRun
    ? null
    : new PostHog(phApiKey, {
        host: phHost,
        historicalMigration: true,
        flushAt: 20,
        flushInterval: 5000,
      });

  const personPayload = useSet ? '$set' : '$set_once';

  let sent = 0;
  let failed = 0;
  let i = 0;
  for (const row of records) {
    if (limit !== undefined && i >= limit) {
      break;
    }
    i += 1;

    let distinctId: string;
    let rawValue: string;
    try {
      ({ distinctId, value: rawValue } = getFirstTwoByColumnOrder(row));
    } catch (e) {
      console.error(`Row ${i}:`, e);
      failed += 1;
      continue;
    }

    if (!distinctId) {
      console.error(`Row ${i}: empty distinct id (first column), skipped.`);
      failed += 1;
      continue;
    }
    if (rawValue.length === 0) {
      console.error(`Row ${i}: empty value (second column) for ${distinctId}, skipped.`);
      failed += 1;
      continue;
    }

    const propPayload = { [propertyName]: rawValue } as Record<string, string>;
    const captureProperties: Record<string, unknown> = {
      [personPayload]: propPayload,
    };

    if (dryRun) {
      console.log(
        `[dry-run] ${distinctId} -> ${personPayload} { ${JSON.stringify(propPayload).slice(1, -1)} } (event: ${BACKFILL_EVENT})`,
      );
      sent += 1;
      continue;
    }

    try {
      posthog!.capture({
        distinctId,
        event: BACKFILL_EVENT,
        properties: {
          backfill_property: propertyName,
          backfill_mode: useSet ? 'set' : 'set_once',
          ...captureProperties,
        },
      });
      sent += 1;
      if (sent % FLUSH_EVERY === 0) {
        await posthog!.flush();
        console.log(`... flushed at ${sent} events`);
      }
    } catch (e) {
      console.error(`Row ${i} (distinctId=${distinctId}):`, e);
      failed += 1;
    }
  }

  if (posthog) {
    await posthog.flush();
    await posthog.shutdown();
  }

  const mode = dryRun ? 'dry-run' : 'submitted';
  console.log(
    `Done (${mode}): property=${propertyName} ${useSet ? '($set)' : '($set_once)'} — ${sent} ok, ${failed} skipped/failed${
      limit !== undefined ? ` (limit ${limit})` : ''
    }, rows read ${i}.`,
  );
  if (failed > 0) {
    process.exit(1);
  }
}

void main().catch((e) => {
  console.error(e);
  process.exit(1);
});
