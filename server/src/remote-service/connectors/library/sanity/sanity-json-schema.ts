import { TObject, TSchema, Type } from '@sinclair/typebox';
import {
  ForeignKeyOptionSchema,
  TransformerTypes,
  X_SCRATCH_CONNECTOR_DATA_TYPE,
  X_SCRATCH_FOREIGN_KEY_OPTIONS,
  X_SCRATCH_LAST_MODIFIED_FIELD,
  X_SCRATCH_READONLY,
  X_SCRATCH_SUGGESTED_TRANSFORMER,
  X_SCRATCH_WRITE_ONCE,
} from '@spinner/shared-types';
import { BaseJsonTableSpec, dotPath, EntityId } from '../../types';
import { inferJsonSchema } from '../generic-api/generic-api-schema-inference';
import { inferredSchemaToTableSchema } from '../generic-api/generic-api-schema-to-typebox';
import { SanityDeployedObjectFieldEnrichment, SanityDeployedTypeEnrichment } from './sanity-deployed-schema';
import { SanityDocument } from './sanity-types';

/**
 * Schema builder for Sanity document types.
 *
 * The Content Lake is genuinely schemaless — the content model lives in the customer's
 * Studio codebase, not in the service — so the table schema is inferred from a sample of
 * the type's own documents (what the documents actually contain IS the ground truth).
 *
 * When the project has DEPLOYED its Studio schema into the dataset (`sanity schema
 * deploy` stores `_.schemas.<workspace>` system documents), the parsed declaration
 * enriches the inferred schema — see `applyDeployedSchemaEnrichmentToTableSchema`:
 * authored field order replaces the Content Lake's alphabetical key order, declared
 * titles land on the (non-enforced) JSON Schema `title` keyword, and reference `to:`
 * targets fill FKs without the sampling lookup. Inference remains the base layer, so
 * legacy fields that exist only in old documents never disappear, and the enrichment
 * never adds validation constraints (the store stays schemaless in truth — deployed
 * declarations are aspiration, not enforcement).
 */

/**
 * How many recent documents to sample when inferring a type's schema. Matches the
 * generic inference walker's own cap (SCHEMA_INFERENCE_RECORD_CAP). 100 proved too
 * small in the live-export audit: 210 same-shaped filler documents seeded after a
 * wide torture document pushed it out of the most-recently-edited window, so its
 * fields vanished from the schema (and therefore from the export). 500 raises the
 * ceiling; the deployed Studio schema (when present) is the real fix for shape
 * coverage beyond any sample.
 */
export const SANITY_SCHEMA_INFERENCE_SAMPLE_SIZE = 500;

/**
 * System fields the service computes — never accepted on a write. `_type` is the
 * exception: it must be SET on create but is immutable afterwards (write-once).
 */
const SANITY_READONLY_SYSTEM_FIELD_NAMES = ['_id', '_rev', '_createdAt', '_updatedAt'] as const;

/** Field names tried, in order, as the record title column. */
const TITLE_FIELD_NAME_CANDIDATES = ['title', 'name', 'label'] as const;

