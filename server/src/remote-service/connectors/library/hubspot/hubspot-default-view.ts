import { Kind, TSchema } from '@sinclair/typebox';
import {
  TablePropertyType,
  TableView,
  TableViewBannerGroup,
  TableViewCol,
  X_SCRATCH_CONNECTOR_DATA_TYPE,
  X_SCRATCH_READONLY,
} from '@spinner/shared-types';

// ── Top-level fixed fields ──

// Fixed fields that should be hidden by default.
const HIDDEN_FIXED_FIELDS = new Set(['associations']);

// Fixed fields that are always readonly (system-generated, not editable via the API).
const READONLY_FIXED_FIELDS = new Set(['id', 'createdAt', 'updatedAt', 'archived']);

// ── HubSpot connector data type mapping ──

const HUBSPOT_TYPE_MAP: Partial<Record<string, TablePropertyType>> = {
  'hubspot/number': 'number',
  'hubspot/number_number': 'number',
  'hubspot/number_calculation_equation': 'number',
  'hubspot/bool': 'checkbox',
  'hubspot/bool_booleancheckbox': 'checkbox',
  'hubspot/date': 'date',
  'hubspot/date_date': 'date',
  'hubspot/datetime': 'date',
  'hubspot/datetime_date': 'date',
  'hubspot/phone_number': 'string',
  'hubspot/string_phonenumber': 'string',
};

// ── Hidden properties ──

// hs_ properties that are actually useful and should NOT be hidden.
const HS_KEEP_VISIBLE = new Set(['hs_email_domain', 'hs_lead_status', 'hs_object_id', 'hs_language', 'hs_timezone']);

// Non-hs_ properties that should be hidden (analytics noise, internal tracking).
const HIDDEN_PROPERTIES = new Set([
  'days_to_close',
  'engagements_last_meeting_booked',
  'engagements_last_meeting_booked_campaign',
  'engagements_last_meeting_booked_medium',
  'engagements_last_meeting_booked_source',
  'first_conversion_date',
  'first_conversion_event_name',
  'first_deal_created_date',
  'followercount',
  'hubspotscore',
  'ip_city',
  'ip_country',
  'ip_country_code',
  'ip_state',
  'ip_state_code',
  'kloutscoregeneral',
  'linkedinbio',
  'linkedinconnections',
  'num_contacted_notes',
  'num_conversion_events',
  'num_notes',
  'num_unique_conversion_events',
  'owneremail',
  'ownername',
  'recent_conversion_date',
  'recent_conversion_event_name',
  'twitterbio',
  'twitterhandle',
  'twitterprofilephoto',
]);

// ── Always-readonly properties ──
// Properties that are system-generated and never editable, even if the HubSpot API
// metadata doesn't flag them. Belt-and-suspenders for the view layer.
const ALWAYS_READONLY_PROPERTIES = new Set([
  'createdate',
  'lastmodifieddate',
  'hs_object_id',
  'num_associated_deals',
  'num_conversion_events',
  'num_unique_conversion_events',
  'num_contacted_notes',
  'num_notes',
  'recent_deal_amount',
  'recent_deal_close_date',
  'total_revenue',
  'first_deal_created_date',
  'first_conversion_date',
  'recent_conversion_date',
  'days_to_close',
]);

// ── Address banner group ──

const ADDRESS_FIELDS = ['address', 'city', 'state', 'country', 'zip'];

/**
 * Build a default TableView for a HubSpot object (contacts, companies, deals, etc.).
 *
 * Column order: title property → id → priority properties → Address group → remaining properties
 * → remaining fixed fields (createdAt, updatedAt, archived, ...).
 *
 * @param titleFieldPath - dot-path to the title property (e.g. 'properties.email').
 * @param priorityFields - property names to show right after id.
 */
