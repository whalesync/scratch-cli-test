import { type DataSourceObjectResponse } from '@notionhq/client';
import { Type, type TSchema } from '@sinclair/typebox';
import {
  AssetFieldOptions,
  TransformerTypes,
  X_SCRATCH_ASSET_FIELD,
  X_SCRATCH_CONNECTOR_DATA_TYPE,
  X_SCRATCH_FOREIGN_KEY_OPTIONS,
  X_SCRATCH_LAST_MODIFIED_FIELD,
  X_SCRATCH_READONLY,
  X_SCRATCH_REMOTE_FIELD_ID,
  X_SCRATCH_SUGGESTED_IN_TRANSFORMER,
  X_SCRATCH_SUGGESTED_TRANSFORMER,
  X_SCRATCH_VIRTUAL_FIELDS,
  type TransformerConfig,
  type VirtualFieldDef,
} from '@spinner/shared-types';
import { sanitizeForTableWsId } from '../../ids';
import { BaseJsonTableSpec, DotPath, EntityId, dotPath } from '../../types';
import { getDataSourceDisplayName } from './notion-data-source-types';

/**
 * Read-only property types that cannot be updated via the Notion API.
 */
export const NOTION_READ_ONLY_PROPERTY_TYPES = new Set([
  'rollup',
  'formula',
  'created_time',
  'last_edited_time',
  'created_by',
  'last_edited_by',
  'unique_id',
  'verification',
]);

/**
 * Build a BaseJsonTableSpec from a Notion 2025-09-03 data source definition.
 *
 * Generates a JSON Schema describing the raw Notion page API response format.
 * The `dataSource` argument carries the property map (which moved from the
 * database to the data source in 2025-09-03) plus its display name. Property
 * shapes themselves are unchanged, so {@link notionPropertyToJsonSchema}
 * still reads them via the SDK v3 `DatabaseObjectResponse['properties']` type.
 */