export function buildSanityJsonTableSpec(args: {
  id: EntityId;
  typeName: string;
  datasetName: string;
  sampledDocuments: SanityDocument[];
  /**
   * fieldName → the `_type` its sampled `_ref`s point at, resolved by the connector with an
   * extra GROQ lookup (see `collectReferenceFieldSampleRefIds`). A field appears here only
   * when every sampled reference targets ONE type — mixed-target references stay unannotated.
   */
  referenceFieldTargetTypeNames?: Map<string, string>;
  /**
   * What the deployed Studio schema (if any) declares about this type: authored field
   * order, human titles, nested-object sub-field order/titles. Optional — absence means
   * pure inference, which is exactly the pre-enrichment behavior.
   */
  deployedTypeEnrichment?: SanityDeployedTypeEnrichment;
}): BaseJsonTableSpec {
  const { id, typeName, datasetName, sampledDocuments, referenceFieldTargetTypeNames, deployedTypeEnrichment } = args;

  const inferredSchema = inferJsonSchema(sampledDocuments);
  // The store is schemaless: a field present on every sampled document is still not
  // guaranteed on the next one, so declaring `required` from a sample would manufacture
  // false-positive enforce_schema errors. Only the service-guaranteed system fields
  // (`_id`, `_type`) stay required.
  inferredSchema.required = ['_id', '_type'].filter((fieldName) => fieldName in inferredSchema.properties);

  const tableSchema = inferredSchemaToTableSchema(
    inferredSchema,
    `Sanity documents of type "${typeName}" in dataset "${datasetName}"`,
  ) as TObject;

  ensureSystemFieldsPresent(tableSchema);
  annotateSystemFields(tableSchema);
  annotateValueShapesFromSamples(tableSchema, sampledDocuments);
  annotateReferenceFields(tableSchema, id, sampledDocuments, referenceFieldTargetTypeNames);
  if (deployedTypeEnrichment) {
    applyDeployedSchemaEnrichmentToTableSchema(tableSchema, deployedTypeEnrichment);
  }

  return {
    id,
    slug: id.wsId,
    name: typeName,
    schema: tableSchema,
    idPath: dotPath('_id'),
    titlePath: findTitlePath(tableSchema),
    slugPath: findSlugPath(tableSchema),
    basePath: [datasetName],
    // No remoteWebUrl: a constructible deep link requires a deployed Studio host, which
    // most projects' management metadata doesn't guarantee — omit rather than guess.
    generatedAt: new Date().toISOString(),
  };
}

/**
 * Merge what the deployed Studio schema declares onto the sample-inferred table schema.
 * SCHEMA METADATA ONLY — stored records are never reshaped, and nothing here adds a
 * validation constraint (`title` is a non-enforced JSON Schema annotation; reordering
 * `properties` carries no semantics for validation):
 *
 *   - Top-level properties are reordered to the AUTHORED field order; fields the
 *     deployed schema doesn't mention (legacy fields living only in old documents,
 *     plus the `_*` system fields) keep their existing relative order AFTER the
 *     authored ones — inference-contributed fields never disappear.
 *   - Declared field titles land on the `title` keyword of each field schema, for the
 *     view layer to prefer over name-humanization.
 *   - Nested plain-object fields (e.g. `seo`) get the same order + title treatment on
 *     their sub-properties, so banner-group children follow the authored order.
 *
 * Only fields that inference actually produced are touched: a deployed-declared field
 * no sampled document carries is NOT invented here (its value shape is unknown and the
 * schema must describe what pulls really return).
 */
export function applyDeployedSchemaEnrichmentToTableSchema(
  tableSchema: TObject,
  deployedTypeEnrichment: SanityDeployedTypeEnrichment,
): void {
  tableSchema.properties = reorderPropertiesByDeployedOrder(
    tableSchema.properties,
    deployedTypeEnrichment.orderedFieldNames,
  );

  for (const [fieldName, declaredTitle] of deployedTypeEnrichment.fieldTitlesByName.entries()) {
    const fieldSchema = tableSchema.properties[fieldName] as TSchema | undefined;
    if (fieldSchema) fieldSchema.title = declaredTitle;
  }

  for (const [fieldName, objectFieldEnrichment] of deployedTypeEnrichment.objectFieldEnrichmentsByFieldName.entries()) {
    const fieldSchema = tableSchema.properties[fieldName] as TSchema | undefined;
    if (!fieldSchema) continue;
    applyDeployedObjectFieldEnrichment(fieldSchema, objectFieldEnrichment);
  }
}

