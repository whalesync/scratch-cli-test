import { Type, type TSchema } from '@sinclair/typebox';
import {
  TransformerTypes,
  VirtualFieldDef,
  X_SCRATCH_CONNECTOR_DATA_TYPE,
  X_SCRATCH_READONLY,
  X_SCRATCH_REMOTE_FIELD_ID,
  X_SCRATCH_VIRTUAL_FIELDS,
} from '@spinner/shared-types';
import { BaseJsonTableSpec, EntityId, idPath } from '../../types';
import { AttioApiClient } from './attio-api-client';
import { buildAttioDefaultView, LIST_VIEW_CONFIG, OBJECT_VIEW_CONFIG } from './attio-default-view';
import { AttioAttribute, AttioAttributeType, STANDARD_OBJECT_DISPLAY, type AttioStandardObject } from './attio-types';

/**
 * JSONPath expression to extract the primary value from a single-element Attio
 * value array, keyed by attribute type. Each attribute type stores its useful
 * payload at a different key inside the array element object.
 *
 * Types not listed here (e.g. `interaction`) are too complex for a simple
 * extraction and are left as raw arrays.
 */
const ATTIO_VALUE_EXPRESSION: Partial<Record<AttioAttributeType, string>> = {
  text: '$[0].value',
  number: '$[0].value',
  checkbox: '$[0].value',
  currency: '$[0].value',
  date: '$[0].value',
  timestamp: '$[0].value',
  rating: '$[0].value',
  domain: '$[0].domain',
  'email-address': '$[0].email_address',
  'phone-number': '$[0].phone_number',
  status: '$[0].status.title',
  select: '$[0].option.title',
  'record-reference': '$[0].target_record_id',
  'actor-reference': '$[0].referenced_actor_id',
  location: '$[0].locality',
  'personal-name': '$[*].first_name',
};

/** Build a virtual field definition for an Attio attribute, if applicable. */
function buildVirtualField(attr: AttioAttribute): VirtualFieldDef[] | undefined {
  const expression = ATTIO_VALUE_EXPRESSION[attr.type];
  if (!expression) return undefined;

  // Map the extracted value to a display type
  const typeMap: Partial<Record<AttioAttributeType, string>> = {
    text: 'string',
    number: 'number',
    checkbox: 'boolean',
    currency: 'number',
    date: 'string',
    timestamp: 'string',
    rating: 'number',
    domain: 'string',
    'email-address': 'string',
    'phone-number': 'string',
    status: 'string',
    select: 'string',
    'record-reference': 'string',
    'actor-reference': 'string',
    location: 'string',
    'personal-name': 'string',
  };

  return [
    {
      displayLabel: attr.title,
      type: typeMap[attr.type] ?? 'string',
      suggestedTransformer: {
        type: TransformerTypes.JSONPath,
        options: { expression, arrayHandling: 'first' as const },
      },
    },
  ];
}

/**
 * Build a TypeBox schema fragment for one entry in an Attio `record.values`
 * array. The shape is intentionally permissive: Attio returns a typed object
 * with `attribute_type`, `active_from`, `active_until`, plus type-specific
 * payload keys (`value`, `option`, `target_record_id`, etc.). Modeling every
 * inner shape brittle-ly would burn the whole appetite — and we round-trip
 * verbatim anyway, so the on-disk file is authoritative.
 *
 * The `CONNECTOR_DATA_TYPE` annotation preserves the attribute type for the
 * client UI and any future field-level transforms. `REMOTE_FIELD_ID` carries
 * the api_slug so syncs can address the field by its remote name.
 *
 * For types where the useful value is buried inside the array element,
 * `X_SCRATCH_VIRTUAL_FIELDS` provides a JSONPath-based extraction so the UI
 * and sync editor can present a clean scalar instead of the raw array.
 */
function valueArraySchemaForAttribute(attr: AttioAttribute): TSchema {
  const valueSchema = Type.Object({}, { additionalProperties: true });
  const virtualFields = buildVirtualField(attr);

  return Type.Array(valueSchema, {
    description: attr.description ?? attr.title,
    [X_SCRATCH_REMOTE_FIELD_ID]: attr.api_slug,
    [X_SCRATCH_CONNECTOR_DATA_TYPE]: attr.type,
    ...(attr.is_archived ? { [X_SCRATCH_READONLY]: true } : {}),
    ...(virtualFields ? { [X_SCRATCH_VIRTUAL_FIELDS]: virtualFields } : {}),
  });
}

