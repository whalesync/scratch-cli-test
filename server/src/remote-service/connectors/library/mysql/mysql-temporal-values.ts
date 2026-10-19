/**
 * Read-side temporal rendering.
 *
 * - DATE and DATETIME are stored on disk exactly as MySQL prints them (`YYYY-MM-DD`, `YYYY-MM-DD HH:MM:SS[.f]`).
 *   DATETIME carries no time zone, so it gets the non-asserting `date-time-local` schema format.
 * - TIMESTAMP stores an instant; our session's `time_zone` is `+00:00`, so MySQL prints it in UTC. Rewriting that
 *   text to RFC 3339 (`YYYY-MM-DDTHH:MM:SS[.f]Z`) is a lossless rendering of the fact the server reported — the
 *   same ruling as the Postgres Date→ISO serialization (DEV-10777) — and, unlike going through a JS Date, it keeps
 *   every microsecond digit.
 * - Zero dates (`0000-00-00 ...`) aren't instants; they stay verbatim (and warn under a date format, correctly).
 */

const MYSQL_TIMESTAMP_TEXT_PATTERN = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})(\.\d{1,6})?$/;

/** `2026-01-02 03:04:05.123456` → `2026-01-02T03:04:05.123456Z`; zero dates and unexpected text are unchanged. */
export function renderMySqlTimestampTextAsRfc3339Utc(timestampText: string | null): string | null {
  if (timestampText === null) return null;
  if (timestampText.startsWith('0000-00-00')) return timestampText;
  const timestampMatch = MYSQL_TIMESTAMP_TEXT_PATTERN.exec(timestampText);
  if (!timestampMatch) return timestampText;
  const [, datePart, timePart, fractionalSecondsPart] = timestampMatch;
  return `${datePart}T${timePart}${fractionalSecondsPart ?? ''}Z`;
}

/**
 * An instant as a UTC MySQL datetime literal with microsecond precision: `2026-01-02 03:04:05.678000`. Used to bind
 * incremental-pull watermarks as text, so the comparison doesn't depend on how the driver serializes a JS Date.
 */
export function formatInstantAsMySqlUtcDateTimeLiteral(instant: Date): string {
  return `${instant.toISOString().replace('T', ' ').replace('Z', '')}000`;
}
