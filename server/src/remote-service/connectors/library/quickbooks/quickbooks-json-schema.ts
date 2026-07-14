import { Kind, TSchema } from '@sinclair/typebox';
import { X_SCRATCH_READONLY } from '@spinner/shared-types';
import { BaseJsonTableSpec, EntityId, dotPath } from '../../types';
import { QBO_SCHEMA_MAP } from './quickbooks-schemas';
import { ENTITY_CONFIG, QuickBooksEntityType } from './quickbooks-types';

/**
 * Fields marked read-only on every entity they appear in, so the grid gates edits
 * and change-detection ignores them:
 * - **System/envelope fields** — QBO manages these; they're never user content.
 * - **Computed fields** — QBO derives these server-side (e.g. a transaction's
 *   `TotalAmt`/`Balance` from its lines, an account's `CurrentBalance`), so a
 *   user edit would be silently recomputed away.
 *
 * (`Id` is already annotated read-only at codegen time.) This is applied on top of
 * the auto-generated schemas rather than baked into `quickbooks-schemas.ts`, which
 * is regenerated from an upstream manifest.
 */
const QBO_READONLY_FIELD_NAMES = new Set<string>([
  // System / envelope
  'SyncToken',
  'MetaData',
  'domain',
  'sparse',
  // Computed
  'Balance',
  'TotalAmt',
  'HomeTotalAmt',
  'HomeBalance',
  'CurrentBalance',
  'CurrentBalanceWithSubAccounts',
  'FullyQualifiedName',
]);

/**
 * Build a BaseJsonTableSpec for a QuickBooks entity type using static schemas.
 *
 * Schemas are defined in quickbooks-schemas.ts based on Intuit's official API
 * documentation and the Airbyte QBO connector's field definitions.
 * All schemas have additionalProperties: true so undocumented fields pass through.
 */
export function buildQuickBooksJsonTableSpec(id: EntityId, entityType: QuickBooksEntityType): BaseJsonTableSpec {
  const config = ENTITY_CONFIG[entityType];
  const schema = markReadOnlyFields(QBO_SCHEMA_MAP[entityType]);

  return {
    id,
    slug: entityType.toLowerCase(),
    name: config.displayName,
    schema,
    idPath: dotPath('Id'),
    titlePath: dotPath(config.titleField),
    basePath: [],
    generatedAt: new Date().toISOString(),
  };
}

/**
 * Annotate the known system/computed fields (see {@link QBO_READONLY_FIELD_NAMES})
 * of an entity schema with `x-scratch-readonly`. Idempotent: sets the flag both on
 * the top-level property (where the on-disk schema and the `enforce_schema`
 * validator read it) and on each non-null variant of an optional union (where the
 * default-view builder reads it after unwrapping). Mutates the shared schema in
 * place — the flag is deterministic, so re-annotating on every call is a no-op.
 */
function markReadOnlyFields(schema: TSchema): TSchema {
  const properties = (schema as TSchema & { properties?: Record<string, TSchema> }).properties;
  if (!properties) return schema;

  for (const fieldName of Object.keys(properties)) {
    if (!QBO_READONLY_FIELD_NAMES.has(fieldName)) continue;
    setReadOnly(properties[fieldName]);
  }
  return schema;
}

/** Set `x-scratch-readonly` on a field schema and its non-null union variants. */
function setReadOnly(fieldSchema: TSchema): void {
  fieldSchema[X_SCRATCH_READONLY] = true;

  const anyOf = (fieldSchema as TSchema & { anyOf?: TSchema[] }).anyOf;
  if (anyOf) {
    for (const variant of anyOf) {
      if (variant[Kind] !== 'Null') variant[X_SCRATCH_READONLY] = true;
    }
  }
}
