import { Type, type TSchema } from '@sinclair/typebox';
import {
  X_SCRATCH_CONNECTOR_DATA_TYPE,
  X_SCRATCH_FOREIGN_KEY_OPTIONS,
  X_SCRATCH_LAST_MODIFIED_FIELD,
  X_SCRATCH_READONLY,
} from '@spinner/shared-types';
import { PipedriveEntityType } from './pipedrive-types';

/**
 * Hardcoded system-field schemas for the v1 entities whose shape the Pipedrive
 * API does not let us introspect.
 *
 * Most Pipedrive entities (deals, persons, organizations, products, activities)
 * expose a `*Fields` metadata endpoint, so their schema is discovered
 * dynamically — new fields a user adds in Pipedrive appear automatically. Two
 * entities can't be discovered that way and so are the sanctioned "no
 * introspection available" exception (see the Connector Guide):
 *
 * - **Leads** have no `leadFields` endpoint. They *share* deals' CUSTOM fields
 *   (discovered from `dealFields`), but their SYSTEM shape is lead-specific (UUID
 *   id, `value: {amount, currency}`, `label_ids`, `person_id`/`organization_id`,
 *   …) and unlike deals. So leads = this static system schema + dynamic custom
 *   fields, the latter placed flat (top-level hash keys) per the v1 record shape.
 * - **Notes** have no `noteFields` endpoint and no custom fields at all, so their
 *   schema is entirely static.
 * - **Pipelines / stages** are v2 config objects with no Fields endpoint and no
 *   custom fields, so they are static too. Their `update_time` is *not* annotated
 *   as last-modified because their list endpoints reject `updated_since`.
 *
 * The connector still stores the **verbatim** API response on disk, so any field
 * not modelled here is preserved — this schema only drives display, validation,
 * foreign keys and the last-modified picker.
 */

/** A nullable string column. */
function stringOrNull(): TSchema {
  return Type.Union([Type.String(), Type.Null()]);
}

/** A nullable integer/number column. */
function numberOrNull(): TSchema {
  return Type.Union([Type.Number(), Type.Null()]);
}

/** A nullable boolean column. */
function booleanOrNull(): TSchema {
  return Type.Union([Type.Boolean(), Type.Null()]);
}

/** A nullable ISO date-only column. */
function dateOrNull(): TSchema {
  return Type.Union([Type.String({ format: 'date' }), Type.Null()]);
}

/** Tag a schema as read-only (never sent on create/update). */
function readonly(schema: TSchema): TSchema {
  return { ...schema, [X_SCRATCH_READONLY]: true };
}

/** A nullable foreign-key column pointing at another Pipedrive table. */
function foreignKey(valueSchema: TSchema, linkedTableId: PipedriveEntityType): TSchema {
  return { ...valueSchema, [X_SCRATCH_FOREIGN_KEY_OPTIONS]: { linkedTableId } };
}

/**
 * A free-form, server-hydrated nested object (e.g. a note's embedded `person`
 * stub). Stored verbatim and never written back.
 */
function readonlyNested(): TSchema {
  return readonly(Type.Union([Type.Record(Type.String(), Type.Unknown()), Type.Null()]));
}

/**
 * Leads system fields (`/v1/leads`). `id` is a UUID string; the deal-shared
 * custom fields are appended flat at the top level by the schema builder.
 */
const LEADS_SYSTEM_SCHEMA: Record<string, TSchema> = {
  id: readonly(stringOrNull()),
  title: stringOrNull(),
  owner_id: numberOrNull(),
  creator_id: readonly(numberOrNull()),
  // Lead label ids are UUID strings managed via the leadLabels endpoint.
  label_ids: Type.Array(Type.String()),
  value: Type.Object(
    {
      amount: numberOrNull(),
      currency: stringOrNull(),
    },
    { [X_SCRATCH_CONNECTOR_DATA_TYPE]: 'monetary' },
  ),
  expected_close_date: dateOrNull(),
  person_id: foreignKey(numberOrNull(), 'persons'),
  organization_id: foreignKey(numberOrNull(), 'organizations'),
  is_archived: booleanOrNull(),
  archive_time: readonly(stringOrNull()),
  source_name: readonly(stringOrNull()),
  source_deal_id: readonly(numberOrNull()),
  origin: readonly(stringOrNull()),
  origin_id: readonly(stringOrNull()),
  channel: numberOrNull(),
  channel_id: stringOrNull(),
  was_seen: booleanOrNull(),
  next_activity_id: readonly(numberOrNull()),
  add_time: readonly(stringOrNull()),
  update_time: { ...readonly(stringOrNull()), [X_SCRATCH_LAST_MODIFIED_FIELD]: true },
  visible_to: Type.Union([Type.String(), Type.Number(), Type.Null()]),
  cc_email: readonly(stringOrNull()),
};

