import { SanityDeployedSchemaDocument } from './sanity-types';

/**
 * Parser for DEPLOYED Studio schemas.
 *
 * The Content Lake itself is schemaless, but `sanity schema deploy` stores the Studio's
 * content model INTO the dataset as system documents with ids `_.schemas.<workspaceName>`
 * (observed live `_type: "system.schema"`; older docs call it `sanity.workspace.schema`).
 * Each document carries a `schema` payload — a JSON **string** (observed live) or an
 * already-parsed array — serializing every Studio type as
 * `{ name, type, title?, fields: [...] }`, each field as
 * `{ name, type, title?, to?: [{type}], of?: [...], fields?: [...] }`.
 *
 * Two serialization quirks worth knowing:
 *   - Sanity OMITS a `title` that equals its default humanization of the field name
 *     (e.g. a declared "Meta Title" on `metaTitle` is dropped from the payload), so a
 *     missing title is normal and the display fallback must humanize the name anyway.
 *   - Field order in the payload is the AUTHORED Studio order — the signal the sampled
 *     documents can never provide (the Content Lake returns document keys alphabetically).
 *
 * This module is pure (no I/O): it turns the fetched documents into per-document-type
 * enrichment the schema builder merges over the sample-inferred schema. Per the
 * Connector Prime Directive this only ever affects SCHEMA/VIEW metadata — stored
 * records are never reshaped.
 */

/** Authored order + titles for the sub-fields of a nested `object` field (e.g. `seo`). */
export interface SanityDeployedObjectFieldEnrichment {
  orderedSubFieldNames: string[];
  subFieldTitlesByName: Map<string, string>;
}

/** Everything the deployed Studio schema declares about one document type. */
export interface SanityDeployedTypeEnrichment {
  /** Field names in the authored Studio order (system `_*` fields never appear here). */
  orderedFieldNames: string[];
  /** fieldName → human title, only for fields whose declared title survived serialization. */
  fieldTitlesByName: Map<string, string>;
  /**
   * fieldName → target type name, for single-target references only: a `reference`
   * field with `to: [{type}]`, or an `array` of exactly that. Sanity's multi-target
   * references (`to: [{type:'a'},{type:'b'}]`) deliberately stay unannotated — a
   * Scratch FK links one table.
   */
  referenceTargetTypeNamesByFieldName: Map<string, string>;
  /** fieldName → sub-field order/titles, for nested plain `object` fields. */
  objectFieldEnrichmentsByFieldName: Map<string, SanityDeployedObjectFieldEnrichment>;
}

/** One serialized Studio field (or array member / object sub-field) as deployed. */
interface SanitySerializedSchemaField {
  name?: unknown;
  type?: unknown;
  title?: unknown;
  to?: unknown;
  of?: unknown;
  fields?: unknown;
}

/**
 * Parse the fetched `_.schemas.*` documents into per-document-type enrichment.
 *
 * When several Studio workspaces deployed schemas, the workspace named `default` is
 * consulted first, then the rest in `_id` order — the FIRST workspace to declare a
 * type wins, so the result is deterministic. Malformed payloads (unparseable JSON,
 * unexpected shapes) are skipped silently: enrichment is best-effort on top of
 * inference, never a reason to fail a spec build.
 */
export function parseDeployedSchemaEnrichmentsByTypeName(
  deployedSchemaDocuments: SanityDeployedSchemaDocument[],
): Map<string, SanityDeployedTypeEnrichment> {
  const documentsInWorkspacePriorityOrder = [...deployedSchemaDocuments].sort((a, b) => {
    const aIsDefaultWorkspace = a.workspace?.name === 'default' ? 0 : 1;
    const bIsDefaultWorkspace = b.workspace?.name === 'default' ? 0 : 1;
    if (aIsDefaultWorkspace !== bIsDefaultWorkspace) return aIsDefaultWorkspace - bIsDefaultWorkspace;
    return (a._id ?? '').localeCompare(b._id ?? '');
  });

  const enrichmentsByTypeName = new Map<string, SanityDeployedTypeEnrichment>();
  for (const document of documentsInWorkspacePriorityOrder) {
    const serializedTypes = parseSchemaPayloadToTypeArray(document.schema);
    for (const serializedType of serializedTypes) {
      if (serializedType.type !== 'document') continue;
      if (typeof serializedType.name !== 'string' || serializedType.name.length === 0) continue;
      if (enrichmentsByTypeName.has(serializedType.name)) continue; // first workspace to declare a type wins
      const declaredFields = Array.isArray(serializedType.fields) ? serializedType.fields : [];
      enrichmentsByTypeName.set(serializedType.name, buildTypeEnrichmentFromDeclaredFields(declaredFields));
    }
  }
  return enrichmentsByTypeName;
}