export function buildNotionJsonTableSpec(id: EntityId, dataSource: DataSourceObjectResponse): BaseJsonTableSpec {
  const [databaseId] = id.remoteId;

  const propertySchemas: Record<string, TSchema> = {};
  let titlePath: DotPath | undefined;

  for (const [name, property] of Object.entries(dataSource.properties)) {
    const propSchema = notionPropertyToJsonSchema(property);
    propertySchemas[name] = Type.Optional(propSchema);

    if (property.type === 'title') {
      titlePath = dotPath(`properties.${name}`);
    }
  }

  const tableTitle = getDataSourceDisplayName(dataSource);

  const schema = Type.Object(
    {
      object: Type.Literal('page', { description: 'Object type' }),
      id: Type.String({ description: 'Unique page identifier' }),
      created_time: Type.String({ description: 'Page creation time', format: 'date-time', [X_SCRATCH_READONLY]: true }),
      last_edited_time: Type.String({
        description: 'Last edit time',
        format: 'date-time',
        [X_SCRATCH_READONLY]: true,
        // System field present on every Notion page. Drives incremental pulls
        // (the connector filters on it) and surfaces it to the UI's
        // last-modified-field picker. See notion-incremental.ts.
        [X_SCRATCH_LAST_MODIFIED_FIELD]: true,
      }),
      created_by: Type.Object(
        {
          object: Type.Literal('user'),
          id: Type.String(),
        },
        { description: 'User who created the page', [X_SCRATCH_READONLY]: true },
      ),
      last_edited_by: Type.Object(
        {
          object: Type.Literal('user'),
          id: Type.String(),
        },
        { description: 'User who last edited the page', [X_SCRATCH_READONLY]: true },
      ),
      cover: Type.Optional(
        Type.Union(
          [
            Type.Object({
              type: Type.Literal('external'),
              external: Type.Object({ url: Type.String({ format: 'uri' }) }),
            }),
            Type.Object({
              type: Type.Literal('file'),
              file: Type.Object({ url: Type.String({ format: 'uri' }), expiry_time: Type.String() }),
            }),
            Type.Null(),
          ],
          { [X_SCRATCH_ASSET_FIELD]: { idPath: null, urlExpires: true } satisfies AssetFieldOptions },
        ),
      ),
      icon: Type.Optional(
        Type.Union(
          [
            Type.Object({
              type: Type.Literal('emoji'),
              emoji: Type.String(),
            }),
            Type.Object({
              type: Type.Literal('external'),
              external: Type.Object({ url: Type.String({ format: 'uri' }) }),
            }),
            Type.Object({
              type: Type.Literal('file'),
              file: Type.Object({ url: Type.String({ format: 'uri' }), expiry_time: Type.String() }),
            }),
            // Built-in Notion named icon, e.g. { type: 'icon', icon: { name: 'light-bulb', color: 'orange' } }.
            // Carries no URL, so it is not an extractable asset (extractUrl skips it).
            Type.Object({
              type: Type.Literal('icon'),
              icon: Type.Object({ name: Type.String(), color: Type.Optional(Type.String()) }),
            }),
            // Custom uploaded emoji, e.g. { type: 'custom_emoji', custom_emoji: { id, name, url } }.
            // `url` is a real Notion-hosted asset URL, extracted like file/external icons.
            Type.Object({
              type: Type.Literal('custom_emoji'),
              custom_emoji: Type.Object({
                id: Type.String(),
                name: Type.Optional(Type.String()),
                url: Type.String({ format: 'uri' }),
              }),
            }),
            Type.Null(),
          ],
          { [X_SCRATCH_ASSET_FIELD]: { idPath: null, urlExpires: true } satisfies AssetFieldOptions },
        ),
      ),
      parent: Type.Union(
        [
          Type.Object({
            type: Type.Literal('database_id'),
            database_id: Type.String(),
          }),
          Type.Object({
            type: Type.Literal('data_source_id'),
            data_source_id: Type.String(),
          }),
        ],
        { description: 'Parent reference (database or data source)' },
      ),
      // Trash / archive state. Notion renamed these across API versions:
      // 2025-09-03 emitted `archived`; 2026-03-11 stopped emitting it and uses
      // `in_trash` (the renamed soft-delete) plus a distinct `is_archived`. All
      // three are optional so the envelope faithfully describes a record pulled
      // under either version — older on-disk records still carry `archived`.
      archived: Type.Optional(Type.Boolean({ description: 'Is page archived (legacy; absent under 2026-03-11+)' })),
      in_trash: Type.Optional(Type.Boolean({ description: 'Is page in trash' })),
      is_archived: Type.Optional(Type.Boolean({ description: 'Is page archived (2026-03-11+)' })),
      page_content: Type.Optional(
        Type.Array(Type.Unknown(), {
          description: 'Page body content (Notion blocks)',
          [X_SCRATCH_SUGGESTED_TRANSFORMER]: { type: TransformerTypes.NotionToHtml },
          [X_SCRATCH_READONLY]: true,
        }),
      ),
      properties: Type.Object(propertySchemas, { description: 'Page properties' }),
      url: Type.String({ description: 'Page URL', format: 'uri', [X_SCRATCH_READONLY]: true }),
      public_url: Type.Optional(Type.Union([Type.String({ format: 'uri' }), Type.Null()])),
    },
    {
      $id: `notion/${databaseId}`,
      title: tableTitle,
    },
  );

  return {
    id,
    slug: id.wsId,
    name: sanitizeForTableWsId(tableTitle),
    schema,
    idPath: dotPath('id'),
    titlePath,
    basePath: [],
    // Deep link to the database in Notion's web UI. notion.so addresses a
    // database by its id with dashes stripped (the 32-char hex form), e.g.
    // https://www.notion.so/208a94267a718094b634e83686fb1755
    remoteWebUrl: `https://www.notion.so/${databaseId.replace(/-/g, '')}`,
    generatedAt: new Date().toISOString(),
  };
}

/**
 * Build the rich-text span object schema shared by `title` and `rich_text`
 * property inner values (a Notion rich-text array element).
 */
