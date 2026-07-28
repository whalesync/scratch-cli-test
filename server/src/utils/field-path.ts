import { TSchema, Type } from '@sinclair/typebox';
import {
  coerceFilterValue,
  findKeyedArrayElement,
  getArrayKeyedByOptions,
  parseFilterSegment,
  type ParsedFilterSegment,
} from '@spinner/shared-types';
import get from 'lodash/get';
import set from 'lodash/set';

/**
 * Field paths are dot-joined property-name segments (e.g. `properties.Name.title`).
 * The join is lossy, because a connector field name can ITSELF contain a dot — a
 * Postgres column literally named `col.with.dots`, an Airtable "No. of Employees",
 * a Notion property named "v1.2". Per the Connector Prime Directive we keep such a
 * name verbatim as a single flat property, so naive `path.split('.')` mis-segments
 * it: the schema/value lookup then either fails outright (the DEV-10959 save error
 * `Source field 'col.with.dots' not found in schema`) or, worse, silently reads /
 * writes the wrong nested location (`col.with.dots` treated as `col → with → dots`).
 *
 * These helpers recover the real segment boundaries by matching each segment,
 * longest-first, against the property names that actually exist at that level —
 * in a JSON schema (`segmentFieldPathAgainstSchema`) or in a concrete record
 * object (`segmentFieldPathAgainstObject`). Once the path diverges from the known
 * structure (no dictionary key matches) they fall back to a plain dot-split for
 * the remainder, which is byte-for-byte the old behavior. So the change is a
 * strict superset: identical results for every path whose segment names contain
 * no dots, correct results when a name does contain a dot.
 *
 * The recovered segments are then handed to lodash `get`/`set` in ARRAY form,
 * where each element is treated as a literal key (no further dot-splitting), so a
 * dotted name is read and written at exactly the flat key it names.
 *
 * A path may also address one element of a VERBATIM keyed array (a property
 * annotated with `x-scratch-array-keyed-by`, e.g. Affinity's `entity.fields`,
 * Copper's `custom_fields`, GoHighLevel's `customFields`) through a **filter
 * segment** `[<keyField>=<key>]` — `entity.fields.[id=field-5840703].value.data`.
 * `parseFilterSegment` recognizes such a segment (its grammar forbids a `.`, so it
 * is always exactly one segment); resolution then descends into the array's shared
 * element (`items`) schema on the schema side, or the element whose key matches on
 * the value side, rather than looking for a property literally named `[id=…]`.
 * Without this, the save-time validator rejected every keyed column with
 * `Source field 'entity.fields.[id=…].value.data' not found in schema` (DEV-11062).
 */

/**
 * The longest key in `availableKeys` that equals `remainingPath`, or is a prefix
 * of it ending on a dot boundary, or `undefined` when none match. Longest-first
 * so a field literally named `col.with.dots` is consumed whole rather than as its
 * shorter sibling `col` (in the vanishingly unlikely case both exist).
 */
function longestKeyMatchingPathPrefix(availableKeys: string[], remainingPath: string): string | undefined {
  let longestMatchingKey: string | undefined;
  for (const key of availableKeys) {
    if (remainingPath === key || remainingPath.startsWith(`${key}.`)) {
      if (longestMatchingKey === undefined || key.length > longestMatchingKey.length) {
        longestMatchingKey = key;
      }
    }
  }
  return longestMatchingKey;
}

/**
 * Split `path` into its real property-name segments. `propertyNamesAtNode` lists
 * the property names available at the current node (or `undefined` once structure
 * is unknown/absent), `descendIntoProperty` moves to the child node for a matched
 * key, and `descendIntoArrayElement` moves to the keyed-array element a filter
 * segment (`[<keyField>=<key>]`) addresses. Generic over the node type so it drives
 * both schema traversal and plain-object traversal.
 */