/** The `schema` payload is a JSON string live; tolerate an already-parsed array too. */
function parseSchemaPayloadToTypeArray(schemaPayload: unknown): SanitySerializedSchemaField[] {
  let parsedPayload: unknown = schemaPayload;
  if (typeof schemaPayload === 'string') {
    try {
      parsedPayload = JSON.parse(schemaPayload);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(parsedPayload)) return [];
  return parsedPayload.filter(
    (entry): entry is SanitySerializedSchemaField => entry !== null && typeof entry === 'object',
  );
}

function buildTypeEnrichmentFromDeclaredFields(declaredFields: unknown[]): SanityDeployedTypeEnrichment {
  const orderedFieldNames: string[] = [];
  const fieldTitlesByName = new Map<string, string>();
  const referenceTargetTypeNamesByFieldName = new Map<string, string>();
  const objectFieldEnrichmentsByFieldName = new Map<string, SanityDeployedObjectFieldEnrichment>();

  for (const declaredField of declaredFields) {
    if (declaredField === null || typeof declaredField !== 'object') continue;
    const field = declaredField as SanitySerializedSchemaField;
    if (typeof field.name !== 'string' || field.name.length === 0) continue;

    orderedFieldNames.push(field.name);
    if (typeof field.title === 'string' && field.title.length > 0) {
      fieldTitlesByName.set(field.name, field.title);
    }

    const singleReferenceTargetTypeName = resolveSingleReferenceTargetTypeName(field);
    if (singleReferenceTargetTypeName) {
      referenceTargetTypeNamesByFieldName.set(field.name, singleReferenceTargetTypeName);
    }

    if (field.type === 'object' && Array.isArray(field.fields)) {
      objectFieldEnrichmentsByFieldName.set(field.name, buildObjectFieldEnrichment(field.fields));
    }
  }

  return {
    orderedFieldNames,
    fieldTitlesByName,
    referenceTargetTypeNamesByFieldName,
    objectFieldEnrichmentsByFieldName,
  };
}

function buildObjectFieldEnrichment(declaredSubFields: unknown[]): SanityDeployedObjectFieldEnrichment {
  const orderedSubFieldNames: string[] = [];
  const subFieldTitlesByName = new Map<string, string>();
  for (const declaredSubField of declaredSubFields) {
    if (declaredSubField === null || typeof declaredSubField !== 'object') continue;
    const subField = declaredSubField as SanitySerializedSchemaField;
    if (typeof subField.name !== 'string' || subField.name.length === 0) continue;
    orderedSubFieldNames.push(subField.name);
    if (typeof subField.title === 'string' && subField.title.length > 0) {
      subFieldTitlesByName.set(subField.name, subField.title);
    }
  }
  return { orderedSubFieldNames, subFieldTitlesByName };
}

/**
 * The single-target reference shapes:
 *   - `{ type: 'reference', to: [{type: 'author'}] }`
 *   - `{ type: 'array', of: [{ type: 'reference', to: [{type: 'category'}] }] }`
 * Anything else (multi-target `to`, mixed-member arrays) yields no target.
 */
function resolveSingleReferenceTargetTypeName(field: SanitySerializedSchemaField): string | undefined {
  if (field.type === 'reference') {
    return extractSoleReferenceTargetTypeName(field.to);
  }
  if (field.type === 'array' && Array.isArray(field.of) && field.of.length === 1) {
    const soleArrayMember = field.of[0] as SanitySerializedSchemaField | null;
    if (soleArrayMember !== null && typeof soleArrayMember === 'object' && soleArrayMember.type === 'reference') {
      return extractSoleReferenceTargetTypeName(soleArrayMember.to);
    }
  }
  return undefined;
}

function extractSoleReferenceTargetTypeName(toTargets: unknown): string | undefined {
  if (!Array.isArray(toTargets) || toTargets.length !== 1) return undefined;
  const soleTarget = toTargets[0] as { type?: unknown } | null;
  if (soleTarget === null || typeof soleTarget !== 'object') return undefined;
  return typeof soleTarget.type === 'string' && soleTarget.type.length > 0 ? soleTarget.type : undefined;
}
