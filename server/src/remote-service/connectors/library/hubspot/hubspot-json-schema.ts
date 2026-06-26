import { Type, type TSchema } from '@sinclair/typebox';
import { ValuePointer } from '@sinclair/typebox/value';
import {
  X_SCRATCH_CONNECTOR_DATA_TYPE,
  X_SCRATCH_FOREIGN_KEY_OPTIONS,
  X_SCRATCH_LAST_MODIFIED_FIELD,
  X_SCRATCH_READONLY,
  X_SCRATCH_REMOTE_FIELD_ID,
} from '@spinner/shared-types';
import { BaseJsonTableSpec, EntityId, dotPath } from '../../types';
import { escapePointerToken } from '../../utils/json-pointer';
import { HubspotApiClient } from './hubspot-api-client';
import { buildHubspotDefaultView } from './hubspot-default-view';
import { ASSOCIATIONS_BY_OBJECT_TYPE, HubspotProperty, OBJECT_CONFIG } from './hubspot-types';

/**
 * HubSpot returns ALL property values as strings (even numbers and booleans).
 * We store the raw API response as-is, so all property fields are String | Null.
 * The CONNECTOR_DATA_TYPE annotation carries the semantic type for UI/transformers.
 */
export function hubspotPropertyToJsonSchema(property: HubspotProperty, isLastModifiedField = false): TSchema {
  const connectorDataType = resolveConnectorDataType(property);
  const isReadonly = property.modificationMetadata?.readOnlyValue === true;

  const annotations: Record<string, unknown> = {
    description: property.label,
    [X_SCRATCH_REMOTE_FIELD_ID]: property.name,
    [X_SCRATCH_CONNECTOR_DATA_TYPE]: connectorDataType,
  };

  if (isReadonly) {
    annotations[X_SCRATCH_READONLY] = true;
  }

  // Mark the object's last-modified property so the generic incremental-pull
  // layer (auto-detect + the client's last-modified-field picker) can find it.
  if (isLastModifiedField) {
    annotations[X_SCRATCH_LAST_MODIFIED_FIELD] = true;
  }

  return Type.Union([Type.String(), Type.Null()], annotations);
}

/**
 * Candidate HubSpot last-modified property names, in priority order. Most CRM
 * objects expose `hs_lastmodifieddate`; contacts use `lastmodifieddate`. Custom
 * objects vary — when neither candidate is present, the user can declare the
 * property explicitly via the `modifiedAtField` advanced setting.
 */
const LAST_MODIFIED_PROPERTY_CANDIDATES = ['hs_lastmodifieddate', 'lastmodifieddate'] as const;

/**
 * Pick the modified-date property to annotate, preferring `hs_lastmodifieddate`
 * over `lastmodifieddate`. Returns `undefined` when the object exposes neither.
 */
export function resolveHubspotLastModifiedPropertyName(propertyNames: Set<string>): string | undefined {
  return LAST_MODIFIED_PROPERTY_CANDIDATES.find((candidate) => propertyNames.has(candidate));
}

/**
 * Resolve the connector data type string from HubSpot's type/fieldType combination.
 * Uses the same format as the existing whalesync connector: `hubspot/{type}_{fieldType}` or `hubspot/{type}`.
 */
function resolveConnectorDataType(property: HubspotProperty): string {
  const combined = `hubspot/${property.type}_${property.fieldType}`;
  const simple = `hubspot/${property.type}`;

  // Use the more specific combined type when fieldType adds meaningful info
  if (property.fieldType && property.fieldType !== property.type) {
    return combined;
  }
  return simple;
}

/**
 * Build the associations sub-schema for an object type.
 * Associations are readonly since they're written via the separate v4 API.
 *
 * Each association is keyed by the related object type (`companies`, `contacts`,
 * `deals`, `0-421`, …), and every `results[].id` holds the related record's HubSpot
 * `id`. That object type is also the related table's wsId (see `listTables`, which
 * sets `wsId: objectType`), so we annotate the `id` node as a foreign key whose
 * `linkedTableId` is the association type. The FK resolves to whichever record in
 * that table has the matching `id`; if the user hasn't synced that table into the
 * workbook, the FK simply doesn't resolve (no table change needed here).
 */