function notionRichTextSpanSchema(): TSchema {
  return Type.Object({
    type: Type.String(),
    text: Type.Optional(Type.Object({ content: Type.String(), link: Type.Optional(Type.Unknown()) })),
    plain_text: Type.String(),
    href: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  });
}

/**
 * Build the Notion user object schema (`{ object: 'user', id, ... }`) used as
 * the inner value of `created_by` / `last_edited_by` properties.
 */
function notionUserObjectSchema(): TSchema {
  return Type.Object({
    object: Type.Literal('user'),
    id: Type.String(),
    name: Type.Optional(Type.String()),
    avatar_url: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  });
}

/**
 * Wrap an inner property value in the raw Notion property envelope that the pull
 * path persists verbatim on disk: `{ id, type: <typeKey>, <typeKey>: value, ...extras }`.
 *
 * `typeKey` is the Notion property type string, which is also the key the value
 * lives under in every Notion property object — e.g. an email property is stored
 * as `{ id, type: 'email', email: '...' }`, a multi_select as
 * `{ id, type: 'multi_select', multi_select: [...] }`. Modeling this envelope —
 * rather than the bare inner value — is what makes the generated schema match the
 * verbatim API response, per the *Preserve external data fidelity* product
 * principle. See docs/plans/resolved/2026-06-02-notion-schema-envelope-fix/2026-06-02-notion-schema-envelope-fix.md.
 *
 * The envelope is intentionally faithful-where-it-matters, not exhaustive: it
 * models the structural extras real data carries (e.g. `relation.has_more`) but
 * leaves rarely-needed keys off. TypeBox omits `additionalProperties`, so any
 * extra keys on a real record (rich-text `annotations`, page `parent.database_id`)
 * still validate.
 */
function wrapInNotionPropertyEnvelope(
  typeKey: string,
  innerValueSchema: TSchema,
  description: string,
  extraEnvelopeKeys?: Record<string, TSchema>,
): TSchema {
  return Type.Object(
    {
      id: Type.String(),
      type: Type.Literal(typeKey),
      [typeKey]: innerValueSchema,
      ...(extraEnvelopeKeys ?? {}),
    },
    { description },
  );
}

/**
 * Convert a Notion database property to a TypeBox JSON Schema.
 *
 * Returns the raw on-disk **envelope** `{ id, type, <typeKey>: value }` (see
 * {@link wrapInNotionPropertyEnvelope}), with all `x-scratch-*` annotations on
 * the outer envelope object. Placing the annotations on the outer object keeps
 * each property a single leaf for diff/column granularity (see
 * `build-column-definitions.ts` and the `extractSchemaFields` leaf guard in
 * `server/src/utils/schema-helpers.ts`).
 */