function segmentFieldPathAgainstStructure<Node>(
  path: string,
  rootNode: Node | undefined,
  propertyNamesAtNode: (node: Node) => string[] | undefined,
  descendIntoProperty: (node: Node, matchedKey: string) => Node | undefined,
  descendIntoArrayElement: (node: Node, filter: ParsedFilterSegment) => Node | undefined,
): string[] {
  const segments: string[] = [];
  let currentNode: Node | undefined = rootNode;
  let remainingPath = path;

  while (remainingPath.length > 0) {
    const nextDotIndex = remainingPath.indexOf('.');
    const nextSegment = nextDotIndex === -1 ? remainingPath : remainingPath.slice(0, nextDotIndex);

    // A keyed-array filter segment `[key=value]` addresses one array element. Its
    // grammar forbids a `.`, so it is always exactly one clean segment — consume it
    // and descend into the element so the remainder segments against the element's
    // own structure (not the array's).
    const filter = parseFilterSegment(nextSegment);
    if (filter) {
      segments.push(nextSegment);
      currentNode = currentNode === undefined ? undefined : descendIntoArrayElement(currentNode, filter);
      remainingPath = nextDotIndex === -1 ? '' : remainingPath.slice(nextDotIndex + 1);
      continue;
    }

    // Fast path: a remainder with no dot is a single, unambiguous trailing
    // segment — no dictionary lookup needed. This keeps the hot path (flat field
    // names like `name`/`title`, and the last segment of any path) free of key
    // enumeration; the dictionary is consulted only while a dot remains, i.e.
    // exactly when a name might straddle a segment boundary.
    if (nextDotIndex === -1) {
      segments.push(remainingPath);
      break;
    }

    const availableKeys = currentNode === undefined ? undefined : propertyNamesAtNode(currentNode);
    const matchedKey = availableKeys ? longestKeyMatchingPathPrefix(availableKeys, remainingPath) : undefined;

    if (matchedKey === undefined) {
      // The dictionary is exhausted or the path has diverged from the known
      // structure — segment the remainder the old (naive) way and stop consulting
      // structure from here down, since there is none we recognize.
      segments.push(nextSegment);
      remainingPath = remainingPath.slice(nextDotIndex + 1);
      currentNode = undefined;
      continue;
    }

    segments.push(matchedKey);
    currentNode = descendIntoProperty(currentNode as Node, matchedKey);
    remainingPath = remainingPath.length === matchedKey.length ? '' : remainingPath.slice(matchedKey.length + 1);
  }

  return segments;
}

/**
 * Every object-with-`properties` schema reachable from `schema` without crossing a
 * value node: the node itself when it is an object carrying `properties`, or —
 * when it is a union wrapper (`anyOf`/`oneOf` with no own `type`) — the object
 * branches of every non-null variant, recursively.
 *
 * A union may mix scalar and object branches: Pipedrive's picture field is
 * `Union[Number, Object({url}), Null]`. Plan-side subfield expansion
 * (`extractSchemaPaths` / `extractSchemaFields` in schema-helpers.ts) walks ALL
 * non-null branches, so it offers a `picture_id.url` column — resolution here must
 * search all branches too. Unwrapping only the FIRST non-null branch (`Number` →
 * no `properties`) made the save-time resolver reject the very mapping the plan
 * generated, so the untouched default Pipedrive Persons/Organizations export could
 * not be saved (DEV-11030). Matches `propertySchemaAt` in schema-helpers.ts.
 */
function objectSchemaBranchesWithProperties(schema: TSchema | undefined): TSchema[] {
  if (!schema) return [];
  if (schema.type === 'object' && schema.properties) return [schema];
  if (schema.type !== undefined) return [];
  const unionWrapper = schema as { anyOf?: TSchema[]; oneOf?: TSchema[] };
  const unionBranches = unionWrapper.anyOf ?? unionWrapper.oneOf;
  if (!unionBranches) return [];
  const objectBranches: TSchema[] = [];
  for (const branch of unionBranches) {
    if (branch.type === 'null') continue;
    objectBranches.push(...objectSchemaBranchesWithProperties(branch));
  }
  return objectBranches;
}

function schemaPropertyNames(schema: TSchema): string[] | undefined {
  const objectBranches = objectSchemaBranchesWithProperties(schema);
  if (objectBranches.length === 0) return undefined;
  const propertyNames = new Set<string>();
  for (const objectBranch of objectBranches) {
    for (const propertyName of Object.keys(objectBranch.properties as Record<string, TSchema>)) {
      propertyNames.add(propertyName);
    }
  }
  return Array.from(propertyNames);
}

/**
 * A permissive "any" schema returned for a subfield of an OPEN object (one that
 * declares `additionalProperties: true` but no named property for the subfield —
 * e.g. Affinity's `location` field value, whose `data` is
 * `Type.Object({}, { additionalProperties: true })` yet is addressed by its
 * `.streetAddress` / `.city` / … subfields). It carries no `type`, so downstream
 * type checks treat it as unknown-but-present (the mapping validates) rather than
 * absent (rejected).
 */
const OPEN_OBJECT_SUBFIELD_SCHEMA: TSchema = Type.Unknown();

/**
 * The schema for `key` under an OPEN object branch — one declaring
 * `additionalProperties` — when `key` is not a named property. A schema-valued
 * `additionalProperties` yields that schema; `additionalProperties: true` yields
 * the permissive {@link OPEN_OBJECT_SUBFIELD_SCHEMA}. Returns `undefined` for a
 * closed object (no/`false` `additionalProperties`), so a genuinely absent field
 * still resolves to absent.
 */
