import { TSchema } from '@sinclair/typebox';
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
 * is unknown/absent), and `descendIntoProperty` moves to the child node for a
 * matched key. Generic over the node type so it drives both schema traversal and
 * plain-object traversal.
 */
function segmentFieldPathAgainstStructure<Node>(
  path: string,
  rootNode: Node | undefined,
  propertyNamesAtNode: (node: Node) => string[] | undefined,
  descendIntoProperty: (node: Node, matchedKey: string) => Node | undefined,
): string[] {
  const segments: string[] = [];
  let currentNode: Node | undefined = rootNode;
  let remainingPath = path;

  while (remainingPath.length > 0) {
    // Fast path: a remainder with no dot is a single, unambiguous trailing
    // segment — no dictionary lookup needed. This keeps the hot path (flat field
    // names like `name`/`title`, and the last segment of any path) free of key
    // enumeration; the dictionary is consulted only while a dot remains, i.e.
    // exactly when a name might straddle a segment boundary.
    if (!remainingPath.includes('.')) {
      segments.push(remainingPath);
      break;
    }

    const availableKeys = currentNode === undefined ? undefined : propertyNamesAtNode(currentNode);
    const matchedKey = availableKeys ? longestKeyMatchingPathPrefix(availableKeys, remainingPath) : undefined;

    if (matchedKey === undefined) {
      // The dictionary is exhausted or the path has diverged from the known
      // structure — segment the remainder the old (naive) way and stop consulting
      // structure from here down, since there is none we recognize.
      const nextDotIndex = remainingPath.indexOf('.');
      if (nextDotIndex === -1) {
        segments.push(remainingPath);
        remainingPath = '';
      } else {
        segments.push(remainingPath.slice(0, nextDotIndex));
        remainingPath = remainingPath.slice(nextDotIndex + 1);
      }
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
 * Unwrap a nullable/Optional `anyOf` wrapper to the underlying object schema, and
 * return it only when it is an object carrying `properties`. Mirrors the wrapper
 * handling the previous {@link getSchemaAtPath} implementation did inline.
 */
function objectSchemaWithProperties(schema: TSchema | undefined): TSchema | undefined {
  let node: TSchema | undefined = schema;
  if (node && node.type === undefined) {
    const anyOfBranches = (node as { anyOf?: TSchema[] }).anyOf;
    if (anyOfBranches) {
      node = anyOfBranches.find((branch) => branch.type !== 'null');
    }
  }
  if (!node || node.type !== 'object' || !node.properties) {
    return undefined;
  }
  return node;
}

function schemaPropertyNames(schema: TSchema): string[] | undefined {
  const objectSchema = objectSchemaWithProperties(schema);
  return objectSchema ? Object.keys(objectSchema.properties as Record<string, TSchema>) : undefined;
}

function schemaPropertyValue(schema: TSchema, key: string): TSchema | undefined {
  const objectSchema = objectSchemaWithProperties(schema);
  return objectSchema ? (objectSchema.properties as Record<string, TSchema>)[key] : undefined;
}

/** Segment `path` using the property names present in `schema` at each level. */
export function segmentFieldPathAgainstSchema(schema: TSchema, path: string): string[] {
  return segmentFieldPathAgainstStructure(path, schema, schemaPropertyNames, schemaPropertyValue);
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

/** Segment `path` using the keys present in `record` at each level. */
export function segmentFieldPathAgainstObject(record: unknown, path: string): string[] {
  return segmentFieldPathAgainstStructure(path, record, objectPropertyNames, objectPropertyValue);
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
    node = schemaPropertyValue(node, segment);
  }
  return node;
}

/**
 * Read the value at a field `path` from a record object, resolving a dotted field
 * name to its flat key rather than a nested lookup. Segments against the object's
 * own keys — authoritative for what is actually present.
 */
export function readFieldValueAtPath(record: unknown, path: string): unknown {
  return get(record, segmentFieldPathAgainstObject(record, path));
}

/**
 * Write `value` at a field `path` into `target`, resolving a dotted field name to
 * its flat key. When `schema` is provided it is used as the segmentation
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
  set(target, segments, value);
}
