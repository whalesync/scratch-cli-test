import { coerceFilterValue, findKeyedArrayElement, parseFilterSegment } from '@spinner/shared-types';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Walks a dot-separated column id against a record JSON, returning the raw value or `undefined`
 * when any segment is missing.
 *
 * Plain arrays are leaves — we never index into them positionally. The one exception is a
 * **keyed-array filter segment** `[<field>=<value>]` (see `@spinner/shared-types` keyed-array):
 * when the current value is an array, that segment selects the element whose
 * `String(element[field]) === value`, so a verbatim `custom_fields` array can still expose each
 * element as an editable column via `custom_fields.[custom_field_definition_id=700123].value`.
 */
export function getByPath(source: Record<string, unknown>, id: string): unknown {
  const segments = id.split('.');
  let current: unknown = source;
  for (const segment of segments) {
    const filter = parseFilterSegment(segment);
    if (filter) {
      if (!Array.isArray(current)) return undefined;
      current = findKeyedArrayElement(current, filter.field, filter.rawValue);
      continue;
    }
    if (!isPlainObject(current)) return undefined;
    current = current[segment];
  }
  return current;
}

/**
 * Immutably sets a value at a dot-separated column path, returning a shallow clone of the record
 * with only the affected containers replaced. Mirrors {@link getByPath}: a segment is normally an
 * object key, but a **keyed-array filter segment** `[<field>=<value>]` addresses an element of an
 * array — the matching element is updated in place, or a new `{ [field]: <value> }` element is
 * appended when none matches (so editing a not-yet-present keyed field round-trips). The array
 * stays a verbatim array; only the addressed element changes.
 */
export function setByPath(
  record: Record<string, unknown>,
  columnPath: string,
  value: unknown,
): Record<string, unknown> {
  // The record root is an object and a column path's first segment is always a plain key, so the
  // top-level result is always an object.
  return setValueAtPath(record, columnPath, value) as Record<string, unknown>;
}

function setValueAtPath(container: unknown, columnPath: string, value: unknown): unknown {
  const [head, ...rest] = columnPath.split('.');
  const filter = parseFilterSegment(head);

  if (filter) {
    const array = Array.isArray(container) ? container : [];
    const index = array.findIndex((el) => isPlainObject(el) && String(el[filter.field]) === filter.rawValue);
    const existing =
      index >= 0 && isPlainObject(array[index]) ? array[index] : { [filter.field]: coerceFilterValue(filter.rawValue) };
    const nextElement = rest.length === 0 ? value : setValueAtPath(existing, rest.join('.'), value);
    const nextArray = array.slice();
    if (index >= 0) nextArray[index] = nextElement;
    else nextArray.push(nextElement);
    return nextArray;
  }

  const obj = isPlainObject(container) ? container : {};
  if (rest.length === 0) {
    return { ...obj, [head]: value };
  }
  // A child whose next segment is a filter must be an array; otherwise a plain object.
  const childIsArray = parseFilterSegment(rest[0]) !== null;
  const rawChild = obj[head];
  const child = childIsArray ? (Array.isArray(rawChild) ? rawChild : []) : isPlainObject(rawChild) ? rawChild : {};
  return { ...obj, [head]: setValueAtPath(child, rest.join('.'), value) };
}
