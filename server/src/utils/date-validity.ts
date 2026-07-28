/**
 * The leading `YYYY-MM-DD` of an ISO-8601 date or date-time string, captured so the
 * calendar day can be validated by round-trip. Anchored at the start and requiring a
 * four-digit year, so a bare time, an extended-year form (`+010000-…`), or a non-ISO
 * string falls through to the parse-only check instead of matching here.
 */
const LEADING_ISO_CALENDAR_DATE = /^(\d{4})-(\d{2})-(\d{2})/;

/**
 * Whether an ISO-8601 date / date-time STRING names a real, writable calendar instant.
 *
 * The trap this closes (DEV-11044): `new Date("2026-02-29")` does NOT return an
 * invalid date — JavaScript silently ROLLS IT OVER to `2026-03-01`. So a nonexistent
 * calendar date (Feb 29 in a non-leap year, Feb 30, month 13, day 00) that a source
 * service stored unvalidated — e.g. Pipedrive's v1 API accepts and returns
 * `"2026-02-29"` verbatim — parses "successfully" yet is rejected verbatim by every
 * destination's date column (Airtable / Notion / Supabase), losing the whole record
 * on every run. A bare `Number.isNaN(new Date(value).getTime())` check therefore
 * MISSES it; this does a strict round-trip on the `YYYY-MM-DD` components instead.
 *
 * Returns `true` for a genuine instant, `false` for an unparseable or nonexistent
 * calendar date. Deliberately does NOT enforce any destination-specific year range
 * (Notion's 0001–9999 stays in the Notion write guard) — an extended-year value that
 * names a real instant is considered valid here.
 */
export function isValidWritableCalendarDateString(value: string): boolean {
  const trimmed = value.trim();

  const leadingCalendarDate = LEADING_ISO_CALENDAR_DATE.exec(trimmed);
  if (leadingCalendarDate) {
    const [, yearText, monthText, dayText] = leadingCalendarDate;
    const year = Number(yearText);
    const monthIndex = Number(monthText) - 1;
    const dayOfMonth = Number(dayText);

    // Round-trip the components through a UTC date and confirm none rolled over — the
    // check `new Date(value)` alone can't do (see the doc comment). Feb 29 in a
    // non-leap year, Feb 30, month 13, or day 00 all shift the constructed instant and
    // fail one of these equalities.
    const roundTripped = new Date(Date.UTC(year, monthIndex, dayOfMonth));
    // `Date.UTC` maps a two-digit year (0–99) to 1900–1999; undo that so a legitimate
    // early-century date isn't mis-flagged, while the day/month rollover check stays intact.
    if (year >= 0 && year <= 99) {
      roundTripped.setUTCFullYear(year);
    }
    if (
      roundTripped.getUTCFullYear() !== year ||
      roundTripped.getUTCMonth() !== monthIndex ||
      roundTripped.getUTCDate() !== dayOfMonth
    ) {
      return false;
    }
  }

  // Either the calendar day round-tripped cleanly, or the string is not a leading
  // `YYYY-MM-DD` (a bare time, an extended-year form, …) — in both cases require that
  // the whole string still parses to a real instant.
  return !Number.isNaN(new Date(trimmed).getTime());
}
