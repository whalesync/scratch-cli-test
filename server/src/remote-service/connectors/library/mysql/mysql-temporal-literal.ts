/**
 * Convert a date / date-time string bound for a DATE, DATETIME or TIMESTAMP column into the literal MySQL stores.
 *
 * Used by BOTH the write path (record preparation) and the field-value canonicalizer, so what Scratch writes and
 * what it later compares against can never disagree (a Live Export re-run must be a no-op, DEV-10556).
 *
 * Rules (our session `time_zone` is `+00:00`):
 * - DATETIME / TIMESTAMP
 *   - naive values keep their wall clock (`2026-03-05T14:30` → `2026-03-05 14:30:00`);
 *   - `Z` / `±hh:mm` values become UTC wall clock — what MySQL ≥8.0.19 does natively for offset literals under a
 *     UTC session; doing it here gives MariaDB and older MySQL (which reject offsets) the same result;
 *   - fractional seconds are TRUNCATED to the column's precision and padded to it, so the output is canonical
 *     (MySQL would round, which can carry into the next second/day/year);
 *   - a date-only value becomes midnight.
 * - DATE keeps a calendar date verbatim. A date-time whose time of day is exactly midnight (in any offset) gives
 *   its literal date part; any other time of day is REJECTED rather than silently dropped.
 * - Zero dates (`0000-00-00[ 00:00:00[.000]]`) are written in the column's own shape (`0000-00-00` for DATE,
 *   `0000-00-00 00:00:00.000` for DATETIME(3)), which is how MySQL returns them.
 * Anything else is rejected with a reason; the caller decides whether that fails a write or is left as-is.
 *
 * TIME has its own converter (`convertRecognizedTimeTextToMySqlTimeLiteral`, bottom of this file) with the same
 * write-and-compare contract, but it never rejects: MySQL accepts many TIME shapes, so text it doesn't recognise is
 * sent unchanged and MySQL decides.
 */
import { type MySqlTemporalColumnType } from './mysql-native-column-type';

export type MySqlTemporalLiteralConversion =
  | { outcome: 'converted'; mySqlLiteral: string }
  | { outcome: 'rejected'; rejectionReason: string };

const ISO_OR_MYSQL_DATE_TIME_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})(?:[Tt ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?)?\s*(Z|z|[+-]\d{2}(?::?\d{2})?)?$/;

const MYSQL_MAX_FRACTIONAL_SECONDS_PRECISION = 6;

function padNumber(value: number, width: number): string {
  return String(value).padStart(width, '0');
}

/**
 * A UTC instant for the given wall clock. Not `Date.UTC`, which maps years 0-99 to 1900-1999 (so `0050-06-01`
 * would become 1950).
 */
function utcInstantForWallClock(year: number, month: number, day: number, hour = 0, minute = 0, second = 0): Date {
  const utcInstant = new Date(0);
  utcInstant.setUTCFullYear(year, month - 1, day);
  utcInstant.setUTCHours(hour, minute, second, 0);
  return utcInstant;
}

function isValidCalendarDate(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1) return false;
  // Day 0 of the next month is the last day of this one.
  const daysInMonth = utcInstantForWallClock(year, month + 1, 0).getUTCDate();
  return day <= daysInMonth;
}

/** MySQL's "zero" date / datetime, optionally with an all-zero time and fraction (allowed by our session sql_mode). */
const MYSQL_ZERO_DATE_PATTERN = /^0000-00-00(?:[Tt ]00:00:00(?:\.0+)?)?$/;

/** The zero date in the exact shape MySQL returns it for this column, so a written zero date reads back equal. */
function mySqlZeroDateLiteralForColumn(columnType: MySqlTemporalColumnType): string {
  if (columnType.temporalKind === 'date') return '0000-00-00';
  const fractionalSecondsPrecision = columnType.fractionalSecondsPrecision ?? 0;
  const fractionLiteral = fractionalSecondsPrecision > 0 ? `.${'0'.repeat(fractionalSecondsPrecision)}` : '';
  return `0000-00-00 00:00:00${fractionLiteral}`;
}