function buildAssociationsSchema(objectType: string): TSchema | null {
  const associatedTypes = ASSOCIATIONS_BY_OBJECT_TYPE[objectType];
  if (!associatedTypes || associatedTypes.length === 0) return null;

  const assocProperties: Record<string, TSchema> = {};
  for (const assocType of associatedTypes) {
    assocProperties[assocType] = Type.Optional(
      Type.Object({
        results: Type.Array(
          Type.Object({
            id: Type.String({ [X_SCRATCH_FOREIGN_KEY_OPTIONS]: { linkedTableId: assocType } }),
            type: Type.String(),
          }),
        ),
      }),
    );
  }

  return Type.Optional(
    Type.Object(assocProperties, {
      [X_SCRATCH_READONLY]: true,
      description: 'Associations with other HubSpot objects',
    }),
  );
}

/**
 * Build a BaseJsonTableSpec from the HubSpot Properties API response.
 * The schema mirrors the raw API response structure:
 * { id, properties: { ... }, associations: { ... }, createdAt, updatedAt, archived }
 *
 * Returns both the spec and the list of property names (needed for API calls).
 */
export async function buildHubspotJsonTableSpec(
  id: EntityId,
  objectType: string,
  client: HubspotApiClient,
): Promise<{ spec: BaseJsonTableSpec; propertyNames: string[] }> {
  const properties = await client.getProperties(objectType);
  const propertyNames = properties.map((p) => p.name);

  // Annotate the object's last-modified property (if present) so incremental
  // pulls can auto-detect it. Resolved per object type because the name varies.
  const lastModifiedPropertyName = resolveHubspotLastModifiedPropertyName(new Set(propertyNames));

  // Build the properties sub-object schema
  const propertiesSchema: Record<string, TSchema> = {};
  for (const property of properties) {
    propertiesSchema[property.name] = hubspotPropertyToJsonSchema(property, property.name === lastModifiedPropertyName);
  }

  // Build top-level record schema matching raw API response
  const topLevelProperties: Record<string, TSchema> = {
    id: Type.String({ [X_SCRATCH_READONLY]: true, description: 'Record ID' }),
    properties: Type.Object(propertiesSchema, { description: 'HubSpot properties' }),
    createdAt: Type.String({ [X_SCRATCH_READONLY]: true, description: 'Created timestamp' }),
    updatedAt: Type.String({ [X_SCRATCH_READONLY]: true, description: 'Updated timestamp' }),
    archived: Type.Boolean({ [X_SCRATCH_READONLY]: true, description: 'Whether the record is archived' }),
  };

  // Add associations schema if this object type supports them
  const associationsSchema = buildAssociationsSchema(objectType);
  if (associationsSchema) {
    topLevelProperties['associations'] = associationsSchema;
  }

  const config = OBJECT_CONFIG[objectType];
  const displayName = config?.displayName ?? objectType;

  const schema = Type.Object(topLevelProperties, {
    $id: `hubspot/${objectType}`,
    title: displayName,
  });

  // Determine title column — it's always nested under 'properties'
  const titleField = config?.titleFieldPath?.replace('properties.', '');
  const titlePath = titleField ? dotPath(`properties.${titleField}`) : undefined;

  const spec: BaseJsonTableSpec = {
    id,
    slug: id.wsId,
    name: displayName,
    schema,
    idPath: dotPath('id'),
    titlePath,
    slugPath: config?.titleFieldPath ? dotPath(config.titleFieldPath) : undefined,
    basePath: [],
    generatedAt: new Date().toISOString(),
    defaultView: buildHubspotDefaultView(schema, {
      titleFieldPath: config?.titleFieldPath,
      priorityFields: config?.priorityFields,
      hideHubspotManagedProperties: config?.hideHubspotManagedPropertiesByDefault ?? false,
    }),
  };

  return { spec, propertyNames };
}

/**
 * HubSpot-calculated system properties that are always readonly, regardless of
 * what the schema says. Kept as a belt-and-suspenders check so that a stale or
 * malformed schema can't cause us to send these fields back to the API.
 */
const ALWAYS_READONLY_PROPERTY_NAMES = new Set(['createdate', 'lastmodifieddate']);

function isAlwaysReadonlyPropertyName(propertyName: string): boolean {
  return propertyName.startsWith('hs_object_id') || ALWAYS_READONLY_PROPERTY_NAMES.has(propertyName);
}

/**
 * Check whether a HubSpot property name is marked readonly in the table schema,
 * OR is a known system property that is always readonly. Properties live at
 * `/properties/properties/{name}` in the record schema.
 */
export function isReadonlyHubspotProperty(propertyName: string, tableSpec: BaseJsonTableSpec): boolean {
  if (isAlwaysReadonlyPropertyName(propertyName)) return true;
  return (
    ValuePointer.Get(
      tableSpec.schema,
      `/properties/properties/properties/${escapePointerToken(propertyName)}/${X_SCRATCH_READONLY}`,
    ) === true
  );
}
