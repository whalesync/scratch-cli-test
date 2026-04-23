# PostHog person property backfill

Small one-off tool to set a **single person property** on multiple users in PostHog from a CSV.

## Install

```bash
cd scripts/posthog-backfill
yarn install
```

Requires **Node 22+** (see `package.json` `engines`).

## Environment

For real sends (not `--dry-run`):

| Variable          | Example                                                  |
| ----------------- | -------------------------------------------------------- |
| `POSTHOG_API_KEY` | Project API key from PostHog                             |
| `POSTHOG_HOST`    | `https://us.i.posthog.com` or `https://eu.i.posthog.com` |

## CSV format

- **Header row** required (column names are arbitrary).
- **First column** (by order): PostHog **distinct id** (same id you use as `distinctId` in the app, e.g. Scratch user id).
- **Second column** (by order): **value** for the property, as a **string** (trimmed). Format dates, numbers, booleans, etc. in the CSV yourself (e.g. `YYYY-MM-DD` for date properties).
- Any further columns are ignored.

Example:

```csv
userId,value
usr_abc,2023-01-15
usr_def,2023-02-01
```

## Usage

```bash
yarn backfill -- [options] [arguments]
```

### Property name (required)

- `--property <name>` or `-p <name>`
- Or two positionals: `yarn backfill -- <propertyName> <path/to.csv>`

Property names must not start with `$` (PostHog reserved).

### CSV path

- `--file <path>` or `-f <path>`
- Or a single positional when `--property` / `-p` is set: `yarn backfill -- -p signed_up_at ./users.csv`

### Options

| Flag          | Description                                                                                   |
| ------------- | --------------------------------------------------------------------------------------------- |
| `--dry-run`   | Print what would be sent; no PostHog calls; env vars not required                             |
| `--limit <n>` | Process at most `n` data rows (after the header)                                              |
| `--overwrite` | Use **`$set`** instead of the default **`$set_once`** (overwrites existing person properties) |

At most **two** positionals are allowed: `property file.csv`.

## Examples

```bash
# Dry run (no API key needed)
yarn backfill -- --property signed_up_at -f ./users.csv --dry-run

# Backfill signed_up_at (set once per person)
export POSTHOG_API_KEY=…
export POSTHOG_HOST=https://us.i.posthog.com
yarn backfill -- --property signed_up_at -f ./users.csv

# Shorthand: property and file as positionals
yarn backfill -- signed_up_at ./users.csv

# Smoke test first 10 rows
yarn backfill -- -p signed_up_at -f ./users.csv --limit 10

# Force overwrite with $set
yarn backfill -- -p some_flag -f ./users.csv --overwrite
```

## How it works

For each row, the tool sends a PostHog **`capture`** with event name `person_property_backfill` and either:

- **`$set_once`**: `{ [propertyName]: value }` (default), or
- **`$set`**: same shape when `--overwrite` is set.

The client is created with **`historicalMigration: true`** (migration-style ingestion). Event properties `backfill_property` and `backfill_mode` are included on the event for debugging in PostHog.

## Exporting users from Postgres (Spinner)

Example SQL (distinct id + `createdAt` as `YYYY-MM-DD` in UTC):

```sql
SELECT
  id AS "userId",
  to_char("createdAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS "value"
FROM "User"
ORDER BY "createdAt";
```

Use `--property signed_up_at` and a CSV whose **first** column is id and **second** is the date string (header names do not need to be `userId` / `value`; **order** is what matters).
