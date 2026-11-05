import type { TSchema } from '@sinclair/typebox';
import { X_SCRATCH_FOREIGN_KEY_OPTIONS, X_SCRATCH_READONLY } from '@spinner/shared-types';
import { BaseJsonTableSpec, EntityId, dotPath } from '../../types';
import { SQUARE_ENTITY_SCHEMAS_BY_SQUARE_OBJECT_NAME } from './square-entity-schemas.generated';
import {
  SQUARE_DASHBOARD_BASE_URL_BY_ENVIRONMENT,
  SQUARE_ENTITY_CONFIG_BY_ENTITY_TYPE,
  SquareEntityType,
  SquareEnvironment,
} from './square-types';

/** A JSON Schema node as the generated file declares it (plain JSON, no TypeBox symbols). */
interface JsonSchemaNode {
  type?: string;
  format?: string;
  description?: string;
  properties?: Record<string, JsonSchemaNode>;
  additionalProperties?: JsonSchemaNode;
  items?: JsonSchemaNode;
  anyOf?: JsonSchemaNode[];
  [annotation: string]: unknown;
}

/**
 * Top-level `*_id` fields that point at another Square table, with the table they point at. Every
 * one holds a single id, so each link is single-valued — which is what lets a relational
 * destination (Supabase/Postgres) store it as one foreign-key column.
 */
export const SQUARE_FOREIGN_KEY_TARGET_ENTITY_TYPE_BY_TOP_LEVEL_FIELD_NAME: Record<string, SquareEntityType> = {
  location_id: 'locations',
  customer_id: 'customers',
  order_id: 'orders',
  payment_id: 'payments',
  team_member_id: 'team_members',
  creator_team_member_id: 'team_members',
  payout_id: 'payouts',
  gift_card_id: 'gift_cards',
};

/** String fields Square documents as a calendar date (`YYYY-MM-DD`) rather than a timestamp. */
const SQUARE_DATE_ONLY_FIELD_NAMES = new Set([
  'sale_or_service_date',
  'arrival_date',
  'start_date',
  'canceled_date',
  'charged_through_date',
  'completed_date',
]);

/**
 * Whether Square documents this string field as an RFC 3339 timestamp. Square names every
 * timestamp `*_at`, plus `delayed_until`. (`birthday` is deliberately excluded: Square allows a
 * year-less `0000-MM-DD`, which is not a valid date.)
 */
function isSquareTimestampFieldName(fieldName: string): boolean {
  return fieldName.endsWith('_at') || fieldName === 'delayed_until';
}

/** The non-null arm of a nullable `anyOf [<shape>, null]`, or the node itself. */
export function nonNullArmOf(node: JsonSchemaNode | undefined): JsonSchemaNode | undefined {
  if (!node?.anyOf) return node;
  return node.anyOf.find((arm) => arm.type !== 'null') ?? node;
}

/**
 * Record what Square's docs say about date fields as a JSON Schema `format`, at any depth. The
 * value on disk stays the string Square sent; the format only lets the view and the export layer
 * treat it as a date (and keep its time of day).
 */
function addDateFormats(node: JsonSchemaNode | undefined): void {
  const shape = nonNullArmOf(node);
  if (!shape) return;
  if (shape.properties) {
    for (const [fieldName, fieldSchema] of Object.entries(shape.properties)) {
      const fieldShape = nonNullArmOf(fieldSchema);
      if (fieldShape?.type === 'string') {
        if (isSquareTimestampFieldName(fieldName)) fieldShape.format = 'date-time';
        else if (SQUARE_DATE_ONLY_FIELD_NAMES.has(fieldName)) fieldShape.format = 'date';
      }
      addDateFormats(fieldSchema);
    }
  }
  if (shape.additionalProperties) addDateFormats(shape.additionalProperties);
  if (shape.items) addDateFormats(shape.items);
}

/**
 * A CatalogObject declares a `<type>_data` property for every catalog type, but a record only ever
 * carries the one matching its `type`. Each catalog table holds a single type, so its schema keeps
 * the shared envelope fields plus that one data property — a schema-only projection; records are
 * untouched.
 */
function keepOnlyCatalogTypeDataProperty(schema: JsonSchemaNode, catalogTypeDataPropertyName: string): void {
  if (!schema.properties) return;
  for (const propertyName of Object.keys(schema.properties)) {
    if (propertyName.endsWith('_data') && propertyName !== catalogTypeDataPropertyName) {
      delete schema.properties[propertyName];
    }
  }
}

/**
 * Build the record schema for one Square table from the vendored OpenAPI shapes.
 *
 * Annotations go on TOP-LEVEL fields only. The export layer's schema flattener treats a node that
 * carries `x-scratch-*` annotations as one opaque leaf, so annotating nested money/address objects
 * would hide their inner fields from it; the default view declares those columns' types itself.
 */
export function buildSquareRecordSchema(entityType: SquareEntityType): TSchema {
  const entityConfig = SQUARE_ENTITY_CONFIG_BY_ENTITY_TYPE[entityType];
  const schema = structuredClone(
    SQUARE_ENTITY_SCHEMAS_BY_SQUARE_OBJECT_NAME[entityConfig.squareObjectName],
  ) as JsonSchemaNode;

  if (entityConfig.catalogTypeDataPropertyName) {
    keepOnlyCatalogTypeDataProperty(schema, entityConfig.catalogTypeDataPropertyName);
  }

  addDateFormats(schema);

  for (const [fieldName, fieldSchema] of Object.entries(schema.properties ?? {})) {
    // The connector is read-only, so every field is.
    fieldSchema[X_SCRATCH_READONLY] = true;

    const foreignKeyTargetEntityType = SQUARE_FOREIGN_KEY_TARGET_ENTITY_TYPE_BY_TOP_LEVEL_FIELD_NAME[fieldName];
    if (foreignKeyTargetEntityType && foreignKeyTargetEntityType !== entityType) {
      fieldSchema[X_SCRATCH_FOREIGN_KEY_OPTIONS] = {
        linkedTableId: foreignKeyTargetEntityType,
        linkedTableRemoteId: [foreignKeyTargetEntityType],
        isSingleValued: true,
      };
    }
  }

  schema.$id = `square/${entityType}`;
  schema.title = entityConfig.displayName;
  return schema as TSchema;
}

/**
 * Build the JSON Table Spec for a Square table. `environment` only affects the dashboard deep link
 * (sandbox accounts live on a separate dashboard host).
 */
export function buildSquareJsonTableSpec(
  id: EntityId,
  entityType: SquareEntityType,
  environment: SquareEnvironment,
): BaseJsonTableSpec {
  const entityConfig = SQUARE_ENTITY_CONFIG_BY_ENTITY_TYPE[entityType];
  return {
    id,
    slug: id.wsId,
    name: entityConfig.displayName,
    schema: buildSquareRecordSchema(entityType),
    idPath: dotPath('id'),
    titlePath: dotPath(entityConfig.titlePath),
    slugPath: dotPath(entityConfig.slugPath),
    basePath: [],
    ...(entityConfig.dashboardPath
      ? { remoteWebUrl: `${SQUARE_DASHBOARD_BASE_URL_BY_ENVIRONMENT[environment]}/${entityConfig.dashboardPath}` }
      : {}),
    generatedAt: new Date().toISOString(),
  };
}