function openObjectSubfieldSchema(objectBranch: TSchema): TSchema | undefined {
  const additionalProperties = (objectBranch as { additionalProperties?: unknown }).additionalProperties;
  if (additionalProperties === true) return OPEN_OBJECT_SUBFIELD_SCHEMA;
  if (additionalProperties !== null && typeof additionalProperties === 'object') {
    return additionalProperties as TSchema;
  }
  return undefined;
}

function schemaPropertyValue(schema: TSchema, key: string): TSchema | undefined {
  const objectBranches = objectSchemaBranchesWithProperties(schema);
  const matchingChildSchemas: TSchema[] = [];
  for (const objectBranch of objectBranches) {
    const childSchema = (objectBranch.properties as Record<string, TSchema>)[key];
    if (childSchema !== undefined) matchingChildSchemas.push(childSchema);
  }
  if (matchingChildSchemas.length === 1) return matchingChildSchemas[0];
  if (matchingChildSchemas.length > 1) {
    // The SAME property is present on more than one union branch, each with a
    // different shape — e.g. Affinity's mixed `value` union, where every branch is
    // `{ type, data }` but `data` is a string / number / open-object depending on
    // the field's valueType. Return a synthetic union of all of them so a further
    // drill (`.data.streetAddress`) searches EVERY branch, instead of arbitrarily
    // binding to the first branch's `data` and then failing to find the subfield.
    return Type.Union(matchingChildSchemas);
  }
  // No branch names `key` explicitly — fall back to an open object's
  // `additionalProperties` (checked last so a named property always wins).
  for (const objectBranch of objectBranches) {
    const openChild = openObjectSubfieldSchema(objectBranch);
    if (openChild !== undefined) return openChild;
  }
  return undefined;
}

/** The `items` (element) schema of a plain or nullable-union array node, or `undefined`. */
function arrayItemSchema(schema: TSchema): TSchema | undefined {
  if (schema.type === 'array') {
    const items = (schema as { items?: TSchema }).items;
    return items ?? OPEN_OBJECT_SUBFIELD_SCHEMA;
  }
  const unionBranches = (schema.anyOf ?? schema.oneOf) as TSchema[] | undefined;
  if (unionBranches) {
    for (const branch of unionBranches) {
      if (branch.type === 'null') continue;
      const items = arrayItemSchema(branch);
      if (items) return items;
    }
  }
  return undefined;
}

/**
 * The shared element schema every element of a keyed array (an array annotated
 * with `x-scratch-array-keyed-by`) validates against — what a filter segment
 * `[<keyField>=<key>]` descends into on the schema side. Returns `undefined` when
 * the node is not a keyed array, so a stray filter segment against a non-keyed
 * node resolves to absent (exactly like an unknown property).
 */
export function keyedArrayItemSchema(schema: TSchema | undefined): TSchema | undefined {
  if (!schema || getArrayKeyedByOptions(schema) === undefined) return undefined;
  return arrayItemSchema(schema);
}

/** Segment `path` using the property names present in `schema` at each level. */
export function segmentFieldPathAgainstSchema(schema: TSchema, path: string): string[] {
  return segmentFieldPathAgainstStructure(path, schema, schemaPropertyNames, schemaPropertyValue, (node) =>
    keyedArrayItemSchema(node),
  );
}

function isPlainRecordObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function objectPropertyNames(value: unknown): string[] | undefined {
  return isPlainRecordObject(value) ? Object.keys(value) : undefined;
}

function objectPropertyValue(value: unknown, key: string): unknown {
  return isPlainRecordObject(value) ? value[key] : undefined;
}

/** The keyed-array element of `value` a filter segment addresses, or `undefined` when `value` is not an array. */
function objectArrayElement(value: unknown, filter: ParsedFilterSegment): unknown {
  return Array.isArray(value) ? findKeyedArrayElement(value, filter.field, filter.rawValue) : undefined;
}

/** Segment `path` using the keys present in `record` at each level. */
export function segmentFieldPathAgainstObject(record: unknown, path: string): string[] {
  return segmentFieldPathAgainstStructure(path, record, objectPropertyNames, objectPropertyValue, objectArrayElement);
}

/**
 * Resolve the schema at a field `path`, drilling through object `properties` and
 * unwrapping nullable unions at each real segment. Returns the leaf schema (with
 * its own nullable wrapper intact, as before), or `undefined` when any segment is
 * absent. Dotted-name-safe replacement for the former split-on-`.` traversal.
 */
