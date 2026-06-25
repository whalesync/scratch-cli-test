/**
 * Pure, dependency-free helpers that translate between a schedule's stored 5-field cron
 * expression and the structured "frequency + time + weekday/day-of-month" model the UI
 * edits. The cron expression remains the single source of truth (see
 * docs/plans/2026-06-25-dev-10569-pull-schedule-weekly-monthly-when-to-run.md); these
 * helpers only compose it (`buildScheduleCron`), decompose it for editing
 * (`parseScheduleCron`), and render a human label (`describeScheduleCron`).
 *
 * The wall-clock time encoded in a daily/weekly/monthly cron is interpreted in the
 * schedule's stored IANA `timezone` at evaluation time (cron-parser's `tz` option); these
 * helpers deal only with the literal cron fields and never convert between zones.
 */

/** Cron value for the "Manual only" option — an empty string means "no schedule". */
export const MANUAL_SCHEDULE_CRON = '';
/** Cron value for the dev-only "Every minute" option. */
export const EVERY_MINUTE_SCHEDULE_CRON = '* * * * *';

/** Default time-of-day for a newly-chosen daily/weekly/monthly schedule: 08:00 (early morning). */
export const DEFAULT_SCHEDULE_HOUR = 8;
export const DEFAULT_SCHEDULE_MINUTE = 0;
/** Default weekday for a newly-chosen weekly schedule: Monday (cron day-of-week 1). */
export const DEFAULT_SCHEDULE_DAY_OF_WEEK = 1;
/** Default day-of-month for a newly-chosen monthly schedule: the 1st. */
export const DEFAULT_SCHEDULE_DAY_OF_MONTH = 1;

/**
 * The frequency shapes the picker offers. `custom` is the catch-all for any stored cron
 * the picker can't represent with its structured controls (legacy or hand-entered): it is
 * preserved verbatim and never reconstructed from parts.
 */
export type ScheduleFrequency =
  | 'manual'
  | 'every5m'
  | 'every30m'
  | 'hourly'
  | 'daily'
  | 'weekly'
  | 'monthly'
  | 'everyMinute'
  | 'custom';

/**
 * The structured form of a schedule cron. `hour`/`minute`/`dayOfWeek`/`dayOfMonth` are
 * always populated (with defaults) so the UI can keep them as remembered draft values when
 * the user toggles between frequencies; only the fields relevant to the active `frequency`
 * are encoded into the cron. `raw` preserves the original cron for the `custom` case.
 */
export interface ScheduleParts {
  frequency: ScheduleFrequency;
  /** Hour of day, 0–23 (used by daily/weekly/monthly). */
  hour: number;
  /** Minute of hour, 0–59 (used by daily/weekly/monthly). */
  minute: number;
  /** Cron day-of-week, 0–6 (Sunday–Saturday), used by weekly. */
  dayOfWeek: number;
  /** Day of month, 1–31, used by monthly. */
  dayOfMonth: number;
  /** The original cron string — the value emitted for the `custom` frequency. */
  raw: string;
}

/** Names indexed by cron day-of-week (0 = Sunday). */
export const SCHEDULE_WEEKDAY_NAMES = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
] as const;

/** True for the frequencies whose run time depends on a timezone (have a time-of-day). */
export function isTimeBasedFrequency(frequency: ScheduleFrequency): boolean {
  return frequency === 'daily' || frequency === 'weekly' || frequency === 'monthly';
}

/** True for a cron whose run time depends on a timezone (daily/weekly/monthly). */
export function isTimeBasedCron(cron: string): boolean {
  return isTimeBasedFrequency(parseScheduleCron(cron).frequency);
}

/** Parses a cron field that must be a single non-negative integer, else returns null. */
function parseIntegerField(field: string): number | null {
  if (!/^\d+$/.test(field)) {
    return null;
  }
  return Number(field);
}

function defaultParts(raw: string): ScheduleParts {
  return {
    frequency: 'custom',
    hour: DEFAULT_SCHEDULE_HOUR,
    minute: DEFAULT_SCHEDULE_MINUTE,
    dayOfWeek: DEFAULT_SCHEDULE_DAY_OF_WEEK,
    dayOfMonth: DEFAULT_SCHEDULE_DAY_OF_MONTH,
    raw,
  };
}

/**
 * Decomposes a stored cron into structured {@link ScheduleParts}. Recognizes the fixed
 * interval presets and the canonical daily/weekly/monthly shapes this module emits;
 * anything else (ranges, lists, step values on dom/dow, constrained month, etc.) is
 * returned as `frequency: 'custom'` with `raw` set to the original cron so it round-trips
 * untouched. Note `0 0 * * *` decodes to daily @ 00:00, preserving the legacy "Daily" preset.
 */