/** Build the `values` object schema, keyed by attribute api_slug. */
function buildValuesSchema(attributes: AttioAttribute[]): TSchema {
  const properties: Record<string, TSchema> = {};
  for (const attr of attributes) {
    if (attr.is_archived) continue;
    properties[attr.api_slug] = valueArraySchemaForAttribute(attr);
  }
  return Type.Object(properties, {
    description: 'Attio attribute values, keyed by api_slug',
    additionalProperties: false,
  });
}

/**
 * Build the table spec for one of the three v1 standard objects (companies,
 * people, deals). The attributes list comes from `GET /v2/objects/{slug}/attributes`
 * — including any custom fields the workspace has added.
 */
export async function buildAttioObjectTableSpec(
  id: EntityId,
  objectSlug: AttioStandardObject,
  client: AttioApiClient,
): Promise<BaseJsonTableSpec> {
  const attributes = await client.listObjectAttributes(objectSlug);
  const valuesSchema = buildValuesSchema(attributes);
  const display = STANDARD_OBJECT_DISPLAY[objectSlug];

  const schema = Type.Object(
    {
      id: Type.Object(
        {
          workspace_id: Type.String(),
          object_id: Type.String(),
          record_id: Type.String(),
        },
        { [X_SCRATCH_READONLY]: true, description: 'Attio record id triple' },
      ),
      created_at: Type.String({ format: 'date-time', [X_SCRATCH_READONLY]: true }),
      web_url: Type.Optional(Type.String({ [X_SCRATCH_READONLY]: true })),
      values: valuesSchema,
    },
    { $id: `attio/${objectSlug}`, title: display.plural },
  );

  const viewConfig = OBJECT_VIEW_CONFIG[objectSlug] ?? { valuesKey: 'values' };

  return {
    id,
    slug: id.wsId,
    name: display.plural,
    schema,
    idColumnRemoteId: idPath('id.record_id'),
    // All three v1 objects (companies, people, deals) expose a `name` attribute
    // suitable for filenames — for people it's the `personal-name` type, for
    // companies/deals it's plain text.
    titleColumnRemoteId: ['values', 'name'],
    basePath: [],
    generatedAt: new Date().toISOString(),
    defaultView: buildAttioDefaultView(schema, viewConfig),
  };
}

/**
 * Build the table spec for a list. The schema only describes list-scoped
 * attributes (from `GET /v2/lists/{slug}/attributes`) — e.g. a deal's stage in
 * *this* pipeline. The parent record's own attributes are *not* embedded; the
 * parent objects (companies/people/deals) are already first-class tables in
 * the workbook, so duplicating their data here would only churn diffs.
 *
 * Joining a list entry back to its parent happens at read time via
 * `parent_record_id`. List entries are deliberately thin: stage + pointer.
 */
export async function buildAttioListTableSpec(
  id: EntityId,
  listSlug: string,
  listName: string,
  client: AttioApiClient,
): Promise<BaseJsonTableSpec> {
  const listAttributes = await client.listListAttributes(listSlug);
  const entryValuesSchema = buildValuesSchema(listAttributes);

  const schema = Type.Object(
    {
      id: Type.Object(
        {
          workspace_id: Type.String(),
          list_id: Type.String(),
          entry_id: Type.String(),
        },
        { [X_SCRATCH_READONLY]: true, description: 'Attio list-entry id triple' },
      ),
      parent_record_id: Type.String({ [X_SCRATCH_READONLY]: true }),
      parent_object: Type.String({ [X_SCRATCH_READONLY]: true }),
      created_at: Type.String({ format: 'date-time', [X_SCRATCH_READONLY]: true }),
      entry_values: entryValuesSchema,
    },
    { $id: `attio/list-${listSlug}`, title: listName },
  );

  return {
    id,
    slug: id.wsId,
    name: listName,
    schema,
    idColumnRemoteId: idPath('id.entry_id'),
    // List entries don't carry a name of their own; the parent_record_id is
    // the closest stable identifier for filenames + display.
    titleColumnRemoteId: ['parent_record_id'],
    basePath: ['Lists'],
    generatedAt: new Date().toISOString(),
    defaultView: buildAttioDefaultView(schema, LIST_VIEW_CONFIG),
  };
}