function applyDeployedObjectFieldEnrichment(
  objectFieldSchema: TSchema,
  objectFieldEnrichment: SanityDeployedObjectFieldEnrichment,
): void {
  const subProperties = objectFieldSchema.properties as Record<string, TSchema> | undefined;
  if (!subProperties) return;
  objectFieldSchema.properties = reorderPropertiesByDeployedOrder(
    subProperties,
    objectFieldEnrichment.orderedSubFieldNames,
  );
  for (const [subFieldName, declaredSubFieldTitle] of objectFieldEnrichment.subFieldTitlesByName.entries()) {
    const subFieldSchema = (objectFieldSchema.properties as Record<string, TSchema>)[subFieldName] as
      | TSchema
      | undefined;
    if (subFieldSchema) subFieldSchema.title = declaredSubFieldTitle;
  }
}

/** Authored-order fields first (when present), then everything else in its existing order. */
function reorderPropertiesByDeployedOrder<TProperties extends Record<string, TSchema>>(
  existingProperties: TProperties,
  deployedOrderedFieldNames: string[],
): TProperties {
  const reorderedProperties: Record<string, TSchema> = {};
  for (const fieldName of deployedOrderedFieldNames) {
    if (fieldName in existingProperties) reorderedProperties[fieldName] = existingProperties[fieldName];
  }
  for (const [fieldName, fieldSchema] of Object.entries(existingProperties)) {
    if (!(fieldName in reorderedProperties)) reorderedProperties[fieldName] = fieldSchema;
  }
  return reorderedProperties as TProperties;
}

/**
 * Guarantee the system fields exist in the schema even when the type had no documents
 * to sample (or the sample happened to omit an optional one like `_rev`).
 */
function ensureSystemFieldsPresent(tableSchema: TObject): void {
  const requiredSystemFieldNames = ['_id', '_type'];
  for (const fieldName of requiredSystemFieldNames) {
    if (!(fieldName in tableSchema.properties)) {
      tableSchema.properties[fieldName] = Type.String();
    }
  }
  const optionalSystemFieldNames = ['_rev', '_createdAt', '_updatedAt'];
  for (const fieldName of optionalSystemFieldNames) {
    if (!(fieldName in tableSchema.properties)) {
      tableSchema.properties[fieldName] = Type.Optional(Type.String());
    }
  }
}

function annotateSystemFields(tableSchema: TObject): void {
  for (const fieldName of SANITY_READONLY_SYSTEM_FIELD_NAMES) {
    const fieldSchema = tableSchema.properties[fieldName] as TSchema | undefined;
    if (fieldSchema) {
      fieldSchema[X_SCRATCH_READONLY] = true;
    }
  }
  // `_type` must be set on create (getNewFile pre-fills it) but never changed after.
  const typeFieldSchema = tableSchema.properties['_type'] as TSchema | undefined;
  if (typeFieldSchema) {
    typeFieldSchema[X_SCRATCH_WRITE_ONCE] = true;
  }
  // `_updatedAt` is the service-guaranteed last-modified timestamp — annotate it now so
  // incremental pulls can auto-detect the driver field once they're wired up.
  const updatedAtFieldSchema = tableSchema.properties['_updatedAt'] as TSchema | undefined;
  if (updatedAtFieldSchema) {
    updatedAtFieldSchema[X_SCRATCH_LAST_MODIFIED_FIELD] = true;
  }
}

// Same pragmatic ISO 8601 / RFC 3339 shape the generic inference detects. The inference
// keeps `format` OUT of the enforced TypeBox schema (a guessed format would make
// validation reject valid records), so the hint travels on the non-enforced
// `x-scratch-connector-data-type` annotation instead — display/view only.
const ISO_DATETIME_VALUE_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/;

// Sanity `date` fields serialize as bare calendar dates ("2026-06-15") — annotated `date`
// so the view can type the column as a date-only column instead of plain text.
const ISO_DATE_ONLY_VALUE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Detect value shapes from the sampled documents and stamp faithful native-type
 * annotations (never enforced in validation):
 *   - Portable Text: an array whose object members are `_type: 'block'` →
 *     `portableText` + the suggested Portable Text → HTML sync transformer, so the
 *     sync editor auto-applies it when the field is mapped to a destination.
 *   - Datetime: every sampled string value is ISO 8601 → `datetime`, so the default
 *     view can type the column as a date without a format keyword in the schema.
 *   - Date-only: every sampled string value is a bare calendar date → `date`, so the
 *     default view can type the column as a date-only column.
 */
