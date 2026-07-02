/**
 * Keyed-array addressing — make each element of a verbatim on-disk array an
 * individually editable, individually diffable column WITHOUT reshaping the
 * array into an object.
 *
 * Some services return a record's custom-field values as an array of
 * `{ <keyField>, <value> }` pairs, e.g. Copper:
 *
 *   custom_fields: [
 *     { custom_field_definition_id: 700123, value: 'Enterprise' },
 *     { custom_field_definition_id: 700124, value: '2026-03-01' },
 *   ]
 *
 * Scratch's editable column path is a plain-object dot-path, so historically an
 * array like this had to be reshaped to a keyed object on pull (and back on
 * publish) to expose each field as a column — which rewrites the on-disk bytes
 * and breaks the product's "store the verbatim API response" invariant.
 *
 * Instead, a connector annotates the array property with
 * {@link X_SCRATCH_ARRAY_KEYED_BY} carrying an {@link ArrayKeyedByOptions}, and
 * the generic engines address elements through a **filter segment** in the path:
 *
 *   custom_fields.[custom_field_definition_id=700123].value
 *
 * `"a.b.c".split(".")` yields the filter segment `[custom_field_definition_id=700123]`
 * as its own token, so the read (`getByPath`), write (`setByPath`), column
 * builder, and publish diff all share the same tiny grammar. The array stays
 * verbatim on disk.
 */

import { X_SCRATCH_ARRAY_KEYED_BY } from './json-schema';

/** Options for the {@link X_SCRATCH_ARRAY_KEYED_BY} annotation on an array property. */
export interface ArrayKeyedByOptions {
  /**
   * The element field whose value identifies each element (e.g.
   * `'custom_field_definition_id'`). Must be a stable, collision-free,
   * path-safe id on every element — never a renameable label.
   */
  keyField: string;
  /**
   * Dot-path within an element to the editable value (e.g. `'value'`). Omit to
   * make the whole element the editable value.
   */
  valuePath?: string;
  /** The known keys, each expanded into one column. */
  columns: ArrayKeyedColumn[];
}

/** One expandable column within a keyed array (one element key → one table column). */
export interface ArrayKeyedColumn {
  /**
   * The element's key-field value that identifies this element (e.g. `700123`
   * or `'contact.email'`). Compared against `String(element[keyField])`.
   */
  key: string | number;
  /** Human-readable column name. */
  name: string;
  /** Optional column data-type hint for the renderer. */
  type?: string;
  /** Whether this column is read-only. */
  readonly?: boolean;
}

/**
 * A filter segment addresses one array element by a key field:
 * `[<field>=<value>]`. Field and value may not contain `.` (the path delimiter),
 * `=`, or `]`. Values are matched/created via {@link coerceFilterValue}.
 */
const FILTER_SEGMENT_PATTERN = /^\[([^=.\]]+)=([^=.\]]*)\]$/;

/** A parsed filter segment: which element field to match, and the value to match it to. */
export interface ParsedFilterSegment {
  field: string;
  /** The raw (string) value from the path, before {@link coerceFilterValue}. */
  rawValue: string;
}

/**
 * Parse a single path segment as an array filter (`[field=value]`), or return
 * `null` if it isn't one (a plain object key). Callers split the full path on
 * `.` and pass each segment here.
 */
export function parseFilterSegment(segment: string): ParsedFilterSegment | null {
  const match = FILTER_SEGMENT_PATTERN.exec(segment);
  if (!match) return null;
  return { field: match[1], rawValue: match[2] };
}

/** Build the filter segment string for a key (`700123` → `[custom_field_definition_id=700123]`). */
export function buildFilterSegment(keyField: string, key: string | number): string {
  return `[${keyField}=${key}]`;
}

/**
 * Build the full column path for one keyed-array element:
 * `custom_fields` + `[custom_field_definition_id=700123]` + `.value`.
 */
export function buildKeyedArrayColumnPath(
  arrayPropertyPath: string,
  keyField: string,
  key: string | number,
  valuePath?: string,
): string {
  const filter = buildFilterSegment(keyField, key);
  const base = `${arrayPropertyPath}.${filter}`;
  return valuePath ? `${base}.${valuePath}` : base;
}

/**
 * Coerce a filter value (always a string in the path) back to the type the
 * element's key field uses: an all-digits value becomes a number (Copper
 * numeric definition ids); anything else stays a string (GoHighLevel string
 * short-keys). Used when creating a missing element on write.
 */
export function coerceFilterValue(rawValue: string): string | number {
  return /^-?\d+$/.test(rawValue) ? Number(rawValue) : rawValue;
}

/** Whether a value is a plain (non-array, non-null) object. */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Read the {@link X_SCRATCH_ARRAY_KEYED_BY} options off a property schema, or
 * `undefined` if the property is not a keyed array. Looks on the property
 * directly and inside its `anyOf`/`oneOf` members (the nullable/optional pattern
 * — `Type.Optional(Type.Array(...))` keeps the annotation on the array member).
 */
export function getArrayKeyedByOptions(propSchema: unknown): ArrayKeyedByOptions | undefined {
  if (!isPlainRecord(propSchema)) return undefined;
  const direct = propSchema[X_SCRATCH_ARRAY_KEYED_BY];
  if (isArrayKeyedByOptions(direct)) return direct;
  for (const unionKey of ['anyOf', 'oneOf'] as const) {
    const union = propSchema[unionKey];
    if (!Array.isArray(union)) continue;
    for (const member of union) {
      const found = getArrayKeyedByOptions(member);
      if (found) return found;
    }
  }
  return undefined;
}

function isArrayKeyedByOptions(value: unknown): value is ArrayKeyedByOptions {
  return isPlainRecord(value) && typeof value.keyField === 'string' && Array.isArray(value.columns);
}

/**
 * Find the element of `array` whose `String(element[field]) === rawValue`, or
 * `undefined`. Comparison is stringwise so a numeric key field matches its
 * string path value.
 */
export function findKeyedArrayElement(
  array: readonly unknown[],
  field: string,
  rawValue: string,
): Record<string, unknown> | undefined {
  for (const element of array) {
    if (isPlainRecord(element) && String(element[field]) === rawValue) {
      return element;
    }
  }
  return undefined;
}

/**
 * Element-wise diff of a keyed array: return the sparse list of `dirty` elements
 * that differ from (or are absent in) `main`, matched by `keyField`. This is the
 * publish payload a service that applies "only the sent elements" expects — e.g.
 * Copper's `[{ custom_field_definition_id, value }]`. Elements present only in
 * `main` (removed) are not tracked, mirroring `computeChangedFields`' semantics
 * (clear a field by setting its value, not by removing the element).
 */
export function diffKeyedArrayElements(mainArray: unknown, dirtyArray: unknown, keyField: string): unknown[] {
  if (!Array.isArray(dirtyArray)) return [];
  const mainByKey = new Map<string, unknown>();
  if (Array.isArray(mainArray)) {
    for (const element of mainArray) {
      if (isPlainRecord(element)) mainByKey.set(String(element[keyField]), element);
    }
  }
  const changed: unknown[] = [];
  for (const element of dirtyArray) {
    if (!isPlainRecord(element)) continue;
    const mainElement = mainByKey.get(String(element[keyField]));
    if (JSON.stringify(element) !== JSON.stringify(mainElement)) {
      changed.push(element);
    }
  }
  return changed;
}