export function notionPropertyToJsonSchema(property: DataSourceObjectResponse['properties'][string]): TSchema {
  const description = property.name;

  // Inner value schema (the unwrapped per-property value) plus any annotations
  // that belong on the outer envelope. `extraEnvelopeKeys` carries structural
  // envelope siblings beyond `{ id, type, <typeKey> }` (e.g. relation.has_more).
  let innerValueSchema: TSchema;
  let extraEnvelopeKeys: Record<string, TSchema> | undefined;
  let virtualFields: VirtualFieldDef[] | undefined;
  let assetFieldOptions: AssetFieldOptions | undefined;
  let foreignKeyOptions: { linkedTableId: string; map: string } | undefined;

  switch (property.type) {
    case 'title':
      innerValueSchema = Type.Array(notionRichTextSpanSchema());
      // JSONPath is envelope-relative: `$.title` resolves against the property
      // envelope `{ id, type: 'title', title: [...] }` we now describe.
      virtualFields = [
        {
          displayLabel: description,
          type: 'string',
          suggestedTransformer: {
            type: TransformerTypes.JSONPath,
            options: { expression: '$.title[*].plain_text', arrayHandling: 'concat' },
          },
        },
      ];
      break;

    case 'rich_text':
      innerValueSchema = Type.Array(notionRichTextSpanSchema());
      break;

    case 'number':
      innerValueSchema = Type.Union([Type.Number(), Type.Null()]);
      break;

    case 'select':
    case 'status':
      innerValueSchema = Type.Union([
        Type.Object({ id: Type.String(), name: Type.String(), color: Type.String() }),
        Type.Null(),
      ]);
      break;

    case 'multi_select':
      innerValueSchema = Type.Array(Type.Object({ id: Type.String(), name: Type.String(), color: Type.String() }));
      break;

    case 'date': {
      // Notion date values are EITHER date-only ("2025-02-20") OR full RFC3339
      // ("2025-02-20T13:00:00.000-05:00"), depending on whether the user picked a
      // time. Accept both. A bare format:'date' is NOT a superset of date-time —
      // the CLI's jsonschema validator (should_validate_formats(true)) requires a
      // length-10 string for 'date' — so model the two precisions as a union.
      const notionDateString = Type.Union([Type.String({ format: 'date' }), Type.String({ format: 'date-time' })]);
      innerValueSchema = Type.Union([
        Type.Object({
          start: notionDateString,
          end: Type.Optional(Type.Union([notionDateString, Type.Null()])),
          time_zone: Type.Optional(Type.Union([Type.String(), Type.Null()])),
        }),
        Type.Null(),
      ]);
      break;
    }

    // A Notion `people` property holds not just individual users but also groups: a
    // workspace/teamspace group can be mentioned in a person property, and the API then
    // returns that member verbatim as `{ id, object: 'group', name }` (no `person`
    // sub-object). `object` must therefore accept 'group' as well as 'user', otherwise
    // enforce_schema rejects every group member ("user" was expected). The remaining
    // fields are already optional, which covers the slimmer group shape.
    case 'people':
      innerValueSchema = Type.Array(
        Type.Object({
          object: Type.Union([Type.Literal('user'), Type.Literal('group')]),
          id: Type.String(),
          name: Type.Optional(Type.String()),
          avatar_url: Type.Optional(Type.Union([Type.String(), Type.Null()])),
          type: Type.Optional(Type.String()),
          person: Type.Optional(Type.Object({ email: Type.Optional(Type.String()) })),
        }),
      );
      break;

    case 'files':
      innerValueSchema = Type.Array(
        Type.Union([
          Type.Object({
            name: Type.String(),
            type: Type.Literal('external'),
            external: Type.Object({ url: Type.String({ format: 'uri' }) }),
          }),
          Type.Object({
            name: Type.String(),
            type: Type.Literal('file'),
            file: Type.Object({ url: Type.String({ format: 'uri' }), expiry_time: Type.String() }),
          }),
        ]),
      );
      assetFieldOptions = { idPath: null, urlExpires: true };
      // NotionFileUrl reads the envelope and digs into `.files` itself.
      virtualFields = [
        {
          displayLabel: description,
          type: 'string',
          suggestedTransformer: {
            type: TransformerTypes.NotionFileUrl,
            options: { arrayHandling: 'array' },
          },
        },
      ];
      break;

    case 'checkbox':
      innerValueSchema = Type.Boolean();
      break;

    // Notion does NOT validate the content of `url`/`email` properties — they are
    // free-text fields. The API returns verbatim whatever the user typed: schemeless
    // domains ("lu.ma/adithya"), phone numbers, Twitter handles ("@_adenab"), notes
    // ("Yohei tweet"), even multiple comma-separated emails. Asserting format:'uri'/
    // 'email' would make the CLI's enforce_schema validator (should_validate_formats(true))
    // reject that legitimate data, so we model these as plain nullable strings (like
    // phone_number below). URL column display-typing is preserved via the
    // x-scratch-connector-data-type='url' signal in notion-default-view.ts.
    case 'url':
      innerValueSchema = Type.Union([Type.String(), Type.Null()]);
      break;

    case 'email':
      innerValueSchema = Type.Union([Type.String(), Type.Null()]);
      break;

    case 'phone_number':
      innerValueSchema = Type.Union([Type.String(), Type.Null()]);
      break;

    case 'formula':
      // Doubly nested: the envelope `formula` value is itself a tagged result
      // object `{ type, <result> }`. The default view shows this inner object;
      // we model both nesting levels rather than guessing the result key.
      innerValueSchema = Type.Union([
        Type.Object({ type: Type.Literal('string'), string: Type.Union([Type.String(), Type.Null()]) }),
        Type.Object({ type: Type.Literal('number'), number: Type.Union([Type.Number(), Type.Null()]) }),
        Type.Object({ type: Type.Literal('boolean'), boolean: Type.Boolean() }),
        Type.Object({
          type: Type.Literal('date'),
          date: Type.Union([Type.Object({ start: Type.String(), end: Type.Optional(Type.String()) }), Type.Null()]),
        }),
      ]);
      break;

    case 'relation':
      innerValueSchema = Type.Array(Type.Object({ id: Type.String() }));
      // Real relation data carries a sibling `has_more` flag (Notion truncates
      // the relation array to 25 on response).
      extraEnvelopeKeys = { has_more: Type.Optional(Type.Boolean()) };
      foreignKeyOptions = property.relation.database_id
        ? { linkedTableId: property.relation.database_id, map: 'id' }
        : undefined;
      break;

    case 'rollup':
      // Doubly nested: the envelope `rollup` value is itself an object carrying
      // `function`/`type` plus the result key. Shown as its inner object.
      innerValueSchema = Type.Object({
        type: Type.String(),
        function: Type.String(),
        number: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
        date: Type.Optional(Type.Unknown()),
        array: Type.Optional(Type.Array(Type.Unknown())),
      });
      break;

    case 'created_time':
    case 'last_edited_time':
      innerValueSchema = Type.String({ format: 'date-time' });
      break;

    case 'created_by':
    case 'last_edited_by':
      innerValueSchema = notionUserObjectSchema();
      break;

    default:
      // Unknown / future Notion type: keep the envelope shape with an opaque
      // inner value. Renders as JSON; never silently mistyped.
      innerValueSchema = Type.Unknown();
      break;
  }

  const schema = wrapInNotionPropertyEnvelope(property.type, innerValueSchema, description, extraEnvelopeKeys);

  schema[X_SCRATCH_CONNECTOR_DATA_TYPE] = property.type;
  schema[X_SCRATCH_READONLY] = NOTION_READ_ONLY_PROPERTY_TYPES.has(property.type) ? true : undefined;
  schema[X_SCRATCH_REMOTE_FIELD_ID] = property.id;
  if (virtualFields) schema[X_SCRATCH_VIRTUAL_FIELDS] = virtualFields;
  if (assetFieldOptions) schema[X_SCRATCH_ASSET_FIELD] = assetFieldOptions;
  if (foreignKeyOptions) schema[X_SCRATCH_FOREIGN_KEY_OPTIONS] = foreignKeyOptions;

  // Declarative transform hints so a sync wraps/unwraps the Notion envelope
  // automatically (see notionInboundPackTransformer / notionOutboundUnpackTransformer).
  const inboundPack = notionInboundPackTransformer(property.type);
  if (inboundPack) schema[X_SCRATCH_SUGGESTED_IN_TRANSFORMER] = inboundPack;
  // `title`/`files` already expose their unpack via a virtual field; don't override it.
  if (!virtualFields) {
    const outboundUnpack = notionOutboundUnpackTransformer(property.type);
    if (outboundUnpack) schema[X_SCRATCH_SUGGESTED_TRANSFORMER] = outboundUnpack;
  }
  return schema;
}

