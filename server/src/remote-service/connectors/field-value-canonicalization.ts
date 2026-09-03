import type { TSchema } from '@sinclair/typebox';
import isEqual from 'lodash/isEqual';
import { WSLogger } from 'src/logger';
import { getSchemaAtFieldPath } from 'src/utils/field-path';
import { extractSchemaFields, SchemaField } from 'src/utils/schema-helpers';
import { connectorRegistry } from './connector-registry';
import type { BaseJsonTableSpec } from './types';

/**
 * Field-value canonicalization — the "diff transform" framework (DEV-10556).
 *
 * A Live Export sync writes a destination field in the connector's minimal WRITE
 * shape (e.g. Notion `{ type: 'title', title: [{ type: 'text', text: { content } }] }`),
 * but the destination stores and reads back a richer / differently-rendered
 * shape (Notion decorates every span with `annotations`/`href`/`plain_text`;
 * Airtable omits empty fields from the read entirely; Postgres re-renders
 * `timestamptz` and float values). Compared structurally, the two never match,
 * so every record looks changed on every run and re-publishes forever.
 *
 * A connector can declare, per destination field, how to reduce any stored value
 * of that field to a CANONICAL form — ideally a primitive — such that two values
 * the service would treat as the same value have deep-equal canonical forms.
 * The sync's per-field overlay consults these canonicalizers for EQUALITY ONLY:
 * a canonical value is never written to disk and never sent to a service. The
 * read-only publish diff view (`PublishPlanDiffService.getFileDiffForPublishPlan`)
 * additionally renders record fields in their canonical forms, for DISPLAY
 * ONLY, so that view shows what actually changed rather than how the service
 * re-rendered it. (The publish-plan build's `computeChangedFields` deliberately
 * does not consult them, so a local edit that only differs canonically still
 * publishes.)
 *
 * Connectors opt in by registering `resolveFieldValueCanonicalizer` on their
 * {@link ConnectorRegistration}; connectors whose read and write shapes already
 * match simply omit it and keep today's structural compare.
 */

/**
 * Reduces one stored value of a destination field to the canonical form the
 * service will hold after a write round-trip. Two values are "the same" for
 * diffing iff their canonical forms are deep-equal.
 *
 * Contract: pure, total, synchronous. Return the input unchanged for any shape
 * you don't recognise (it then compares structurally). `undefined` input means
 * "the key is absent on the record".
 */
export type FieldValueCanonicalizer = (value: unknown) => unknown;

/** What a connector's `resolveFieldValueCanonicalizer` hook sees for one destination field. */
export interface FieldValueCanonicalizerContext {
  /** Dotted field path as `extractSchemaFields` reports it: `'properties.Name'`, `'fields.Notes'`, `'created_at'`. */
  fieldPath: string;
  /**
   * The field's JSON-schema node — carries the connector's own annotations
   * (`x-scratch-connector-data-type`, `format`, `x-scratch-suggested-transformer`, …).
   * `undefined` when the path cannot be resolved against the schema.
   */
  fieldSchema: TSchema | undefined;
  /** Convenience projection of the same node (type / format / remoteFieldId / readonly / suggestedTransformer …). */
  schemaField: SchemaField;
  tableSpec: BaseJsonTableSpec;
}

/** Field path → canonicalizer, for every field of a destination table that declares one. */
export type FieldValueCanonicalizerMap = ReadonlyMap<string, FieldValueCanonicalizer>;

const EMPTY_CANONICALIZER_MAP: FieldValueCanonicalizerMap = new Map();

/** Memo keyed by the table-spec object identity — a sync or a publish build re-uses one spec object per folder. */
const canonicalizerMapMemoByTableSpec = new WeakMap<BaseJsonTableSpec, Map<string, FieldValueCanonicalizerMap>>();

/**
 * Resolve the canonicalizers a destination table's connector declares for its
 * fields — without instantiating the connector or touching any remote API.
 *
 * Returns an empty map for an unknown service, a connector that registers no
 * `resolveFieldValueCanonicalizer`, or a table with no schema. Memoised per
 * `tableSpec` object (and service), so calling it per record is cheap.
 */
export function resolveFieldValueCanonicalizersForTable(
  service: string,
  tableSpec: BaseJsonTableSpec | null | undefined,
): FieldValueCanonicalizerMap {
  if (!tableSpec?.schema) {
    return EMPTY_CANONICALIZER_MAP;
  }
  const registration = connectorRegistry.get(service);
  const resolveFieldValueCanonicalizer = registration?.resolveFieldValueCanonicalizer;
  if (!resolveFieldValueCanonicalizer) {
    return EMPTY_CANONICALIZER_MAP;
  }

  let memoForSpec = canonicalizerMapMemoByTableSpec.get(tableSpec);
  if (!memoForSpec) {
    memoForSpec = new Map();
    canonicalizerMapMemoByTableSpec.set(tableSpec, memoForSpec);
  }
  const memoised = memoForSpec.get(service);
  if (memoised) {
    return memoised;
  }

  const canonicalizerByFieldPath = new Map<string, FieldValueCanonicalizer>();
  const schema = tableSpec.schema;
  for (const schemaField of extractSchemaFields(schema)) {
    let fieldSchema: TSchema | undefined;
    try {
      fieldSchema = getSchemaAtFieldPath(schema, schemaField.path);
    } catch {
      fieldSchema = undefined;
    }
    let canonicalizer: FieldValueCanonicalizer | undefined;
    try {
      canonicalizer = resolveFieldValueCanonicalizer({
        fieldPath: schemaField.path,
        fieldSchema,
        schemaField,
        tableSpec,
      });
    } catch (error) {
      WSLogger.warn({
        source: 'resolveFieldValueCanonicalizersForTable',
        message: `Connector ${service} threw resolving a field-value canonicalizer for ${schemaField.path}; comparing that field structurally`,
        error,
      });
      canonicalizer = undefined;
    }
    if (canonicalizer) {
      canonicalizerByFieldPath.set(schemaField.path, canonicalizer);
    }
  }

  const result: FieldValueCanonicalizerMap =
    canonicalizerByFieldPath.size === 0 ? EMPTY_CANONICALIZER_MAP : canonicalizerByFieldPath;
  memoForSpec.set(service, result);
  return result;
}

/**
 * True when `a` and `b` are the same value under `canonicalizer` — i.e. their
 * canonical forms are deep-equal. A canonicalizer that throws is treated as
 * having no opinion: the values fall back to a structural deep-equal (and the
 * throw is logged once per process so a buggy canonicalizer is visible without
 * failing the sync or publish).
 */
export function areFieldValuesCanonicallyEqual(
  canonicalizer: FieldValueCanonicalizer,
  a: unknown,
  b: unknown,
): boolean {
  try {
    return isEqual(canonicalizer(a), canonicalizer(b));
  } catch (error) {
    warnOnceAboutThrowingCanonicalizer(error);
    return isEqual(a, b);
  }
}

let hasWarnedAboutThrowingCanonicalizer = false;
function warnOnceAboutThrowingCanonicalizer(error: unknown): void {
  if (hasWarnedAboutThrowingCanonicalizer) return;
  hasWarnedAboutThrowingCanonicalizer = true;
  WSLogger.warn({
    source: 'areFieldValuesCanonicallyEqual',
    message: 'A field-value canonicalizer threw; falling back to structural comparison for that field (logged once)',
    error,
  });
}