export function parseScheduleCron(cron: string): ScheduleParts {
  const base = defaultParts(cron);

  if (cron === MANUAL_SCHEDULE_CRON) {
    return { ...base, frequency: 'manual' };
  }
  if (cron === EVERY_MINUTE_SCHEDULE_CRON) {
    return { ...base, frequency: 'everyMinute' };
  }
  if (cron === '*/5 * * * *') {
    return { ...base, frequency: 'every5m' };
  }
  if (cron === '*/30 * * * *') {
    return { ...base, frequency: 'every30m' };
  }
  if (cron === '0 * * * *') {
    return { ...base, frequency: 'hourly' };
  }

  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5) {
    return base;
  }
  const [minuteField, hourField, dayOfMonthField, monthField, dayOfWeekField] = fields;

  const minute = parseIntegerField(minuteField);
  const hour = parseIntegerField(hourField);
  if (minute === null || hour === null || minute > 59 || hour > 23 || monthField !== '*') {
    return base;
  }

  // Daily: every day at H:M.
  if (dayOfMonthField === '*' && dayOfWeekField === '*') {
    return { ...base, frequency: 'daily', hour, minute };
  }
  // Weekly: a single weekday at H:M.
  if (dayOfMonthField === '*' && dayOfWeekField !== '*') {
    const dayOfWeek = parseIntegerField(dayOfWeekField);
    if (dayOfWeek === null || dayOfWeek > 6) {
      return base;
    }
    return { ...base, frequency: 'weekly', hour, minute, dayOfWeek };
  }
  // Monthly: a single day-of-month at H:M.
  if (dayOfMonthField !== '*' && dayOfWeekField === '*') {
    const dayOfMonth = parseIntegerField(dayOfMonthField);
    if (dayOfMonth === null || dayOfMonth < 1 || dayOfMonth > 31) {
      return base;
    }
    return { ...base, frequency: 'monthly', hour, minute, dayOfMonth };
  }

  return base;
}

/**
 * Composes {@link ScheduleParts} back into a 5-field cron string. For `custom` the original
 * `raw` is returned verbatim — never reconstructed — so an unrecognized cron is preserved.
 */
export function buildScheduleCron(parts: ScheduleParts): string {
  switch (parts.frequency) {
    case 'manual':
      return MANUAL_SCHEDULE_CRON;
    case 'everyMinute':
      return EVERY_MINUTE_SCHEDULE_CRON;
    case 'every5m':
      return '*/5 * * * *';
    case 'every30m':
      return '*/30 * * * *';
    case 'hourly':
      return '0 * * * *';
    case 'daily':
      return `${parts.minute} ${parts.hour} * * *`;
    case 'weekly':
      return `${parts.minute} ${parts.hour} * * ${parts.dayOfWeek}`;
    case 'monthly':
      return `${parts.minute} ${parts.hour} ${parts.dayOfMonth} * *`;
    case 'custom':
      return parts.raw;
  }
}

function formatTimeOfDay(hour: number, minute: number): string {
  const period = hour < 12 ? 'AM' : 'PM';
  const hour12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${hour12}:${String(minute).padStart(2, '0')} ${period}`;
}

function ordinal(n: number): string {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) {
    return `${n}th`;
  }
  switch (n % 10) {
    case 1:
      return `${n}st`;
    case 2:
      return `${n}nd`;
    case 3:
      return `${n}rd`;
    default:
      return `${n}th`;
  }
}

function timezoneSuffix(timezone?: string | null): string {
  return timezone ? ` · ${timezone}` : '';
}

/**
 * Renders a human-readable label for a schedule cron, appending the timezone for the
 * time-based frequencies. Falls back to the raw cron for an unrecognized (`custom`) value.
 */
export function describeScheduleCron(cron: string, timezone?: string | null): string {
  const parts = parseScheduleCron(cron);
  switch (parts.frequency) {
    case 'manual':
      return 'Manual only';
    case 'everyMinute':
      return 'Every minute';
    case 'every5m':
      return 'Every 5 minutes';
    case 'every30m':
      return 'Every 30 minutes';
    case 'hourly':
      return 'Hourly';
    case 'daily':
      return `Daily at ${formatTimeOfDay(parts.hour, parts.minute)}${timezoneSuffix(timezone)}`;
    case 'weekly':
      return `Weekly on ${SCHEDULE_WEEKDAY_NAMES[parts.dayOfWeek]}s at ${formatTimeOfDay(
        parts.hour,
        parts.minute,
      )}${timezoneSuffix(timezone)}`;
    case 'monthly':
      return `Monthly on the ${ordinal(parts.dayOfMonth)} at ${formatTimeOfDay(parts.hour, parts.minute)}${timezoneSuffix(
        timezone,
      )}`;
    case 'custom':
      return cron;
  }
}