export function getSchemaAtFieldPath(schema: TSchema, path: string): TSchema | undefined {
  const segments = segmentFieldPathAgainstSchema(schema, path);
  let node: TSchema | undefined = schema;
  for (const segment of segments) {
    if (!node) return undefined;
    // A filter segment descends into the keyed array's shared element schema;
    // every other segment is a property lookup.
    node = parseFilterSegment(segment) ? keyedArrayItemSchema(node) : schemaPropertyValue(node, segment);
  }
  return node;
}

/**
 * Read the value at a field `path` from a record object, resolving a dotted field
 * name to its flat key rather than a nested lookup, and a filter segment
 * (`[<keyField>=<key>]`) to the matching element of a verbatim keyed array.
 * Segments against the object's own keys — authoritative for what is actually
 * present.
 */
export function readFieldValueAtPath(record: unknown, path: string): unknown {
  const segments = segmentFieldPathAgainstObject(record, path);
  let node: unknown = record;
  for (const segment of segments) {
    if (node === null || node === undefined) return undefined;
    const filter = parseFilterSegment(segment);
    if (filter) {
      // Locate the keyed-array element by its key field; a non-array here means
      // the path doesn't match the value's shape, so the value is absent.
      node = Array.isArray(node) ? findKeyedArrayElement(node, filter.field, filter.rawValue) : undefined;
    } else {
      // A single-element path passes the segment as a literal key (no further
      // dot-splitting), so a dotted name reads at exactly the flat key it names.
      node = get(node, [segment]);
    }
  }
  return node;
}

/**
 * Write `value` at a field `path` into `target`, resolving a dotted field name to
 * its flat key, and a filter segment (`[<keyField>=<key>]`) to the matching
 * element of a verbatim keyed array (creating the element — seeded with its key
 * field — when absent). When `schema` is provided it is used as the segmentation
 * dictionary (authoritative even when building a fresh record whose target keys do
 * not exist yet); otherwise the target object's current keys are used.
 */
export function setFieldValueAtPath(
  target: Record<string, unknown>,
  path: string,
  value: unknown,
  schema?: TSchema,
): void {
  const segments = schema ? segmentFieldPathAgainstSchema(schema, path) : segmentFieldPathAgainstObject(target, path);
  // Fast path: no keyed-array element in the path → plain lodash `set`, which is
  // byte-for-byte the prior behavior for every non-keyed mapping.
  if (!segments.some((segment) => parseFilterSegment(segment) !== null)) {
    set(target, segments, value);
    return;
  }
  writeValueAtSegments(target, segments, value);
}

/**
 * Walk `segments` from `root`, materializing each intermediate container, and
 * assign `value` at the leaf — the keyed-array-aware counterpart to lodash `set`.
 * A filter segment resolves (or creates) the keyed element it names; a plain
 * segment resolves (or creates) an object/array child, choosing an array when the
 * NEXT segment is a filter. Bails out silently only if a keyed segment lands on a
 * non-array node whose slot is already occupied by a non-array value.
 */
function writeValueAtSegments(root: Record<string, unknown>, segments: string[], value: unknown): void {
  let container: Record<string, unknown> | unknown[] = root;

  for (let index = 0; index < segments.length; index++) {
    const segment = segments[index];
    const isLastSegment = index === segments.length - 1;
    const filter = parseFilterSegment(segment);

    if (filter) {
      if (!Array.isArray(container)) return;
      let element = findKeyedArrayElement(container, filter.field, filter.rawValue);
      if (element === undefined) {
        element = { [filter.field]: coerceFilterValue(filter.rawValue) };
        container.push(element);
      }
      if (isLastSegment) {
        // The filter is the leaf: the whole element is the value. Replace it in
        // place (preserving array order), keeping the key field so the element
        // stays addressable.
        container[container.indexOf(element)] = value;
        return;
      }
      container = element;
      continue;
    }

    if (isLastSegment) {
      (container as Record<string, unknown>)[segment] = value;
      return;
    }

    // Descend into (or create) the child. It must be an array when the next
    // segment is a filter, otherwise a plain object.
    const nextSegmentIsFilter = parseFilterSegment(segments[index + 1]) !== null;
    const existingChild: unknown = (container as Record<string, unknown>)[segment];
    if (nextSegmentIsFilter) {
      if (!Array.isArray(existingChild)) {
        const newArray: unknown[] = [];
        (container as Record<string, unknown>)[segment] = newArray;
        container = newArray;
      } else {
        container = existingChild;
      }
    } else if (isPlainRecordObject(existingChild)) {
      container = existingChild;
    } else {
      const newObject: Record<string, unknown> = {};
      (container as Record<string, unknown>)[segment] = newObject;
      container = newObject;
    }
  }
}