function annotateValueShapesFromSamples(tableSchema: TObject, sampledDocuments: SanityDocument[]): void {
  for (const [fieldName, fieldSchema] of Object.entries(tableSchema.properties)) {
    const nonNullSampledValues = sampledDocuments
      .map((document) => document[fieldName])
      .filter((value) => value !== null && value !== undefined);
    if (nonNullSampledValues.length === 0) continue;

    // Portable Text is an array of typed objects where `_type: 'block'` members carry the
    // text — but idiomatic fields MIX blocks with custom object members (images, code
    // blocks, embeds), so requiring every member to be a block missed real Portable Text
    // (found by the Live Export audit: a body with `code` + `image` members exported as
    // raw JSON). Detection: every non-null sampled value is an array (empty allowed),
    // every member of every array is an object carrying a string `_type`, and at least
    // one `block` member exists somewhere in the sample. Reference arrays (`_type:
    // 'reference'` members, no blocks) stay excluded.
    const everySampledValueIsArray = nonNullSampledValues.every((value) => Array.isArray(value));
    const sampledArrayMembers = everySampledValueIsArray ? (nonNullSampledValues as unknown[][]).flat() : [];
    const isTypedObjectMember = (member: unknown): boolean =>
      member !== null && typeof member === 'object' && typeof (member as Record<string, unknown>)._type === 'string';
    const looksLikePortableText =
      everySampledValueIsArray &&
      sampledArrayMembers.length > 0 &&
      sampledArrayMembers.every(isTypedObjectMember) &&
      sampledArrayMembers.some((member) => (member as Record<string, unknown>)._type === 'block');
    if (looksLikePortableText) {
      fieldSchema[X_SCRATCH_CONNECTOR_DATA_TYPE] = 'portableText';
      fieldSchema[X_SCRATCH_SUGGESTED_TRANSFORMER] = { type: TransformerTypes.PortableTextToHtml };
      continue;
    }

    const everyValueIsIsoDatetimeString = nonNullSampledValues.every(
      (value) => typeof value === 'string' && ISO_DATETIME_VALUE_REGEX.test(value),
    );
    if (everyValueIsIsoDatetimeString) {
      fieldSchema[X_SCRATCH_CONNECTOR_DATA_TYPE] = 'datetime';
      continue;
    }

    const everyValueIsIsoDateOnlyString = nonNullSampledValues.every(
      (value) => typeof value === 'string' && ISO_DATE_ONLY_VALUE_REGEX.test(value),
    );
    if (everyValueIsIsoDateOnlyString) {
      fieldSchema[X_SCRATCH_CONNECTOR_DATA_TYPE] = 'date';
    }
  }
}

/**
 * Scan sampled documents for reference-shaped fields — a single `{_type:'reference', _ref}`
 * object, or an array of them — and collect a few `_ref` ids per field so the connector can
 * resolve their target `_type` with one GROQ lookup. Pure; no I/O.
 */
