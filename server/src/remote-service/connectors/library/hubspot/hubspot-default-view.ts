import { Kind, TSchema } from '@sinclair/typebox';
import {
  ColumnCodec,
  TablePropertyType,
  TableView,
  TableViewBannerGroup,
  TableViewCol,
  TransformerTypes,
  X_SCRATCH_CONNECTOR_DATA_TYPE,
  X_SCRATCH_READONLY,
} from '@spinner/shared-types';
import { OBJECT_CONFIG } from './hubspot-types';

// ── Top-level fixed fields ──

// `associations` is NOT emitted as a fixed column — it's expanded into one
// foreign-key column per related object type (see buildAssociationForeignKeyEntries).
const FIXED_FIELDS_HANDLED_SEPARATELY = new Set(['associations']);

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

// hs_ properties that are actually useful and should NOT be hidden — even on the
// analytics-heavy CRM objects (contacts/companies/deals) that otherwise hide the
// whole hs_ namespace by default.
const HS_KEEP_VISIBLE = new Set(['hs_email_domain', 'hs_lead_status', 'hs_object_id', 'hs_language', 'hs_timezone']);

// Internal HubSpot plumbing that is never useful as a column on ANY object type
// (record provenance, owner/team id arrays, merge bookkeeping). Hidden in both
// the hide-hs and show-hs modes. On the hide-hs objects these would already be
// caught by the hs_ blanket rule; listing them here also strips them from the
// activity/commerce objects that otherwise show their hs_ content.
const HS_SYSTEM_PLUMBING_PROPERTIES = new Set([
  'hs_created_by_user_id',
  'hs_updated_by_user_id',
  'hs_merged_object_ids',
  'hs_unique_creation_key',
  'hs_was_imported',
  'hs_read_only',
  'hs_created_by',
  'hs_modified_by',
]);

// Prefixes for families of internal plumbing properties:
//   hs_all_*               → hs_all_owner_ids, hs_all_team_ids, hs_all_accessible_team_ids, …
//   hs_object_source*      → hs_object_source, hs_object_source_label, hs_object_source_detail_1, …
//   hs_user_ids_of_all_*   → hs_user_ids_of_all_owners, hs_user_ids_of_all_notification_followers, …
const HS_SYSTEM_PLUMBING_PREFIXES = ['hs_all_', 'hs_object_source', 'hs_user_ids_of_all_'];

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

// The canonical HubSpot address fields, in the order they should read inside the
// banner (street → street 2 → city → state → zip → country). Contacts expose
// `address`/`city`/`state`/`zip`/`country`; Companies add `address2`. Only the
// fields actually present on the object are grouped, so this is safe to share
// across object types — an object missing a field simply omits it.
const ADDRESS_FIELDS = ['address', 'address2', 'city', 'state', 'zip', 'country'];

export interface HubspotDefaultViewOptions {
  /** Dot-path to the title property (e.g. 'properties.email'). */
  titleFieldPath?: string;
  /** Property names to show right after id. */
  priorityFields?: string[];
  /**
   * Blanket-hide `hs_`-prefixed (HubSpot-managed) properties as analytics/system
   * noise. Correct ONLY for the analytics-heavy CRM record objects
   * (contacts/companies/deals). Defaults to `false` — every other object type
   * (activity/engagement and commerce objects) keeps its `hs_`-prefixed primary
   * content visible. See {@link HubspotObjectConfig.hideHubspotManagedPropertiesByDefault}.
   */
  hideHubspotManagedProperties?: boolean;
}

/**
 * Build a default TableView for a HubSpot object (contacts, companies, deals, etc.).
 *
 * Column order: title property → id → priority properties → Address group → remaining properties
 * → remaining fixed fields (createdAt, updatedAt, archived, ...).
 */