/** Offset text (`Z`, `+05:30`, `-0800`, `+05`) → minutes east of UTC; undefined when malformed. */
function parseUtcOffsetMinutes(offsetText: string): number | undefined {
  if (offsetText === 'Z' || offsetText === 'z') return 0;
  const offsetMatch = /^([+-])(\d{2}):?(\d{2})?$/.exec(offsetText);
  if (!offsetMatch) return undefined;
  const offsetHours = Number(offsetMatch[2]);
  const offsetMinutes = offsetMatch[3] === undefined ? 0 : Number(offsetMatch[3]);
  if (offsetHours > 23 || offsetMinutes > 59) return undefined;
  const signedTotal = offsetHours * 60 + offsetMinutes;
  return offsetMatch[1] === '-' ? -signedTotal : signedTotal;
}

function rejectTemporalValue(value: string, columnType: MySqlTemporalColumnType): MySqlTemporalLiteralConversion {
  const expectedShape =
    columnType.temporalKind === 'date'
      ? 'a calendar date (YYYY-MM-DD)'
      : 'a date and time (YYYY-MM-DD HH:MM:SS, or an ISO 8601 date-time)';
  return {
    outcome: 'rejected',
    rejectionReason: `"${value}" isn't a value MySQL can store in a ${columnType.temporalKind.toUpperCase()} column. Send ${expectedShape}.`,
  };
}

export function convertTemporalValueToMySqlLiteral(
  value: string,
  columnType: MySqlTemporalColumnType,
): MySqlTemporalLiteralConversion {
  const trimmedValue = value.trim();
  if (MYSQL_ZERO_DATE_PATTERN.test(trimmedValue)) {
    return { outcome: 'converted', mySqlLiteral: mySqlZeroDateLiteralForColumn(columnType) };
  }
  const dateTimeMatch = ISO_OR_MYSQL_DATE_TIME_PATTERN.exec(trimmedValue);
  if (!dateTimeMatch) return rejectTemporalValue(value, columnType);

  const [, yearText, monthText, dayText, hourText, minuteText, secondText, fractionDigits, offsetText] = dateTimeMatch;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = hourText === undefined ? 0 : Number(hourText);
  const minute = minuteText === undefined ? 0 : Number(minuteText);
  const second = secondText === undefined ? 0 : Number(secondText);
  if (!isValidCalendarDate(year, month, day) || hour > 23 || minute > 59 || second > 59) {
    return rejectTemporalValue(value, columnType);
  }
  const utcOffsetMinutes = offsetText === undefined ? undefined : parseUtcOffsetMinutes(offsetText);
  if (offsetText !== undefined && utcOffsetMinutes === undefined) {
    return rejectTemporalValue(value, columnType);
  }

  if (columnType.temporalKind === 'date') {
    const hasTimeOfDay = hour !== 0 || minute !== 0 || second !== 0 || /[1-9]/.test(fractionDigits ?? '');
    if (hasTimeOfDay) {
      return {
        outcome: 'rejected',
        rejectionReason: `"${value}" includes a time of day, but this is a DATE column. Send a calendar date (YYYY-MM-DD), or change the column to DATETIME.`,
      };
    }
    return { outcome: 'converted', mySqlLiteral: `${yearText}-${monthText}-${dayText}` };
  }

  // DATETIME / TIMESTAMP: shift whole seconds to UTC when an offset is given; the fraction is offset-independent.
  let wallClock = { year, month, day, hour, minute, second };
  if (utcOffsetMinutes !== undefined && utcOffsetMinutes !== 0) {
    const utcInstant = new Date(
      utcInstantForWallClock(year, month, day, hour, minute, second).getTime() - utcOffsetMinutes * 60_000,
    );
    wallClock = {
      year: utcInstant.getUTCFullYear(),
      month: utcInstant.getUTCMonth() + 1,
      day: utcInstant.getUTCDate(),
      hour: utcInstant.getUTCHours(),
      minute: utcInstant.getUTCMinutes(),
      second: utcInstant.getUTCSeconds(),
    };
    if (wallClock.year < 1 || wallClock.year > 9999) return rejectTemporalValue(value, columnType);
  }

  const fractionalSecondsPrecision = columnType.fractionalSecondsPrecision;
  const availableFractionDigits = (fractionDigits ?? '').slice(0, MYSQL_MAX_FRACTIONAL_SECONDS_PRECISION);
  const fractionDigitsForColumn =
    fractionalSecondsPrecision === undefined
      ? availableFractionDigits
      : availableFractionDigits.slice(0, fractionalSecondsPrecision).padEnd(fractionalSecondsPrecision, '0');

  const dateLiteral = `${padNumber(wallClock.year, 4)}-${padNumber(wallClock.month, 2)}-${padNumber(wallClock.day, 2)}`;
  const timeLiteral = `${padNumber(wallClock.hour, 2)}:${padNumber(wallClock.minute, 2)}:${padNumber(wallClock.second, 2)}`;
  const fractionLiteral = fractionDigitsForColumn.length > 0 ? `.${fractionDigitsForColumn}` : '';
  return { outcome: 'converted', mySqlLiteral: `${dateLiteral} ${timeLiteral}${fractionLiteral}` };
}