export function buildHubspotDefaultView(
  schema: TSchema,
  titleFieldPath?: string,
  priorityFields?: string[],
): TableView {
  const topLevel: Record<string, TSchema> =
    (schema as TSchema & { properties?: Record<string, TSchema> }).properties ?? {};

  const cols: (TableViewCol | TableViewBannerGroup)[] = [];

  // Discover properties
  const propertiesSchema = topLevel['properties'];
  const propertyFields: Record<string, TSchema> =
    (propertiesSchema as TSchema & { properties?: Record<string, TSchema> })?.properties ?? {};

  // Order: title first, then priority fields, then the rest
  const titlePropName = titleFieldPath?.replace('properties.', '');
  const orderedProps = orderProperties(Object.entries(propertyFields), titlePropName, priorityFields);

  // Separate address fields for banner grouping
  const addressFieldSet = new Set(ADDRESS_FIELDS);
  const addressCols: TableViewCol[] = [];
  const regularProps: { name: string; col: TableViewCol }[] = [];

  for (const [propName, propSchema] of orderedProps) {
    const col = buildPropertyCol(propName, propSchema);
    if (addressFieldSet.has(propName)) {
      addressCols.push(col);
    } else {
      regularProps.push({ name: propName, col });
    }
  }

  // Build fixed fields
  const fixedFieldIds = Object.keys(topLevel).filter((k) => k !== 'properties');
  const fixedCols = new Map<string, TableViewCol>();
  for (const fieldId of fixedFieldIds) {
    fixedCols.set(fieldId, buildFixedCol(fieldId, topLevel[fieldId]));
  }

  // === Assemble final column order ===

  // 1. Title property (if present)
  if (titlePropName && regularProps.length > 0 && regularProps[0].name === titlePropName) {
    cols.push(regularProps.shift()!.col);
  }

  // 2. id fixed field right after title
  if (fixedCols.has('id')) {
    cols.push(fixedCols.get('id')!);
    fixedCols.delete('id');
  }

  // 3. Priority properties (already ordered at front of regularProps after title was removed)
  const prioritySet = new Set(priorityFields ?? []);
  while (regularProps.length > 0 && prioritySet.has(regularProps[0].name)) {
    cols.push(regularProps.shift()!.col);
  }

  // 4. Address banner group (near the front, after priority fields)
  if (addressCols.length > 0) {
    cols.push({ kind: 'banner-group', name: 'Address', cols: addressCols });
  }

  // 5. Remaining properties
  for (const { col } of regularProps) {
    cols.push(col);
  }

  // 6. Remaining fixed fields in priority order: createdAt, updatedAt, archived, then the rest
  const remainingFixedOrder = ['createdAt', 'updatedAt', 'archived'];
  for (const fieldId of remainingFixedOrder) {
    if (fixedCols.has(fieldId)) {
      cols.push(fixedCols.get(fieldId)!);
      fixedCols.delete(fieldId);
    }
  }
  for (const [, col] of fixedCols) {
    cols.push(col);
  }

  return { name: 'Default', cols };
}

// ── Helpers ──

/** Move the title property and priority fields to the front of the list. */
function orderProperties(
  entries: [string, TSchema][],
  titlePropName: string | undefined,
  priorityFields: string[] | undefined,
): [string, TSchema][] {
  const priority: string[] = [];
  if (titlePropName) priority.push(titlePropName);
  if (priorityFields) priority.push(...priorityFields);
  if (priority.length === 0) return entries;

  const entryMap = new Map(entries);
  const ordered: [string, TSchema][] = [];

  for (const name of priority) {
    const schema = entryMap.get(name);
    if (schema) {
      ordered.push([name, schema]);
      entryMap.delete(name);
    }
  }

  for (const [name, schema] of entries) {
    if (entryMap.has(name)) {
      ordered.push([name, schema]);
    }
  }

  return ordered;
}

