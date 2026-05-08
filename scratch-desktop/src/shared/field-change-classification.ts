import type { TableViewCol } from '@spinner/shared-types';

/**
 * The shape of an edit relative to the baseline value:
 *  - populate: empty → non-empty (initial fill of a previously blank field)
 *  - rewrite:  non-empty → non-empty, with most of the text replaced
 *  - tweak:    non-empty → non-empty, with only a small portion changed in place
 *  - delete:   non-empty → empty
 */
export type FieldChangeType = 'populate' | 'rewrite' | 'tweak' | 'delete';

/**
 * Coarse size bucket for the field's content, used by rendering to pick a
 * suitable layout (inline pill vs. one-line vs. multi-line vs. expanded panel).
 */
export type FieldSize = 'XS' | 'S' | 'M' | 'L';

export interface FieldChangeClassification {
  changeType: FieldChangeType;
  fieldSize: FieldSize;
}

/** A change is "tweak"-shaped when at least this fraction of the longer text is unchanged. */
const TWEAK_KEPT_RATIO = 0.7;

/** Character-length thresholds for the size buckets (applied to whichever side has more content). */
const SIZE_XS_MAX = 30;
const SIZE_S_MAX = 80;
const SIZE_M_MAX = 280;

/** Format hints that always indicate a fixed, single-token-shaped value. */
const XS_FORMAT_HINTS = new Set([
  'date',
  'date-time',
  'datetime',
  'time',
  'email',
  'uri',
  'url',
  'uuid',
  'select',
  'singleselect',
  'single-select',
]);

function isEmpty(value: unknown): boolean {
  if (value == null) return true;
  if (typeof value === 'string') return value.trim() === '';
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === 'object') return Object.keys(value).length === 0;
  return false;
}

function valueToText(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return '';
  }
}

function commonPrefixLen(a: string, b: string): number {
  const max = Math.min(a.length, b.length);
  let i = 0;
  while (i < max && a.charCodeAt(i) === b.charCodeAt(i)) i++;
  return i;
}

function commonSuffixLen(a: string, b: string, alreadyMatchedFromStart: number): number {
  const remaining = Math.min(a.length, b.length) - alreadyMatchedFromStart;
  let i = 0;
  while (i < remaining && a.charCodeAt(a.length - 1 - i) === b.charCodeAt(b.length - 1 - i)) i++;
  return i;
}

function classifyChangeType(fromValue: unknown, toValue: unknown): FieldChangeType {
  const fromEmpty = isEmpty(fromValue);
  const toEmpty = isEmpty(toValue);
  if (fromEmpty && !toEmpty) return 'populate';
  if (!fromEmpty && toEmpty) return 'delete';

  const fromText = valueToText(fromValue);
  const toText = valueToText(toValue);
  const longer = Math.max(fromText.length, toText.length);
  if (longer === 0) return 'rewrite';

  const prefix = commonPrefixLen(fromText, toText);
  const suffix = commonSuffixLen(fromText, toText, prefix);
  const kept = prefix + suffix;
  return kept / longer >= TWEAK_KEPT_RATIO ? 'tweak' : 'rewrite';
}

function classifyFieldSize(fromValue: unknown, toValue: unknown, col: TableViewCol | undefined): FieldSize {
  const colType = col?.type;
  if (colType === 'checkbox' || colType === 'number') return 'XS';
  if (colType && XS_FORMAT_HINTS.has(colType)) return 'XS';

  // Use whichever side has more content so a populate or delete still gets sized
  // by the meaningful side, not the empty one.
  const len = Math.max(valueToText(fromValue).length, valueToText(toValue).length);

  // Structured data (objects) doesn't render as a single token even when short,
  // so floor it at S and let length push it up to M / L.
  if (colType === 'object') {
    if (len <= SIZE_S_MAX) return 'S';
    if (len <= SIZE_M_MAX) return 'M';
    return 'L';
  }

  if (len <= SIZE_XS_MAX) return 'XS';
  if (len <= SIZE_S_MAX) return 'S';
  if (len <= SIZE_M_MAX) return 'M';
  return 'L';
}

/**
 * Classify a changed field by edit shape and content size. Callers should only
 * invoke this for fields that have actually changed — the function itself does
 * not check equality and will happily classify a no-op as a `rewrite` of length 0.
 */
export function classifyFieldChange(
  fromValue: unknown,
  toValue: unknown,
  col: TableViewCol | undefined,
): FieldChangeClassification {
  return {
    changeType: classifyChangeType(fromValue, toValue),
    fieldSize: classifyFieldSize(fromValue, toValue, col),
  };
}