/**
 * Notes system fields (`/v1/notes`). Notes have no custom fields. The embedded
 * `organization`/`person`/`deal`/`lead`/`user` objects are server-hydrated stubs
 * stored verbatim and never written back.
 */
const NOTES_SYSTEM_SCHEMA: Record<string, TSchema> = {
  id: readonly(numberOrNull()),
  user_id: numberOrNull(),
  deal_id: foreignKey(numberOrNull(), 'deals'),
  person_id: foreignKey(numberOrNull(), 'persons'),
  org_id: foreignKey(numberOrNull(), 'organizations'),
  // Leads use UUID ids, so a note's lead_id is a string.
  lead_id: foreignKey(stringOrNull(), 'leads'),
  content: stringOrNull(),
  add_time: readonly(stringOrNull()),
  update_time: { ...readonly(stringOrNull()), [X_SCRATCH_LAST_MODIFIED_FIELD]: true },
  active_flag: readonly(booleanOrNull()),
  pinned_to_deal_flag: booleanOrNull(),
  pinned_to_person_flag: booleanOrNull(),
  pinned_to_organization_flag: booleanOrNull(),
  pinned_to_lead_flag: booleanOrNull(),
  last_update_user_id: readonly(numberOrNull()),
  organization: readonlyNested(),
  person: readonlyNested(),
  deal: readonlyNested(),
  lead: readonlyNested(),
  user: readonlyNested(),
};

/**
 * Pipeline system fields (`/api/v2/pipelines`). A v2 config object with no custom
 * fields. `update_time` is read-only but intentionally NOT annotated as
 * last-modified — the pipelines endpoint rejects `updated_since`.
 */
const PIPELINES_SYSTEM_SCHEMA: Record<string, TSchema> = {
  id: readonly(numberOrNull()),
  name: stringOrNull(),
  order_nr: numberOrNull(),
  is_deal_probability_enabled: booleanOrNull(),
  is_deleted: readonly(booleanOrNull()),
  add_time: readonly(stringOrNull()),
  update_time: readonly(stringOrNull()),
};

/**
 * Stage system fields (`/api/v2/stages`). A v2 config object with no custom
 * fields; each stage belongs to a pipeline via `pipeline_id` (required on create).
 */
const STAGES_SYSTEM_SCHEMA: Record<string, TSchema> = {
  id: readonly(numberOrNull()),
  name: stringOrNull(),
  order_nr: numberOrNull(),
  pipeline_id: foreignKey(numberOrNull(), 'pipelines'),
  deal_probability: numberOrNull(),
  is_deal_rot_enabled: booleanOrNull(),
  days_to_rotten: numberOrNull(),
  is_deleted: readonly(booleanOrNull()),
  add_time: readonly(stringOrNull()),
  update_time: readonly(stringOrNull()),
};

/**
 * Static system-field schemas keyed by entity type. Only the entities whose
 * system shape can't be discovered have an entry; everything else is fully
 * dynamic and absent here.
 */
export const STATIC_SYSTEM_SCHEMAS: Partial<Record<PipedriveEntityType, Record<string, TSchema>>> = {
  leads: LEADS_SYSTEM_SCHEMA,
  notes: NOTES_SYSTEM_SCHEMA,
  pipelines: PIPELINES_SYSTEM_SCHEMA,
  stages: STAGES_SYSTEM_SCHEMA,
};