/**
 * A TIME column's fractional-seconds precision (0-6), or undefined when the column isn't TIME. A bare `time` is
 * precision 0: MySQL and MariaDB report `time(0)` as plain `time`, exactly as for DATETIME.
 */
export function readMySqlTimeColumnFractionalSecondsPrecision(columnTypeSpelling: string): number | undefined {
  const timeColumnTypeMatch = /^\s*time(?:\(([0-6])\))?\s*$/i.exec(columnTypeSpelling);
  if (!timeColumnTypeMatch) return undefined;
  return timeColumnTypeMatch[1] === undefined ? 0 : Number(timeColumnTypeMatch[1]);
}

/**
 * `[-]H:M[:S[.fraction]]` with 1-3 hour digits and 1-2 minute / second digits — the colon shapes MySQL and MariaDB
 * both read as hours, minutes and seconds (`14:30` is 14:30:00, not 00:14:30).
 */
const MYSQL_TIME_TEXT_WITH_COLONS_PATTERN = /^(-?)(\d{1,3}):(\d{1,2})(?::(\d{1,2})(?:\.(\d*))?)?$/;

/** TIME's range is -838:59:59 to 838:59:59. */
const MYSQL_MAX_TIME_HOURS = 838;

/**
 * Convert TIME text into the literal MySQL stores and returns for a TIME(fsp) column, or undefined when the text
 * isn't a shape this recognises. Shared by the write path and the field-value canonicalizer (DEV-10556), because
 * MySQL re-renders TIME on store (verified on MySQL 8.4 and MariaDB 11.4):
 * - seconds are added and every part is zero-padded (`9:05` → `09:05:00`, `1:2:3` → `01:02:03`);
 * - the fraction is TRUNCATED to the column's precision and padded to it (`14:30:00.5` → `14:30:00.500` in
 *   TIME(3)). MySQL would round (`14:30:00.999` → `14:30:01` in TIME) while MariaDB truncates, so truncating here
 *   makes both store the same value — as DATETIME does;
 * - a value that is zero after truncation loses its sign (`-00:00:00.5` in TIME is stored as `00:00:00`).
 *
 * Unrecognised text returns undefined and is sent to MySQL unchanged: its other shapes (`D HH:MM:SS` → hours,
 * `HHMMSS` / `MMSS` digit strings, `HH:MM.f`), and out-of-range values that MySQL rejects under strict mode
 * (`839:00:00`, `12:60:00`). MySQL never returns those shapes (it always reads back `[-]HH:MM:SS[.fraction]`), so
 * such a source value just compares as different from what was stored.
 */
export function convertRecognizedTimeTextToMySqlTimeLiteral(
  timeText: string,
  fractionalSecondsPrecision: number,
): string | undefined {
  const timeTextMatch = MYSQL_TIME_TEXT_WITH_COLONS_PATTERN.exec(timeText.trim());
  if (!timeTextMatch) return undefined;
  const [, negativeSign, hoursText, minutesText, secondsText = '0', fractionDigits = ''] = timeTextMatch;
  const hours = Number(hoursText);
  const minutes = Number(minutesText);
  const seconds = Number(secondsText);
  if (hours > MYSQL_MAX_TIME_HOURS || minutes > 59 || seconds > 59) return undefined;

  const fractionDigitsForColumn = fractionDigits
    .slice(0, fractionalSecondsPrecision)
    .padEnd(fractionalSecondsPrecision, '0');
  const unsignedTimeLiteral = `${padNumber(hours, 2)}:${padNumber(minutes, 2)}:${padNumber(seconds, 2)}${
    fractionDigitsForColumn.length > 0 ? `.${fractionDigitsForColumn}` : ''
  }`;
  const isZeroDuration = !/[1-9]/.test(unsignedTimeLiteral);
  return negativeSign === '-' && !isZeroDuration ? `-${unsignedTimeLiteral}` : unsignedTimeLiteral;
}
