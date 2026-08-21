import type { ClientSafeTransformer } from '@spinner/shared-types';
import { applyClientSafeTransformer } from '@spinner/shared-types/transform';
import type { FieldValueCanonicalizer } from './field-value-canonicalization';

/**
 * Reusable building blocks for a connector's `resolveFieldValueCanonicalizer`
 * hook (see `field-value-canonicalization.ts`). Each one is a pure, total,
 * synchronous `value → canonical value` function that PASSES THROUGH any shape
 * it doesn't recognise, so connectors can compose them freely and unknown
 * inputs still compare structurally.
 */

/** Runs `steps` left to right. */
export function composeCanonicalizers(...steps: FieldValueCanonicalizer[]): FieldValueCanonicalizer {
  return (value) => steps.reduce<unknown>((current, step) => step(current), value);
}

export interface EmptyAsNullOptions {
  /** Treat `false` as empty too — for a destination that omits an unchecked checkbox on read (Airtable). */
  falseIsEmpty?: boolean;
  /** Treat `[]` as empty too — for a destination that omits an empty multi-value field on read (Airtable). */
  emptyArrayIsEmpty?: boolean;
}

/**
 * Maps every spelling of "no value" — an absent key (`undefined`), `null`, `''`,
 * and optionally `false` / `[]` — to `null`, so a destination that omits or
 * normalises empty fields on read compares equal to the empty value we wrote.
 * Non-empty values pass through.
 */
export function emptyAsNull(options: EmptyAsNullOptions = {}): FieldValueCanonicalizer {
  return (value) => {
    if (value === undefined || value === null || value === '') return null;
    if (options.falseIsEmpty && value === false) return null;
    if (options.emptyArrayIsEmpty && Array.isArray(value) && value.length === 0) return null;
    return value;
  };
}

export type InstantTruncationUnit = 'millisecond' | 'second' | 'minute' | 'hour' | 'day';

const MILLISECONDS_PER_UNIT: Record<InstantTruncationUnit, number> = {
  millisecond: 1,
  second: 1_000,
  minute: 60_000,
  hour: 3_600_000,
  day: 86_400_000,
};

/**
 * Reduces a date/date-time STRING to the instant it denotes, as epoch
 * milliseconds truncated to `unit` — so `2026-07-23T21:12:27Z`,
 * `2026-07-23T21:12:27.000+00:00` and `2026-07-23 21:12:27+00` all canonicalise
 * to the same number, and a destination that drops seconds (or stores only the
 * calendar day) compares equal to the more precise value we sent. Strings that
 * don't parse as a date, and non-strings, pass through unchanged.
 *
 * `unit: 'day'` truncates in UTC: a date-only `2026-12-25` and the midnight-UTC
 * timestamp the destination renders it as (`2026-12-25T00:00:00.000Z`) agree.
 */
export function isoInstantTruncatedTo(unit: InstantTruncationUnit): FieldValueCanonicalizer {
  const unitMilliseconds = MILLISECONDS_PER_UNIT[unit];
  return (value) => {
    if (typeof value !== 'string' || value.trim() === '') return value;
    const epochMilliseconds = Date.parse(value);
    if (Number.isNaN(epochMilliseconds)) return value;
    return Math.floor(epochMilliseconds / unitMilliseconds) * unitMilliseconds;
  };
}

/**
 * Rounds a finite number to `significantDigits` significant digits, so a value
 * that survives a float64 round-trip through the destination with a different
 * last digit (`0.30000000000000004` vs `0.3`) compares equal. With
 * `parseNumericStrings`, a string that is a plain decimal literal (how the `pg`
 * driver returns `numeric`/`bigint`) is parsed first. Everything else passes through.
 */
export function numberRoundedToSignificantDigits(
  significantDigits: number,
  options: { parseNumericStrings?: boolean } = {},
): FieldValueCanonicalizer {
  return (value) => {
    let numeric: unknown = value;
    if (
      options.parseNumericStrings &&
      typeof value === 'string' &&
      /^-?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(value.trim())
    ) {
      numeric = Number(value);
    }
    if (typeof numeric !== 'number' || !Number.isFinite(numeric)) return value;
    return Number(numeric.toPrecision(significantDigits));
  };
}

/**
 * Normalises the TEXT of a decimal literal without going through a float — so an
 * arbitrary-precision value a driver hands back as a string (`"1.50"`, `"+7"`,
 * `"9007199254740993"`) compares equal to the same number spelled differently
 * (`1.5`, `7`, `"9007199254740993"`) while two values that differ only beyond
 * float64 precision stay different. A number is rendered with `String()` first;
 * anything that isn't a plain decimal literal passes through.
 */
export function decimalTextNormalized(): FieldValueCanonicalizer {
  return (value) => {
    const text = typeof value === 'number' && Number.isFinite(value) ? String(value) : value;
    if (typeof text !== 'string') return value;
    const match = /^\s*([-+]?)0*(\d+)(?:\.(\d*?)0*)?\s*$/.exec(text);
    if (!match) return value;
    const [, sign, integerPart, fractionPart] = match;
    const magnitude = fractionPart ? `${integerPart}.${fractionPart}` : integerPart;
    const isZero = /^[0.]*$/.test(magnitude);
    return `${sign === '-' && !isZero ? '-' : ''}${magnitude}`;
  };
}

/**
 * Parses a string holding a JSON object or array into the value it encodes, so
 * a destination that re-serialises JSON (key order, whitespace) compares equal
 * to what we wrote. Strings that aren't JSON objects/arrays, and non-strings,
 * pass through.
 */
export function parsedJsonText(): FieldValueCanonicalizer {
  return (value) => {
    if (typeof value !== 'string') return value;
    const trimmed = value.trim();
    if (!(trimmed.startsWith('{') || trimmed.startsWith('['))) return value;
    try {
      return JSON.parse(trimmed) as unknown;
    } catch {
      return value;
    }
  };
}

/**
 * Runs a client-safe (pure, synchronous) transformer — typically the connector's
 * own declared outbound unpack (`x-scratch-suggested-transformer`, e.g. a
 * `jsonpath` `$.rich_text[*].plain_text` concat) — so the canonical form of a
 * native envelope is the plain value the connector itself says it carries.
 * A transformer that fails closed (`ok: false`) passes the value through.
 */
export function unpackedWithClientSafeTransformer(transformer: ClientSafeTransformer): FieldValueCanonicalizer {
  return (value) => {
    if (value === undefined || value === null) return value;
    const result = applyClientSafeTransformer(transformer, value);
    return result.ok ? result.value : value;
  };
}

/**
 * Canonicalises a small envelope object key by key: for a plain-object input,
 * returns `{ key: canonicalizer(input[key]) }` for exactly the keys listed
 * (absent keys canonicalise from `undefined`, so `{ start }` and
 * `{ start, end: null, time_zone: null }` can agree). Non-objects pass through.
 */
export function pickedAndCanonicalized(
  canonicalizerByKey: Record<string, FieldValueCanonicalizer>,
): FieldValueCanonicalizer {
  return (value) => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return value;
    const input = value as Record<string, unknown>;
    const canonical: Record<string, unknown> = {};
    for (const [key, canonicalizer] of Object.entries(canonicalizerByKey)) {
      canonical[key] = canonicalizer(input[key]);
    }
    return canonical;
  };
}

/** Identity — handy as a `pickedAndCanonicalized` entry for a key that should compare as-is. */
export const asIs: FieldValueCanonicalizer = (value) => value;