export function collectReferenceFieldSampleRefIds(
  sampledDocuments: SanityDocument[],
): Map<string, { sampleRefIds: string[]; isSingleValued: boolean }> {
  const MAX_SAMPLE_REF_IDS_PER_FIELD = 5;
  const isReferenceValue = (value: unknown): value is { _ref: string } =>
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    typeof (value as Record<string, unknown>)._ref === 'string';

  const fieldNameToRefCollection = new Map<string, { sampleRefIds: string[]; isSingleValued: boolean }>();
  for (const document of sampledDocuments) {
    for (const [fieldName, value] of Object.entries(document)) {
      if (isReferenceValue(value)) {
        const collection = fieldNameToRefCollection.get(fieldName) ?? { sampleRefIds: [], isSingleValued: true };
        if (collection.sampleRefIds.length < MAX_SAMPLE_REF_IDS_PER_FIELD) collection.sampleRefIds.push(value._ref);
        fieldNameToRefCollection.set(fieldName, collection);
      } else if (Array.isArray(value) && value.length > 0 && value.every(isReferenceValue)) {
        const collection = fieldNameToRefCollection.get(fieldName) ?? { sampleRefIds: [], isSingleValued: false };
        collection.isSingleValued = false;
        for (const member of value) {
          if (collection.sampleRefIds.length < MAX_SAMPLE_REF_IDS_PER_FIELD) collection.sampleRefIds.push(member._ref);
        }
        fieldNameToRefCollection.set(fieldName, collection);
      }
    }
  }
  return fieldNameToRefCollection;
}

/**
 * Stamp `x-scratch-foreign-key` on the `_ref` LEAF (per the guide: annotate the id leaf,
 * never the reference envelope) of each field whose target type the connector resolved.
 */
function annotateReferenceFields(
  tableSchema: TObject,
  id: EntityId,
  sampledDocuments: SanityDocument[],
  referenceFieldTargetTypeNames: Map<string, string> | undefined,
): void {
  if (!referenceFieldTargetTypeNames || referenceFieldTargetTypeNames.size === 0) return;
  const [projectId, datasetName] = id.remoteId;
  const referenceShapes = collectReferenceFieldSampleRefIds(sampledDocuments);

  for (const [fieldName, targetTypeName] of referenceFieldTargetTypeNames.entries()) {
    const fieldSchema = tableSchema.properties[fieldName] as TSchema | undefined;
    if (!fieldSchema) continue;
    const isSingleValued = referenceShapes.get(fieldName)?.isSingleValued ?? true;
    // Single ref: {properties: {_ref}}; array of refs: {items: {properties: {_ref}}}.
    const refLeafSchema =
      (fieldSchema.properties as Record<string, TSchema> | undefined)?._ref ??
      ((fieldSchema.items as TSchema | undefined)?.properties as Record<string, TSchema> | undefined)?._ref;
    if (!refLeafSchema) continue;
    refLeafSchema[X_SCRATCH_FOREIGN_KEY_OPTIONS] = {
      // The BARE type name — the same convention the pg connectors use for a public-schema
      // table. It equals the last segment of the target's remoteId, which is what every
      // consumer matches: the schema-builder token map accepts any remoteId segment, and
      // the dusky/harness field filter checks `remoteId.includes(linkedTableId)` (segment
      // equality — a dotted or underscore form matches NOTHING there and every FK silently
      // dropped out of Live Export plans; found by the SANITY audit 2026-08-01, and the
      // dotted form has its own known draft-save bug, DEV-11071). Cross-dataset ambiguity
      // is covered by `linkedTableRemoteId`, which is exact.
      linkedTableId: targetTypeName,
      linkedTableRemoteId: [projectId, datasetName, targetTypeName],
      isSingleValued,
    } satisfies ForeignKeyOptionSchema;
  }
}

function findTitlePath(tableSchema: TObject): BaseJsonTableSpec['titlePath'] {
  for (const candidateFieldName of TITLE_FIELD_NAME_CANDIDATES) {
    if (candidateFieldName in tableSchema.properties) {
      return dotPath(candidateFieldName);
    }
  }
  return undefined;
}

/**
 * Sanity's slug convention is an object field `{ _type: 'slug', current: '<slug>' }`,
 * idiomatically named `slug`. Point slugPath at its `current` leaf when present.
 */
function findSlugPath(tableSchema: TObject): BaseJsonTableSpec['slugPath'] {
  const slugFieldSchema = tableSchema.properties['slug'] as TSchema | undefined;
  const slugSubProperties = slugFieldSchema?.properties as Record<string, unknown> | undefined;
  if (slugSubProperties && 'current' in slugSubProperties) {
    return dotPath('slug.current');
  }
  return undefined;
}