/**
 * A single recursive `wrap_object` step that builds `template` with `"$value"` substituted in.
 * `emptyTemplate` (when given) is the field's "cleared" shape Notion accepts, emitted when the
 * source value is empty so that syncing an empty/null value clears the field instead of writing
 * an invalid envelope (e.g. `{ date: { start: "" } }`).
 */
function notionWrapTransformer(
  template: Record<string, unknown>,
  emptyTemplate?: Record<string, unknown>,
): TransformerConfig {
  return { type: TransformerTypes.WrapObject, options: emptyTemplate ? { template, emptyTemplate } : { template } };
}

/**
 * The inbound (pack) transform a sync applies to a plain value before WRITING it
 * into a Notion property of `notionType` — wrapping it into the
 * `{ type, <typeKey>: value }` envelope Notion's write API expects (the connector's
 * `transformPropertiesForUpdate` then strips `type`/`id`). Built from a single
 * recursive `wrap_object`. Returns undefined for types we don't (yet) write or
 * that need element mapping / id resolution (`multi_select`, `relation`, `files`,
 * read-only types) — those are a fast-follow.
 */
function notionInboundPackTransformer(notionType: string): TransformerConfig | undefined {
  switch (notionType) {
    // `plain_text` mirrors what a Notion *pull* returns on every span. It's a
    // read-only field Notion ignores on write, but writing it here keeps a
    // locally-created record (packed but never round-tripped through Notion) the
    // same shape as a pulled one — so the outbound unpack ($.title/$.rich_text[*].plain_text),
    // which record matching uses to canonicalize, can read it. Without it, a pending
    // file's match key reduces to null and the next sync fails to match it, creating a
    // duplicate. See notion-json-schema round-trip test.
    // Each type passes an `emptyTemplate`: the shape Notion accepts to CLEAR the field when
    // an empty/null value is synced (an empty rich_text/title array, or a null scalar). This
    // matches what a Notion *pull* returns for an empty field, keeping a cleared record the
    // same shape as a pulled one. `checkbox` has no clear shape (it's a boolean, never empty),
    // so it omits emptyTemplate and an empty value falls back to null (dropped, unchanged).
    case 'title':
      return notionWrapTransformer(
        { type: 'title', title: [{ type: 'text', text: { content: '$value' }, plain_text: '$value' }] },
        { type: 'title', title: [] },
      );
    case 'rich_text':
      return notionWrapTransformer(
        { type: 'rich_text', rich_text: [{ type: 'text', text: { content: '$value' }, plain_text: '$value' }] },
        { type: 'rich_text', rich_text: [] },
      );
    case 'number':
      return notionWrapTransformer({ type: 'number', number: '$value' }, { type: 'number', number: null });
    case 'checkbox':
      return notionWrapTransformer({ type: 'checkbox', checkbox: '$value' });
    case 'date':
      // A scalar date populates `start`; `end`/`time_zone` are left for the editor.
      return notionWrapTransformer({ type: 'date', date: { start: '$value' } }, { type: 'date', date: null });
    case 'url':
      return notionWrapTransformer({ type: 'url', url: '$value' }, { type: 'url', url: null });
    case 'email':
      return notionWrapTransformer({ type: 'email', email: '$value' }, { type: 'email', email: null });
    case 'phone_number':
      return notionWrapTransformer(
        { type: 'phone_number', phone_number: '$value' },
        { type: 'phone_number', phone_number: null },
      );
    case 'select':
      return notionWrapTransformer({ type: 'select', select: { name: '$value' } }, { type: 'select', select: null });
    default:
      return undefined;
  }
}

/**
 * The outbound (unpack) transform a sync applies when READING a Notion property of
 * `notionType` as a source — flattening the envelope to a plain value. Only
 * `rich_text` for now (`title` and `files` unpack via their virtual field);
 * unpack hints for the other types are a fast-follow.
 */
function notionOutboundUnpackTransformer(notionType: string): TransformerConfig | undefined {
  if (notionType === 'rich_text') {
    return {
      type: TransformerTypes.JSONPath,
      options: { expression: '$.rich_text[*].plain_text', arrayHandling: 'concat' },
    };
  }
  if (notionType === 'relation') {
    // A relation's plain value is its linked-record id ARRAY. This is what the sync's FK phase extracts
    // before `source_fk_to_dest_fk` maps each source id → the destination linked record; it also gives a
    // relation a meaningful core value when it's synced as a plain value rather than resolved as a link.
    return {
      type: TransformerTypes.JSONPath,
      options: { expression: '$.relation[*].id', arrayHandling: 'array' },
    };
  }
  return undefined;
}
