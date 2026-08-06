/**
 * Spreadsheet serial-date conversion — the number encoding Excel, Google Sheets, and
 * LibreOffice all share for date/time cells: whole days since 1899-12-30, with the
 * fractional part as the time of day (`45870.5` = 2025-08-01 12:00). Serial values are
 * timezone-NAIVE wall-clock times, so the ISO side carries no `Z`/offset.
 *
 * (The epoch is 1899-12-30 rather than 1899-12-31 because Lotus 1-2-3 treated 1900 as a
 * leap year and every spreadsheet since has kept the bug for compatibility; anchoring at
 * 1899-12-30 makes all serials from 1900-03-01 onward — i.e. every date users actually
 * sync — convert correctly.)
 *
 * Pure and dependency-free so both the client-side display applier and the server-side
 * sync transformers share one implementation.
 */

/** Milliseconds in one day. */
const MILLISECONDS_PER_DAY = 86_400_000;

/** The spreadsheet epoch (serial 0) as a UTC timestamp: 1899-12-30T00:00:00. */
const SERIAL_EPOCH_UTC_MILLISECONDS = Date.UTC(1899, 11, 30);

/**
 * Serials outside this range produce dates `Date` can't represent (or that are plainly
 * garbage for user data). ±3,000,000 days ≈ years -6300…10100 — far beyond any real
 * spreadsheet content while comfortably inside Date's representable range.
 */
const MAX_REASONABLE_ABSOLUTE_SERIAL_DAYS = 3_000_000;

function pad(value: number, width: number): string {
  return String(value).padStart(width, '0');
}

/**
 * Convert a spreadsheet serial number to an ISO-8601 string, or `null` when the value
 * is not a finite number in the representable range.
 *
 * `isoShape` (default `'auto'`): `'auto'` emits a date-only string for an integer serial
 * and a seconds-precision date-time string for a fractional one; `'date'` / `'datetime'`
 * force the respective shape. The output never carries a timezone suffix — a serial is a
 * wall-clock value.
 */
export function serialDateNumberToIsoString(
  serialDays: number,
  isoShape: 'auto' | 'date' | 'datetime' = 'auto',
): string | null {
  if (typeof serialDays !== 'number' || !Number.isFinite(serialDays)) return null;
  if (Math.abs(serialDays) > MAX_REASONABLE_ABSOLUTE_SERIAL_DAYS) return null;

  // Round to whole seconds first so float noise (e.g. 0.1 days = 8639.999…s) can't
  // shift the rendered time, then rebuild the date from the rounded total.
  const totalSeconds = Math.round(serialDays * (MILLISECONDS_PER_DAY / 1000));
  const wallClock = new Date(SERIAL_EPOCH_UTC_MILLISECONDS + totalSeconds * 1000);
  if (Number.isNaN(wallClock.getTime())) return null;

  const datePart = `${pad(wallClock.getUTCFullYear(), 4)}-${pad(wallClock.getUTCMonth() + 1, 2)}-${pad(
    wallClock.getUTCDate(),
    2,
  )}`;
  const hasTimeOfDay = totalSeconds % (MILLISECONDS_PER_DAY / 1000) !== 0;
  if (isoShape === 'date' || (isoShape === 'auto' && !hasTimeOfDay)) {
    return datePart;
  }
  const timePart = `${pad(wallClock.getUTCHours(), 2)}:${pad(wallClock.getUTCMinutes(), 2)}:${pad(
    wallClock.getUTCSeconds(),
    2,
  )}`;
  return `${datePart}T${timePart}`;
}

/**
 * Parse an ISO-8601 date or date-time string into a spreadsheet serial number, or
 * `null` when the string isn't an ISO date (fail closed — no partial parsing).
 *
 * Timezone handling: a bare wall-clock string (`2025-08-01`, `2025-08-01T12:00:00`)
 * converts verbatim; a `Z`- or offset-suffixed instant is first normalized to its UTC
 * wall clock (a source service's UTC timestamp becomes the serial of that UTC time).
 *
 * Only the two ISO shapes are accepted. Deliberately NO `Date.parse` fallback for
 * other formats: ECMA-262 parses an offset-less non-ISO string (`8/1/2025`) in the
 * HOST timezone — the stored value would then depend on where the code runs — and
 * V8 happily reads a bare numeric string (`"45870"`) as a YEAR. Both must fail
 * closed rather than convert to garbage.
 */
export function isoStringToSerialDateNumber(isoString: string): number | null {
  if (typeof isoString !== 'string') return null;
  const trimmed = isoString.trim();
  if (trimmed === '') return null;

  // Bare date / date-time (no zone): interpret the fields as-is via the Date.UTC
  // constructor so the host machine's timezone never leaks into the conversion.
  const wallClockMatch = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?)?$/);
  if (wallClockMatch) {
    const [, year, month, day, hours, minutes, seconds, fractionalSeconds] = wallClockMatch;
    const utcMilliseconds = Date.UTC(
      Number(year),
      Number(month) - 1,
      Number(day),
      Number(hours ?? 0),
      Number(minutes ?? 0),
      Number(seconds ?? 0),
      // Truncate sub-millisecond precision (Postgres timestamps carry 6 digits).
      Number((fractionalSeconds ?? '').slice(0, 3).padEnd(3, '0') || 0),
    );
    if (Number.isNaN(utcMilliseconds)) return null;
    return (utcMilliseconds - SERIAL_EPOCH_UTC_MILLISECONDS) / MILLISECONDS_PER_DAY;
  }

  // Zoned ISO instant (Z or ±hh[:]mm suffix): normalize to the UTC wall clock.
  // Date.parse is safe here because the offset makes the instant unambiguous.
  const zonedIsoMatch = trimmed.match(/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/);
  if (zonedIsoMatch) {
    const parsedMilliseconds = Date.parse(trimmed);
    if (Number.isNaN(parsedMilliseconds)) return null;
    return (parsedMilliseconds - SERIAL_EPOCH_UTC_MILLISECONDS) / MILLISECONDS_PER_DAY;
  }

  return null;
}