/** Format a camelCase field name as Title Case. */
function formatFieldName(fieldId: string): string {
  const spaced = fieldId.replace(/([a-z])([A-Z])/g, '$1 $2');
  return spaced
    .split(' ')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

/** Map a fixed top-level field to a TablePropertyType. */
function mapFixedFieldType(fieldSchema: TSchema | undefined): TablePropertyType | undefined {
  if (!fieldSchema) return undefined;
  const format = (fieldSchema as TSchema & { format?: string }).format;
  if (format === 'date-time') return 'date';
  if (format === 'uri') return 'url';
  const kind = fieldSchema[Kind] as string | undefined;
  if (kind === 'Boolean') return 'checkbox';
  if (kind === 'Number' || kind === 'Integer') return 'number';
  if (kind === 'Object' || kind === 'Array' || kind === 'Union' || kind === 'Unknown') return 'object';
  return undefined;
}

/** Resolve the type for a HubSpot property from its connector data type annotation. */
function mapPropertyType(connectorDataType: string | undefined): TablePropertyType | undefined {
  if (!connectorDataType) return undefined;
  return HUBSPOT_TYPE_MAP[connectorDataType];
}

/** Determine whether a property should be hidden by default. */
function isHiddenProperty(propName: string): boolean {
  if (HIDDEN_PROPERTIES.has(propName)) return true;
  if (propName.startsWith('hs_') && !HS_KEEP_VISIBLE.has(propName)) return true;
  return false;
}

/** Determine whether a property is always readonly (system-generated). */
function isAlwaysReadonlyProperty(propName: string): boolean {
  if (ALWAYS_READONLY_PROPERTIES.has(propName)) return true;
  // hs_object_id variants (e.g. hs_object_id_contact)
  if (propName.startsWith('hs_object_id')) return true;
  return false;
}

/**
 * Properties that HubSpot types as 'number' but are really opaque object identifiers.
 * Forcing them to 'string' avoids the grid's locale-aware thousands separators
 * (e.g. "46,499,514,474" → "46499514474").
 */
function isOpaqueIdProperty(propName: string): boolean {
  // hs_object_id and variants (e.g. hs_object_id_contact)
  return propName.startsWith('hs_object_id');
}

/** Build a TableViewCol for a fixed top-level field. */
function buildFixedCol(fieldId: string, fieldSchema: TSchema | undefined): TableViewCol {
  const hidden = HIDDEN_FIXED_FIELDS.has(fieldId) || undefined;
  const isReadonly = READONLY_FIXED_FIELDS.has(fieldId) || fieldSchema?.[X_SCRATCH_READONLY] === true;

  return {
    kind: 'col',
    path: fieldId,
    name: formatFieldName(fieldId),
    type: mapFixedFieldType(fieldSchema),
    readonly: isReadonly || undefined,
    hidden,
  };
}

/** Build a TableViewCol for a HubSpot CRM property (under properties.*). */
function buildPropertyCol(propName: string, propSchema: TSchema | undefined): TableViewCol {
  const inner = unwrapOptional(propSchema);
  const connectorDataType =
    (propSchema?.[X_SCRATCH_CONNECTOR_DATA_TYPE] as string | undefined) ??
    (inner?.[X_SCRATCH_CONNECTOR_DATA_TYPE] as string | undefined);
  const isReadonly =
    propSchema?.[X_SCRATCH_READONLY] === true ||
    inner?.[X_SCRATCH_READONLY] === true ||
    isAlwaysReadonlyProperty(propName);
  const hidden = isHiddenProperty(propName) || undefined;

  const type = isOpaqueIdProperty(propName) ? 'string' : mapPropertyType(connectorDataType);

  return {
    kind: 'col',
    path: `properties.${propName}`,
    name: propName,
    type,
    readonly: isReadonly || undefined,
    hidden,
  };
}

/** Unwrap TypeBox Optional to get the inner schema. */
function unwrapOptional(schema: TSchema | undefined): TSchema | undefined {
  if (!schema) return undefined;
  const anyOf = (schema as TSchema & { anyOf?: TSchema[] }).anyOf;
  if (anyOf) {
    return anyOf.find((s) => s[Kind] !== 'Null') ?? schema;
  }
  return schema;
}
