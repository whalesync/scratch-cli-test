/**
 * Date/time formatting helpers used across the renderer. Avoids a dayjs (or
 * similar) dependency by leaning on built-in `Intl.RelativeTimeFormat` and
 * `Date.toLocaleString`.
 */

const RELATIVE_RANGES: [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 3600 * 24 * 365],
  ['month', 3600 * 24 * 30],
  ['week', 3600 * 24 * 7],
  ['day', 3600 * 24],
  ['hour', 3600],
  ['minute', 60],
  ['second', 1],
];

/**
 * Returns a humanized "5 hours ago" / "in 3 days" string for an ISO timestamp.
 * Returns "just now" for sub-second deltas.
 */
export function relativeTime(iso: string): string {
  const formatter = new Intl.RelativeTimeFormat('en', { style: 'long' });
  const secondsElapsed = (new Date(iso).getTime() - Date.now()) / 1000;
  for (const [unit, seconds] of RELATIVE_RANGES) {
    if (seconds < Math.abs(secondsElapsed)) {
      return formatter.format(Math.round(secondsElapsed / seconds), unit);
    }
  }
  return 'just now';
}

/**
 * Returns a locale-formatted absolute date string for an ISO timestamp.
 * Defaults to `{ dateStyle: 'medium', timeStyle: 'short' }` (e.g. "May 28, 2026, 7:14 PM").
 */
export function absoluteDate(iso: string, opts?: Intl.DateTimeFormatOptions): string {
  const options: Intl.DateTimeFormatOptions = opts ?? { dateStyle: 'medium', timeStyle: 'short' };
  return new Date(iso).toLocaleString(undefined, options);
}
