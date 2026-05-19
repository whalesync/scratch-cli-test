/**
 * Helpers for the WordPress incremental-pull modified-since mechanism. Mirrors
 * the _shape_ of `airtable/airtable-incremental.ts`, `notion/notion-incremental.ts`,
 * and `linear/linear-incremental.ts` so the per-connector code reads the same,
 * even though WordPress's modified-since mechanism is the bare REST query param
 * `?modified_after=<datetime>` on the list endpoint rather than an Airtable
 * formula, a Notion JSON filter, or a Linear GraphQL filter input.
 *
 * WordPress has no user `options.filter` today, so there is no filter-combiner
 * here — this module owns the clock-skew constant and the watermark formatter.
 *
 * **Site-timezone handling:** WordPress filters `modified_after` against
 * `post_modified`, which is stored in the *site's* timezone, while our
 * watermark is a UTC instant. Sending the raw UTC ISO string would shift the
 * comparison by the site's whole UTC offset (potentially many hours — far past
 * the clock-skew margin), silently missing records. {@link formatWordPressModifiedAfter}
 * therefore renders the watermark as the site's local wall-clock time (using
 * the IANA `timezone_string` when available so DST is handled, else the fixed
 * `gmt_offset`, else UTC) and emits it WITHOUT a timezone designator — a
 * "floating" datetime that WordPress's `WP_Date_Query` then compares directly
 * against the site-local `post_modified` column.
 */

import { WordPressSiteTimezone } from './wordpress-types';

/**
 * Clock-skew safety margin subtracted from the watermark before formatting it
 * as `modified_after`. WordPress's `modified_after` is effectively exclusive
 * and `post_modified` is written server-side while our watermark is captured
 * client-side, so without an overlap a record modified right at the boundary
 * (or while clocks drift) could be missed. The 60s margin re-pulls a small
 * window each run; idempotent commits absorb the duplicates. (The timezone
 * conversion below handles the *systematic* offset; this margin only covers
 * residual clock drift.)
 */
export const WORDPRESS_INCREMENTAL_CLOCK_SKEW_MS = 60_000;

/**
 * Subtract the clock-skew margin from `since`. Operates in instant-space (UTC);
 * the site-timezone rendering happens afterwards in
 * {@link formatWordPressModifiedAfter}. See {@link WORDPRESS_INCREMENTAL_CLOCK_SKEW_MS}.
 */
export function applyWordPressClockSkew(since: Date): Date {
  return new Date(since.getTime() - WORDPRESS_INCREMENTAL_CLOCK_SKEW_MS);
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/**
 * Render `instant` as `YYYY-MM-DDTHH:mm:ss` in the given IANA timezone (DST
 * resolved for that specific instant). No timezone designator is appended —
 * WordPress treats the value as site-local. Throws `RangeError` for an unknown
 * timezone name; the caller falls back to the numeric offset / UTC.
 */
function formatWallClockInZone(instant: Date, timezoneString: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezoneString,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(instant);
  const get = (type: Intl.DateTimeFormatPartTypes): string => parts.find((p) => p.type === type)?.value ?? '00';
  return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}:${get('second')}`;
}

/**
 * Render `instant` as `YYYY-MM-DDTHH:mm:ss` at a fixed hour offset from UTC
 * (e.g. `-5`, `5.5`). Used when the site has no IANA name (manual offset) or as
 * the UTC fallback (`offsetHours = 0`). Does not account for DST — that's why
 * the IANA path is preferred.
 */
function formatWallClockAtOffset(instant: Date, offsetHours: number): string {
  const shifted = new Date(instant.getTime() + offsetHours * 3_600_000);
  return (
    `${shifted.getUTCFullYear()}-${pad2(shifted.getUTCMonth() + 1)}-${pad2(shifted.getUTCDate())}` +
    `T${pad2(shifted.getUTCHours())}:${pad2(shifted.getUTCMinutes())}:${pad2(shifted.getUTCSeconds())}`
  );
}

/**
 * Build the `modified_after` query value: subtract the clock-skew margin, then
 * render the resulting instant as the site's local wall-clock time so it lines
 * up with the site-local `post_modified` column WordPress filters on.
 *
 * Precedence: IANA `timezoneString` (DST-aware) → fixed `gmtOffsetHours` →
 * UTC (also the path taken when the REST index couldn't be read).
 */
export function formatWordPressModifiedAfter(since: Date, tz: WordPressSiteTimezone): string {
  const cutoff = applyWordPressClockSkew(since);
  if (tz.timezoneString) {
    try {
      return formatWallClockInZone(cutoff, tz.timezoneString);
    } catch {
      // Unknown/invalid IANA name — fall through to the numeric offset / UTC.
    }
  }
  if (typeof tz.gmtOffsetHours === 'number' && Number.isFinite(tz.gmtOffsetHours)) {
    return formatWallClockAtOffset(cutoff, tz.gmtOffsetHours);
  }
  return formatWallClockAtOffset(cutoff, 0);
}