export function buildHubspotDefaultView(schema: TSchema, options: HubspotDefaultViewOptions = {}): TableView {
  const { titleFieldPath, priorityFields, hideHubspotManagedProperties = false } = options;

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

  // The title and priority properties were explicitly chosen as meaningful, so
  // they must never be hidden — even when they are hs_-prefixed (e.g. a Note's
  // title is `hs_note_body`) and the object hides the hs_ namespace by default.
  const alwaysVisibleProps = new Set<string>(priorityFields ?? []);
  if (titlePropName) alwaysVisibleProps.add(titlePropName);

  // Separate address fields for banner grouping
  const addressFieldSet = new Set(ADDRESS_FIELDS);
  const addressCols: TableViewCol[] = [];
  const regularProps: { name: string; col: TableViewCol }[] = [];

  for (const [propName, propSchema] of orderedProps) {
    const col = buildPropertyCol(propName, propSchema, {
      hideHubspotManagedProperties,
      alwaysVisible: alwaysVisibleProps.has(propName),
    });
    if (addressFieldSet.has(propName)) {
      addressCols.push(col);
    } else {
      regularProps.push({ name: propName, col });
    }
  }

  // Build fixed fields (id, createdAt, updatedAt, archived). `properties` is the
  // CRM property bag handled above; `associations` is expanded into per-type FK
  // columns at the end rather than emitted as a single opaque object column.
  const fixedFieldIds = Object.keys(topLevel).filter(
    (k) => k !== 'properties' && !FIXED_FIELDS_HANDLED_SEPARATELY.has(k),
  );
  const fixedCols = new Map<string, TableViewCol>();
  for (const fieldId of fixedFieldIds) {
    fixedCols.set(fieldId, buildFixedCol(fieldId, topLevel[fieldId]));
  }

  // Foreign-key columns for the record's associations, appended after everything
  // else (a standalone column for one related type, an "Associations" group for many).
  const associationEntries = buildAssociationForeignKeyEntries(topLevel['associations']);

  // === Assemble final column order ===

  // 1. Title property (if present)
  if (titlePropName && regularProps.length > 0 && regularProps[0].name === titlePropName) {
    const titleEntry = regularProps.shift();
    if (titleEntry) cols.push(titleEntry.col);
  }

  // 2. id fixed field right after title
  const idCol = fixedCols.get('id');
  if (idCol) {
    cols.push(idCol);
    fixedCols.delete('id');
  }

  // 3. Priority properties (already ordered at front of regularProps after title was removed)
  const prioritySet = new Set(priorityFields ?? []);
  while (regularProps.length > 0 && prioritySet.has(regularProps[0].name)) {
    const next = regularProps.shift();
    if (next) cols.push(next.col);
  }

  // 4. Address banner group (near the front, after priority fields). Order its
  // columns by the canonical ADDRESS_FIELDS sequence rather than API order, so
  // the banner always reads street → city → state → zip → country.
  if (addressCols.length > 0) {
    const addressFieldOrder = new Map(ADDRESS_FIELDS.map((field, index) => [field, index]));
    addressCols.sort(
      (a, b) =>
        (addressFieldOrder.get(a.path.replace('properties.', '')) ?? 0) -
        (addressFieldOrder.get(b.path.replace('properties.', '')) ?? 0),
    );
    cols.push({ kind: 'banner-group', name: 'Address', cols: addressCols });
  }

  // 5. Remaining properties
  for (const { col } of regularProps) {
    cols.push(col);
  }

  // 6. Remaining fixed fields in priority order: createdAt, updatedAt, archived, then the rest
  const remainingFixedOrder = ['createdAt', 'updatedAt', 'archived'];
  for (const fieldId of remainingFixedOrder) {
    const fixedCol = fixedCols.get(fieldId);
    if (fixedCol) {
      cols.push(fixedCol);
      fixedCols.delete(fieldId);
    }
  }
  for (const [, col] of fixedCols) {
    cols.push(col);
  }

  // 7. Association foreign-key columns (or the "Associations" group) last.
  for (const entry of associationEntries) {
    cols.push(entry);
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

/** Whether a property is internal HubSpot plumbing, noise on every object type. */
function isHubspotSystemPlumbingProperty(propName: string): boolean {
  if (HS_SYSTEM_PLUMBING_PROPERTIES.has(propName)) return true;
  return HS_SYSTEM_PLUMBING_PREFIXES.some((prefix) => propName.startsWith(prefix));
}

/**
 * Determine whether a property should be hidden by default.
 *
 * @param hideHubspotManagedProperties - when true (contacts/companies/deals),
 *   blanket-hide the hs_ namespace as analytics noise; when false (all other
 *   objects), hs_ properties are primary content and stay visible.
 */
function isHiddenProperty(propName: string, hideHubspotManagedProperties: boolean): boolean {
  if (HIDDEN_PROPERTIES.has(propName)) return true;
  if (isHubspotSystemPlumbingProperty(propName)) return true;
  if (hideHubspotManagedProperties && propName.startsWith('hs_') && !HS_KEEP_VISIBLE.has(propName)) return true;
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

/** Build a TableViewCol for a fixed top-level field (id, createdAt, updatedAt, archived). */
function buildFixedCol(fieldId: string, fieldSchema: TSchema | undefined): TableViewCol {
  const isReadonly = READONLY_FIXED_FIELDS.has(fieldId) || fieldSchema?.[X_SCRATCH_READONLY] === true;

  return {
    kind: 'col',
    path: fieldId,
    name: formatFieldName(fieldId),
    type: mapFixedFieldType(fieldSchema),
    readonly: isReadonly || undefined,
  };
}

/**
 * Expand the `associations` object into one foreign-key column per related object
 * type. HubSpot keys associations by the related object type (`companies`,
 * `contacts`, `0-421`, …), and each `results[].id` is annotated as a foreign key
 * pointing at that type's table (see `buildAssociationsSchema`). The single opaque
 * `associations` object column is useless in a grid, so we surface a column per
 * type instead, each pointing at `associations.<type>.results` and flattened to
 * its list of ids for display (the FK ids then resolve to the related records).
 *
 * Returns the columns plus whether they should be wrapped: a single related type
 * renders as a standalone column ("Associated Contacts"); multiple types are
 * grouped under an "Associations" banner, each column still named "Associated X".
 */
function buildAssociationForeignKeyEntries(
  associationsSchema: TSchema | undefined,
): (TableViewCol | TableViewBannerGroup)[] {
  const associationFields: Record<string, TSchema> =
    (associationsSchema as TSchema & { properties?: Record<string, TSchema> })?.properties ?? {};
  const associationTypes = Object.keys(associationFields);
  if (associationTypes.length === 0) return [];

  const cols = associationTypes.map((assocType) => buildAssociationForeignKeyCol(assocType));

  if (cols.length === 1) return cols;
  return [{ kind: 'banner-group', name: 'Associations', cols }];
}

/** Build the foreign-key column for one association type (`associations.<type>.results`). */
function buildAssociationForeignKeyCol(assocType: string): TableViewCol {
  const targetTableDisplayName = OBJECT_CONFIG[assocType]?.displayName ?? assocType;

  return {
    kind: 'col',
    path: `associations.${assocType}.results`,
    // Always prefixed with "Associated" so the column reads clearly on its own
    // (e.g. "Associated Emails"), both standalone and inside the Associations group.
    name: `Associated ${targetTableDisplayName}`,
    // The flattened ids are foreign keys into the related object's table (its wsId is
    // the association type). Declared on the column because the FK annotation lives on
    // `results[].id` — below this column's path — so a schema-join can't recover it.
    // `linkedTableRemoteId` is the target table's full `remoteId`: every association
    // type is a STANDARD object whose `remoteId` is the single-segment `[objectType]`
    // (= the association type), so `[assocType]` deep-equals it (see buildAssociationsSchema).
    foreignKey: { linkedTableId: assocType, linkedTableRemoteId: [assocType] },
    // Flatten the [{ id, type }, …] array to its comma-joined ids for display; the
    // ids resolve to the related records via the schema's foreign-key annotation.
    displayTransformer: { type: 'jsonpath', options: { expression: '$[*].id', arrayHandling: 'join_comma' } },
    // The column is EDITABLE: `codec` is the bidirectional collapse to/from the
    // neutral CoreValue (here the list of related ids). `toCore` extracts the id
    // list from the verbatim `[{ id, type }, …]` array; `fromCore` packs an edited
    // id list back into `[{ id }, …]` — WITHOUT reshaping the on-disk data
    // (Connector Prime Directive): the record still stores the raw `results` array,
    // and the connector's v4-API publish path diffs by id. `type` is dropped on the
    // packed element because HubSpot assigns the association label; it returns on the
    // next pull. The grid runs `fromCore` on cell-edit; a sync uses the same pair.
    codec: buildAssociationCodec(),
  };
}

/**
 * Bidirectional codec for an "Associated X" column. The neutral CoreValue is the
 * list of related-record ids (`string[]`):
 *   toCore  : `[{ id, type }, …]` → `["id1", "id2"]`     (jsonpath `$[*].id`)
 *   fromCore: `["id1", "id2"]`    → `[{ id: "id1" }, …]` (map_array → wrap_object)
 */
function buildAssociationCodec(): ColumnCodec {
  return {
    toCore: {
      type: TransformerTypes.JSONPath,
      options: { expression: '$[*].id', arrayHandling: 'array' },
    },
    fromCore: {
      type: TransformerTypes.MapArray,
      options: {
        elementTransformer: {
          type: TransformerTypes.WrapObject,
          options: { template: { id: '$value' } },
        },
      },
    },
  };
}

/** Build a TableViewCol for a HubSpot CRM property (under properties.*). */
function buildPropertyCol(
  propName: string,
  propSchema: TSchema | undefined,
  opts: { hideHubspotManagedProperties: boolean; alwaysVisible: boolean },
): TableViewCol {
  const inner = unwrapOptional(propSchema);
  const connectorDataType =
    (propSchema?.[X_SCRATCH_CONNECTOR_DATA_TYPE] as string | undefined) ??
    (inner?.[X_SCRATCH_CONNECTOR_DATA_TYPE] as string | undefined);
  const isReadonly =
    propSchema?.[X_SCRATCH_READONLY] === true ||
    inner?.[X_SCRATCH_READONLY] === true ||
    isAlwaysReadonlyProperty(propName);
  const hidden = opts.alwaysVisible
    ? undefined
    : isHiddenProperty(propName, opts.hideHubspotManagedProperties) || undefined;

  const type = isOpaqueIdProperty(propName) ? 'string' : mapPropertyType(connectorDataType);

  return {
    kind: 'col',
    path: `properties.${propName}`,
    name: resolvePropertyDisplayName(propName, propSchema, inner),
    type,
    readonly: isReadonly || undefined,
    hidden,
  };
}

/**
 * Pick the human-readable column label for a HubSpot property. Prefers the
 * label HubSpot ships for the property (stored on the schema as `description`,
 * e.g. `hs_call_title` → "Call title") so we present the exact wording the
 * service's own UI uses — no hand-maintained name map. Falls back to a
 * humanized form of the raw property key when no label is present.
 */
function resolvePropertyDisplayName(
  propName: string,
  propSchema: TSchema | undefined,
  inner: TSchema | undefined,
): string {
  const label = propSchema?.description ?? inner?.description;
  if (typeof label === 'string' && label.trim() !== '') return label.trim();
  return humanizePropertyName(propName);
}

/**
 * Fallback humanizer for a raw HubSpot property key: drop the `hs_` system
 * prefix, turn underscores into spaces, and sentence-case the result
 * (`hs_call_title` → "Call title", `hs_email_domain` → "Email domain"). Only
 * used when the schema carries no HubSpot-provided label.
 */
function humanizePropertyName(propName: string): string {
  const withoutHsPrefix = propName.startsWith('hs_') ? propName.slice(3) : propName;
  const spaced = withoutHsPrefix.replace(/_/g, ' ').trim();
  if (spaced.length === 0) return propName;
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
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
