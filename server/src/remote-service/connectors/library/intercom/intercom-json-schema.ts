import { TSchema, Type } from '@sinclair/typebox';
import {
  X_SCRATCH_AGENT_INSTRUCTIONS,
  X_SCRATCH_CONNECTOR_DATA_TYPE,
  X_SCRATCH_CUSTOM_FIELD,
  X_SCRATCH_FOREIGN_KEY_OPTIONS,
  X_SCRATCH_LAST_MODIFIED_FIELD,
  X_SCRATCH_READONLY,
} from '@spinner/shared-types';
import { BaseJsonTableSpec, EntityId, dotPath } from '../../types';
import {
  INTERCOM_UNIX_TIMESTAMP_DATA_TYPE,
  IntercomDataAttribute,
  intercomForeignKeyLinkedTableId,
} from './intercom-types';

/**
 * Schema options for a Unix-epoch timestamp Intercom reports as a bare integer. See
 * {@link INTERCOM_UNIX_TIMESTAMP_DATA_TYPE} — the default view turns an annotated field into a real
 * date column instead of a raw number.
 */
function unixTimestampOptions(description: string): Record<string, unknown> {
  return {
    description,
    [X_SCRATCH_READONLY]: true,
    [X_SCRATCH_CONNECTOR_DATA_TYPE]: INTERCOM_UNIX_TIMESTAMP_DATA_TYPE,
  };
}

/**
 * The foreign-key annotation for a `parent_id` that names a Help Center collection.
 *
 * Both link fields are single-valued: an article has at most one parent, and so does a collection.
 * Article `parent_id` is a NUMBER while a collection's own `id` is a STRING — mirrored verbatim
 * from the API, and harmless because foreign-key resolution compares by string.
 *
 * Articles carry one caveat: `parent_type` may be `'section'` rather than `'collection'`, and
 * sections are not a table this connector syncs. A section-parented article's `parent_id` therefore
 * names no record in the Collections folder, which the shared FK step reports as an unresolved link
 * — it warns, leaves that one link empty, and syncs the rest of the record (the DEV-11222 default).
 * That is strictly better than the alternative of publishing the raw id into a number column, where
 * it is a relation nobody can follow (DEV-11285).
 */
const PARENT_COLLECTION_FOREIGN_KEY = {
  linkedTableId: intercomForeignKeyLinkedTableId('collections'),
  linkedTableRemoteId: ['collections'],
  isSingleValued: true,
} as const;

/**
 * The foreign-key annotation on a contact's `companies.data[].id` — multi-valued (a contact can belong
 * to many companies), so `isSingleValued` is omitted. It sits on the id LEAF, per the connector guide;
 * the default view also declares it on the `companies.data` column, because neither the schema
 * flattener nor scratch-git's index looks inside array items.
 */
export const CONTACT_COMPANIES_FOREIGN_KEY = {
  linkedTableId: intercomForeignKeyLinkedTableId('companies'),
  linkedTableRemoteId: ['companies'],
};

// ---------------------------------------------------------------------------
// Articles (static schema)
// ---------------------------------------------------------------------------

/**
 * Build a BaseJsonTableSpec for the Intercom Articles table.
 */
export function buildIntercomArticlesJsonTableSpec(id: EntityId): BaseJsonTableSpec {
  const schema = Type.Object(
    {
      id: Type.String({ description: 'Article ID', [X_SCRATCH_READONLY]: true }),
      workspace_id: Type.String({ description: 'Workspace ID', [X_SCRATCH_READONLY]: true }),
      title: Type.String({ description: 'Article title' }),
      description: Type.Union([Type.String(), Type.Null()], { description: 'Article description' }),
      body: Type.Union([Type.String(), Type.Null()], {
        description: 'Article body (HTML)',
        contentMediaType: 'text/html',
      }),
      author_id: Type.Number({ description: 'Author admin ID (must be a valid teammate)' }),
      state: Type.Union([Type.Literal('published'), Type.Literal('draft')], {
        description: 'Article state',
      }),
      url: Type.Union([Type.String(), Type.Null()], {
        description: 'Public URL',
        [X_SCRATCH_READONLY]: true,
      }),
      parent_id: Type.Union([Type.Number(), Type.Null()], {
        description: 'Parent collection or section ID',
        [X_SCRATCH_FOREIGN_KEY_OPTIONS]: PARENT_COLLECTION_FOREIGN_KEY,
      }),
      parent_ids: Type.Array(Type.Number(), {
        description: 'All parent collection/section IDs',
        [X_SCRATCH_READONLY]: true,
      }),
      parent_type: Type.Union([Type.String(), Type.Null()], {
        description: 'Parent type (collection or section)',
      }),
      // The three fields below are OPTIONAL because `GET /articles` — the list endpoint the pull
      // walks — omits them entirely, while `GET /articles/{id}` returns them (DEV-11286). Declaring
      // them required made every pulled file fail its own schema. `statistics` additionally has
      // three observed shapes for one article (absent from an older list row, `null` on a freshly
      // created one, populated by-id), so it is optional AND nullable.
      default_locale: Type.Optional(Type.String({ description: 'Default locale', [X_SCRATCH_READONLY]: true })),
      translated_content: Type.Optional(
        Type.Union([Type.Record(Type.String(), Type.Unknown()), Type.Null()], {
          description: 'Translated content by locale',
        }),
      ),
      statistics: Type.Optional(
        Type.Union(
          [
            Type.Object(
              {
                type: Type.String({ [X_SCRATCH_READONLY]: true }),
                views: Type.Number({ [X_SCRATCH_READONLY]: true }),
                conversations: Type.Number({ [X_SCRATCH_READONLY]: true }),
                reactions: Type.Number({ [X_SCRATCH_READONLY]: true }),
                happy_reaction_percentage: Type.Number({ [X_SCRATCH_READONLY]: true }),
                neutral_reaction_percentage: Type.Number({ [X_SCRATCH_READONLY]: true }),
                sad_reaction_percentage: Type.Number({ [X_SCRATCH_READONLY]: true }),
              },
              { [X_SCRATCH_READONLY]: true },
            ),
            Type.Null(),
          ],
          { description: 'Article statistics', [X_SCRATCH_READONLY]: true },
        ),
      ),
      created_at: Type.Number(unixTimestampOptions('Creation timestamp (Unix)')),
      updated_at: Type.Number(unixTimestampOptions('Last updated timestamp (Unix)')),
    },
    {
      $id: 'intercom/articles',
      title: 'Articles',
    },
  );

  return {
    id,
    slug: id.wsId,
    name: 'Articles',
    schema,
    idPath: dotPath('id'),
    titlePath: dotPath('title'),
    mainContentPath: dotPath('body'),
    slugPath: dotPath('title'),
    basePath: [],
    generatedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Collections (static schema)
// ---------------------------------------------------------------------------

/**
 * Build a BaseJsonTableSpec for the Intercom Collections table.
 */
export function buildIntercomCollectionsJsonTableSpec(id: EntityId): BaseJsonTableSpec {
  const schema = Type.Object(
    {
      id: Type.String({ description: 'Collection ID', [X_SCRATCH_READONLY]: true }),
      workspace_id: Type.String({ description: 'Workspace ID', [X_SCRATCH_READONLY]: true }),
      name: Type.String({ description: 'Collection name' }),
      description: Type.Union([Type.String(), Type.Null()], { description: 'Collection description' }),
      icon: Type.Union([Type.String(), Type.Null()], { description: 'Icon identifier' }),
      order: Type.Number({ description: 'Sort order', [X_SCRATCH_READONLY]: true }),
      url: Type.Union([Type.String(), Type.Null()], {
        description: 'Public URL',
        [X_SCRATCH_READONLY]: true,
      }),
      default_locale: Type.String({ description: 'Default locale', [X_SCRATCH_READONLY]: true }),
      translated_content: Type.Union([Type.Record(Type.String(), Type.Unknown()), Type.Null()], {
        description: 'Translated content by locale',
      }),
      parent_id: Type.Union([Type.String(), Type.Null()], {
        description: 'Parent collection ID (null for top-level)',
        [X_SCRATCH_FOREIGN_KEY_OPTIONS]: PARENT_COLLECTION_FOREIGN_KEY,
      }),
      help_center_id: Type.Union([Type.Number(), Type.Null()], {
        description: 'Help Center ID',
      }),
      created_at: Type.Number(unixTimestampOptions('Creation timestamp (Unix)')),
      updated_at: Type.Number(unixTimestampOptions('Last updated timestamp (Unix)')),
    },
    {
      $id: 'intercom/collections',
      title: 'Collections',
    },
  );

  return {
    id,
    slug: id.wsId,
    name: 'Collections',
    schema,
    idPath: dotPath('id'),
    titlePath: dotPath('name'),
    slugPath: dotPath('name'),
    basePath: [],
    generatedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Conversations (read-only static schema)
// ---------------------------------------------------------------------------

const authorSchema = Type.Object(
  {
    type: Type.String({
      description: 'Author type',
      [X_SCRATCH_READONLY]: true,
      [X_SCRATCH_AGENT_INSTRUCTIONS]:
        'Author `type` is one of "user", "admin", or "bot". "user" and "admin" represent human participants and are almost always what matters; "bot" entries come from automated flows and are usually safe to skip when summarizing a conversation or picking a representative message.',
    }),
    id: Type.String({ description: 'Author ID', [X_SCRATCH_READONLY]: true }),
    name: Type.Union([Type.String(), Type.Null()], { description: 'Author name', [X_SCRATCH_READONLY]: true }),
    email: Type.Union([Type.String(), Type.Null()], { description: 'Author email', [X_SCRATCH_READONLY]: true }),
  },
  {
    [X_SCRATCH_READONLY]: true,
  },
);

const conversationPartSchema = Type.Object(
  {
    type: Type.String({ [X_SCRATCH_READONLY]: true }),
    id: Type.String({ [X_SCRATCH_READONLY]: true }),
    part_type: Type.String({ description: 'Part type (comment, note, etc.)', [X_SCRATCH_READONLY]: true }),
    body: Type.Union([Type.String(), Type.Null()], {
      description: 'Part body (HTML)',
      contentMediaType: 'text/html',
      [X_SCRATCH_READONLY]: true,
      [X_SCRATCH_AGENT_INSTRUCTIONS]: 'HTML does not have a consistent root element',
    }),
    created_at: Type.Number(unixTimestampOptions('Part creation timestamp (Unix)')),
    updated_at: Type.Number(unixTimestampOptions('Part update timestamp (Unix)')),
    author: authorSchema,
  },
  {
    [X_SCRATCH_READONLY]: true,
    [X_SCRATCH_AGENT_INSTRUCTIONS]:
      'Conversation parts represent many event types that may not be user-facing (assignment changes, tag updates, notes, replies, etc.). Use the `part_type` to determine if the part is user-facing and relevant to the task',
  },
);

/**
 * Build a BaseJsonTableSpec for the Intercom Conversations table.
 * All fields are read-only.
 */
export function buildIntercomConversationsJsonTableSpec(id: EntityId): BaseJsonTableSpec {
  const schema = Type.Object(
    {
      id: Type.String({ description: 'Conversation ID', [X_SCRATCH_READONLY]: true }),
      title: Type.Union([Type.String(), Type.Null()], {
        description: 'Conversation title',
        [X_SCRATCH_READONLY]: true,
      }),
      state: Type.String({ description: 'State (open, closed, snoozed)', [X_SCRATCH_READONLY]: true }),
      open: Type.Boolean({ description: 'Whether the conversation is open', [X_SCRATCH_READONLY]: true }),
      read: Type.Boolean({ description: 'Whether the conversation has been read', [X_SCRATCH_READONLY]: true }),
      priority: Type.String({ description: 'Priority level', [X_SCRATCH_READONLY]: true }),
      admin_assignee_id: Type.Union([Type.Number(), Type.Null()], {
        description: 'Assigned admin ID',
        [X_SCRATCH_READONLY]: true,
      }),
      team_assignee_id: Type.Union([Type.String(), Type.Null()], {
        description: 'Assigned team ID',
        [X_SCRATCH_READONLY]: true,
      }),
      waiting_since: Type.Union(
        [Type.Number(), Type.Null()],
        unixTimestampOptions('Timestamp since waiting for admin reply'),
      ),
      snoozed_until: Type.Union(
        [Type.Number(), Type.Null()],
        unixTimestampOptions('Timestamp when snoozed conversation reopens'),
      ),
      // NULLABLE: the API returns `source: null` on real conversations, from both the list and the
      // by-id endpoint. Declared as a bare object it made every such record fail its own schema, and
      // the object→text downgrade turned the null into an empty string at every destination
      // (DEV-11286).
      source: Type.Union(
        [
          Type.Object(
            {
              type: Type.String({ [X_SCRATCH_READONLY]: true }),
              id: Type.String({ [X_SCRATCH_READONLY]: true }),
              delivered_as: Type.String({ description: 'Delivery method', [X_SCRATCH_READONLY]: true }),
              subject: Type.String({ description: 'Subject line', [X_SCRATCH_READONLY]: true }),
              body: Type.String({
                description: 'Source message body (HTML)',
                contentMediaType: 'text/html',
                [X_SCRATCH_READONLY]: true,
              }),
              author: authorSchema,
              url: Type.Union([Type.String(), Type.Null()], { [X_SCRATCH_READONLY]: true }),
              redacted: Type.Boolean({ [X_SCRATCH_READONLY]: true }),
            },
            { [X_SCRATCH_READONLY]: true },
          ),
          Type.Null(),
        ],
        { description: 'The initiating message', [X_SCRATCH_READONLY]: true },
      ),
      contacts: Type.Object(
        {
          type: Type.String({ [X_SCRATCH_READONLY]: true }),
          contacts: Type.Array(
            Type.Object({
              type: Type.String({ [X_SCRATCH_READONLY]: true }),
              id: Type.String({ [X_SCRATCH_READONLY]: true }),
            }),
            { [X_SCRATCH_READONLY]: true },
          ),
        },
        { description: 'Contacts involved', [X_SCRATCH_READONLY]: true },
      ),
      tags: Type.Object(
        {
          type: Type.String({ [X_SCRATCH_READONLY]: true }),
          tags: Type.Array(
            Type.Object({
              type: Type.String({ [X_SCRATCH_READONLY]: true }),
              id: Type.String({ [X_SCRATCH_READONLY]: true }),
              name: Type.String({ [X_SCRATCH_READONLY]: true }),
            }),
            { [X_SCRATCH_READONLY]: true },
          ),
        },
        { description: 'Associated tags', [X_SCRATCH_READONLY]: true },
      ),
      custom_attributes: Type.Record(Type.String(), Type.Unknown(), {
        description: 'Custom attributes',
        [X_SCRATCH_READONLY]: true,
      }),
      conversation_rating: Type.Union([Type.Record(Type.String(), Type.Unknown()), Type.Null()], {
        description: 'Conversation rating',
        [X_SCRATCH_READONLY]: true,
      }),
      statistics: Type.Union([Type.Record(Type.String(), Type.Unknown()), Type.Null()], {
        description: 'Conversation statistics',
        [X_SCRATCH_READONLY]: true,
      }),
      conversation_parts: Type.Object(
        {
          type: Type.String({ [X_SCRATCH_READONLY]: true }),
          conversation_parts: Type.Array(conversationPartSchema, { [X_SCRATCH_READONLY]: true }),
          total_count: Type.Number({ [X_SCRATCH_READONLY]: true }),
        },
        { description: 'Threaded replies, notes, and events', [X_SCRATCH_READONLY]: true },
      ),
      created_at: Type.Number(unixTimestampOptions('Creation timestamp (Unix)')),
      // Annotated as the last-modified field so the UI's last-modified-field
      // picker surfaces it. The connector hardcodes `updated_at` and gates
      // incremental on the conversations table (Notion/Linear-style "hardcoded
      // field, annotated for UI"). Articles/Collections are deliberately not
      // annotated — they have no server-side incremental path.
      updated_at: Type.Number({
        ...unixTimestampOptions('Last updated timestamp (Unix)'),
        [X_SCRATCH_LAST_MODIFIED_FIELD]: true,
      }),
    },
    {
      $id: 'intercom/conversations',
      title: 'Conversations',
    },
  );

  return {
    id,
    slug: id.wsId,
    name: 'Conversations',
    schema,
    idPath: dotPath('id'),
    titlePath: dotPath('title'),
    slugPath: dotPath('source.subject'),
    basePath: [],
    generatedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Contacts (read-only; custom attributes discovered from GET /data_attributes)
// ---------------------------------------------------------------------------

function readonlyNullableString(description: string): TSchema {
  return Type.Union([Type.String(), Type.Null()], { description, [X_SCRATCH_READONLY]: true });
}

function readonlyNullableUnixTimestamp(description: string): TSchema {
  return Type.Union([Type.Number(), Type.Null()], unixTimestampOptions(description));
}

/**
 * One of a contact's nested lists (`tags`, `notes`, `companies`, subscription types). Intercom
 * inlines at most 10 items and links the full list at `url`; `has_more`/`total_count` say whether
 * the inlined page is complete. Items are stubs — a contact's tag items carry no `name` (probed live).
 */
function contactNestedListSchema(
  description: string,
  itemIdForeignKey?: { linkedTableId: string; linkedTableRemoteId: string[] },
): TSchema {
  return Type.Object(
    {
      type: Type.String({ [X_SCRATCH_READONLY]: true }),
      data: Type.Array(
        Type.Object({
          type: Type.String({ [X_SCRATCH_READONLY]: true }),
          id: Type.String({
            [X_SCRATCH_READONLY]: true,
            ...(itemIdForeignKey ? { [X_SCRATCH_FOREIGN_KEY_OPTIONS]: itemIdForeignKey } : {}),
          }),
          url: Type.Optional(Type.Union([Type.String(), Type.Null()], { [X_SCRATCH_READONLY]: true })),
        }),
        { [X_SCRATCH_READONLY]: true },
      ),
      url: Type.String({ [X_SCRATCH_READONLY]: true }),
      total_count: Type.Number({ [X_SCRATCH_READONLY]: true }),
      has_more: Type.Boolean({ [X_SCRATCH_READONLY]: true }),
    },
    { description, [X_SCRATCH_READONLY]: true },
  );
}

/**
 * The schema for one custom attribute's value, or undefined when the attribute is one we don't
 * declare. Every value is nullable (Intercom reports unset attributes as `null`) and the property is
 * optional (an attribute a record never had set can be absent from it entirely — probed live). `date` values are Unix epoch SECONDS (probed live), so they carry the same annotation as
 * the built-in timestamps and export as datetimes.
 *
 * A string attribute with `options` becomes a closed set of literals. On API 2.11 `GET
 * /data_attributes` did not return `options` even for an attribute created with them (probed on a
 * test workspace), so in practice such attributes arrive as open strings; the branch is kept for a
 * definition that does carry them.
 *
 * Not declared:
 *  - `relationship` (undocumented): returned by `GET /data_attributes` but never present in a
 *    record's `custom_attributes` (probed live) — a column for it would always be empty.
 *  - Any other unrecognized `data_type` — the value still round-trips verbatim under the open
 *    `custom_attributes` object; it just gets no typed column.
 *  - A name containing `.` — a view path is dot-separated, so `custom_attributes.a.b` would read the
 *    wrong key. Intercom's own `full_name` uses `.` as its separator, so this shouldn't occur.
 */
export function buildIntercomCustomAttributeSchema(definition: IntercomDataAttribute): TSchema | undefined {
  if (definition.name.includes('.')) return undefined;
  const description = definition.description || definition.label || definition.name;
  const annotations = { description, [X_SCRATCH_READONLY]: true, [X_SCRATCH_CUSTOM_FIELD]: true };

  switch (definition.data_type) {
    case 'string': {
      const options = (definition.options ?? []).filter((option) => typeof option === 'string');
      const valueArms: TSchema[] = options.length > 0 ? options.map((option) => Type.Literal(option)) : [Type.String()];
      return Type.Optional(Type.Union([...valueArms, Type.Null()], annotations));
    }
    case 'integer':
    case 'float':
      return Type.Optional(Type.Union([Type.Number(), Type.Null()], annotations));
    case 'boolean':
      return Type.Optional(Type.Union([Type.Boolean(), Type.Null()], annotations));
    case 'date':
      return Type.Optional(
        Type.Union([Type.Number(), Type.Null()], {
          ...annotations,
          [X_SCRATCH_CONNECTOR_DATA_TYPE]: INTERCOM_UNIX_TIMESTAMP_DATA_TYPE,
        }),
      );
    default:
      return undefined;
  }
}

/**
 * The typed `custom_attributes` properties for a model, from its attribute definitions: one per
 * non-archived CUSTOM attribute that {@link buildIntercomCustomAttributeSchema} declares, keyed by the
 * attribute's `name` — the key its value is stored under on the record. Model-agnostic (contacts and
 * companies share Intercom's attribute model).
 */
export function buildIntercomCustomAttributeProperties(definitions: IntercomDataAttribute[]): Record<string, TSchema> {
  const customAttributeProperties: Record<string, TSchema> = {};
  for (const definition of definitions) {
    if (!definition.custom || definition.archived) continue;
    const attributeSchema = buildIntercomCustomAttributeSchema(definition);
    if (attributeSchema) {
      customAttributeProperties[definition.name] = attributeSchema;
    }
  }
  return customAttributeProperties;
}

/**
 * Build a BaseJsonTableSpec for the read-only Intercom Contacts table (users and leads).
 *
 * The record is stored verbatim; this schema describes it. Every top-level field is read-only EXCEPT
 * that the `custom_attributes` container carries no `x-scratch-*` key at all: the schema flattener
 * treats an object carrying one as a single opaque value, which would hide every discovered
 * attribute's type and options from Live Export plans. Its leaves are read-only instead.
 *
 * The long tail of device/marketing fields (`android_*`, `ios_*`, `utm_*`, `browser*`, `sms_*`, …)
 * is optional: they are present on every live record observed, but Intercom adds and drops such
 * fields by product and API version, and a field declared required that a list payload omits makes
 * every record fail its own schema (the DEV-11286 lesson).
 *
 * `custom_attributes` is built from the workspace's own attribute definitions so each attribute is a
 * real, typed column; it stays open so an attribute created after this spec was built still
 * round-trips.
 */
export function buildIntercomContactsJsonTableSpec(
  id: EntityId,
  contactAttributeDefinitions: IntercomDataAttribute[],
): BaseJsonTableSpec {
  const customAttributeProperties = buildIntercomCustomAttributeProperties(contactAttributeDefinitions);

  const schema = Type.Object(
    {
      type: Type.String({ description: 'Object type (always "contact")', [X_SCRATCH_READONLY]: true }),
      id: Type.String({ description: 'Contact ID', [X_SCRATCH_READONLY]: true }),
      workspace_id: Type.String({ description: 'Workspace ID', [X_SCRATCH_READONLY]: true }),
      external_id: readonlyNullableString('Your own unique identifier for the contact'),
      role: Type.Union([Type.Literal('user'), Type.Literal('lead')], {
        description: 'Contact role: a signed-up user, or a lead',
        [X_SCRATCH_READONLY]: true,
      }),
      email: readonlyNullableString('Email address'),
      phone: readonlyNullableString('Phone number'),
      name: readonlyNullableString('Name'),
      owner_id: Type.Union([Type.Number(), Type.Null()], {
        description: 'ID of the admin who owns the contact',
        [X_SCRATCH_READONLY]: true,
      }),
      has_hard_bounced: Type.Boolean({
        description: 'Whether email to the contact has hard bounced',
        [X_SCRATCH_READONLY]: true,
      }),
      marked_email_as_spam: Type.Boolean({
        description: 'Whether the contact marked email as spam',
        [X_SCRATCH_READONLY]: true,
      }),
      unsubscribed_from_emails: Type.Boolean({
        description: 'Whether the contact is unsubscribed from emails',
        [X_SCRATCH_READONLY]: true,
      }),
      created_at: Type.Number(unixTimestampOptions('Creation timestamp (Unix)')),
      updated_at: Type.Number(unixTimestampOptions('Last updated timestamp (Unix)')),
      signed_up_at: readonlyNullableUnixTimestamp('Sign-up timestamp (Unix)'),
      last_seen_at: readonlyNullableUnixTimestamp('Last seen timestamp (Unix)'),
      last_replied_at: readonlyNullableUnixTimestamp('Last reply timestamp (Unix)'),
      last_contacted_at: readonlyNullableUnixTimestamp('Last contacted timestamp (Unix)'),
      last_email_opened_at: readonlyNullableUnixTimestamp('Last email opened timestamp (Unix)'),
      last_email_clicked_at: readonlyNullableUnixTimestamp('Last email clicked timestamp (Unix)'),
      location: Type.Object(
        {
          type: Type.Optional(readonlyNullableString('Object type')),
          country: readonlyNullableString('Country'),
          region: readonlyNullableString('Region'),
          city: readonlyNullableString('City'),
          country_code: Type.Optional(readonlyNullableString('Country code')),
          continent_code: Type.Optional(readonlyNullableString('Continent code')),
        },
        { description: 'Location', [X_SCRATCH_READONLY]: true },
      ),
      custom_attributes: Type.Object(customAttributeProperties, {
        description: 'Custom attributes',
        additionalProperties: true,
      }),
      tags: contactNestedListSchema('Tags (stub references; at most 10 inlined)'),
      notes: contactNestedListSchema('Notes (stub references; at most 10 inlined)'),
      companies: contactNestedListSchema(
        'Companies (stub references; at most 10 inlined)',
        CONTACT_COMPANIES_FOREIGN_KEY,
      ),
      opted_in_subscription_types: Type.Optional(contactNestedListSchema('Subscription types the contact opted in to')),
      opted_out_subscription_types: Type.Optional(
        contactNestedListSchema('Subscription types the contact opted out of'),
      ),
      social_profiles: Type.Optional(
        Type.Object(
          {
            type: Type.String({ [X_SCRATCH_READONLY]: true }),
            data: Type.Array(Type.Record(Type.String(), Type.Unknown()), { [X_SCRATCH_READONLY]: true }),
          },
          { description: 'Social profiles', [X_SCRATCH_READONLY]: true },
        ),
      ),
      avatar: Type.Optional(
        Type.Union([Type.Record(Type.String(), Type.Unknown()), Type.String(), Type.Null()], {
          description: 'Avatar',
          [X_SCRATCH_READONLY]: true,
        }),
      ),
      language_override: Type.Optional(readonlyNullableString('Language override')),
      browser: Type.Optional(readonlyNullableString('Browser')),
      browser_version: Type.Optional(readonlyNullableString('Browser version')),
      browser_language: Type.Optional(readonlyNullableString('Browser language')),
      os: Type.Optional(readonlyNullableString('Operating system')),
      android_app_name: Type.Optional(readonlyNullableString('Android app name')),
      android_app_version: Type.Optional(readonlyNullableString('Android app version')),
      android_device: Type.Optional(readonlyNullableString('Android device')),
      android_os_version: Type.Optional(readonlyNullableString('Android OS version')),
      android_sdk_version: Type.Optional(readonlyNullableString('Android SDK version')),
      android_last_seen_at: Type.Optional(readonlyNullableUnixTimestamp('Android app last seen timestamp (Unix)')),
      ios_app_name: Type.Optional(readonlyNullableString('iOS app name')),
      ios_app_version: Type.Optional(readonlyNullableString('iOS app version')),
      ios_device: Type.Optional(readonlyNullableString('iOS device')),
      ios_os_version: Type.Optional(readonlyNullableString('iOS version')),
      ios_sdk_version: Type.Optional(readonlyNullableString('iOS SDK version')),
      ios_last_seen_at: Type.Optional(readonlyNullableUnixTimestamp('iOS app last seen timestamp (Unix)')),
      utm_campaign: Type.Optional(readonlyNullableString('UTM campaign')),
      utm_content: Type.Optional(readonlyNullableString('UTM content')),
      utm_medium: Type.Optional(readonlyNullableString('UTM medium')),
      utm_source: Type.Optional(readonlyNullableString('UTM source')),
      utm_term: Type.Optional(readonlyNullableString('UTM term')),
      referrer: Type.Optional(readonlyNullableString('Referring URL')),
      sms_consent: Type.Optional(
        Type.Boolean({ description: 'Whether the contact consented to SMS', [X_SCRATCH_READONLY]: true }),
      ),
      unsubscribed_from_sms: Type.Optional(
        Type.Boolean({ description: 'Whether the contact is unsubscribed from SMS', [X_SCRATCH_READONLY]: true }),
      ),
    },
    {
      $id: 'intercom/contacts',
      title: 'Contacts',
    },
  );

  return {
    id,
    slug: id.wsId,
    name: 'Contacts',
    schema,
    idPath: dotPath('id'),
    // `name` is null on ~8.5% of contacts (most leads) while `email` is almost always set (probed
    // live), and the title becomes the Airtable primary field in a Live Export.
    titlePath: dotPath('email'),
    slugPath: dotPath('email'),
    basePath: [],
    generatedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Companies (read-only; custom attributes discovered from GET /data_attributes)
// ---------------------------------------------------------------------------

/**
 * Build a BaseJsonTableSpec for the read-only Intercom Companies table — the companies Intercom will
 * list, i.e. those with at least one contact (no 2.11 endpoint lists the rest; probed live).
 *
 * Mirrors the payload `GET /companies/scroll` returns (probed live on a seeded workspace):
 *  - `remote_created_at`, `size`, `website`, `industry` appear only once set, so they are optional;
 *    `last_request_at` is documented but was never observed, so it is optional too.
 *  - `plan` is `{}` when the company has none — never null — so its keys are optional.
 *  - `tags` carries tag NAMES (`{type: 'tag.list', tags: [{type, id, name}]}`), unlike a contact's.
 *  - `segments` items couldn't be observed (segments can't be created through the API), so they
 *    are declared open.
 *
 * As on Contacts, every top-level field is read-only except the `custom_attributes` container, which
 * carries no `x-scratch-*` key so the schema flattener expands its discovered, typed leaves. That
 * includes Intercom's own `creation_source` attribute.
 */
export function buildIntercomCompaniesJsonTableSpec(
  id: EntityId,
  companyAttributeDefinitions: IntercomDataAttribute[],
): BaseJsonTableSpec {
  const schema = Type.Object(
    {
      type: Type.String({ description: 'Object type (always "company")', [X_SCRATCH_READONLY]: true }),
      id: Type.String({ description: 'Intercom company ID', [X_SCRATCH_READONLY]: true }),
      company_id: readonlyNullableString('Your own unique identifier for the company'),
      app_id: Type.String({ description: 'Intercom workspace (app) ID', [X_SCRATCH_READONLY]: true }),
      name: readonlyNullableString('Company name'),
      website: Type.Optional(readonlyNullableString('Website')),
      industry: Type.Optional(readonlyNullableString('Industry')),
      size: Type.Optional(
        Type.Union([Type.Number(), Type.Null()], { description: 'Number of employees', [X_SCRATCH_READONLY]: true }),
      ),
      plan: Type.Object(
        {
          type: Type.Optional(Type.String({ [X_SCRATCH_READONLY]: true })),
          id: Type.Optional(Type.String({ [X_SCRATCH_READONLY]: true })),
          name: Type.Optional(Type.String({ description: 'Plan name', [X_SCRATCH_READONLY]: true })),
        },
        { description: 'Plan (an empty object when the company has none)', [X_SCRATCH_READONLY]: true },
      ),
      monthly_spend: Type.Number({ description: 'Monthly spend', [X_SCRATCH_READONLY]: true }),
      session_count: Type.Number({ description: 'Sessions across the company’s contacts', [X_SCRATCH_READONLY]: true }),
      user_count: Type.Number({ description: 'Number of contacts in the company', [X_SCRATCH_READONLY]: true }),
      created_at: Type.Number(unixTimestampOptions('Creation timestamp in Intercom (Unix)')),
      updated_at: Type.Number(unixTimestampOptions('Last updated timestamp (Unix)')),
      remote_created_at: Type.Optional(readonlyNullableUnixTimestamp('Creation timestamp in your system (Unix)')),
      last_request_at: Type.Optional(readonlyNullableUnixTimestamp('Last request timestamp (Unix)')),
      tags: Type.Object(
        {
          type: Type.String({ [X_SCRATCH_READONLY]: true }),
          tags: Type.Array(
            Type.Object({
              type: Type.String({ [X_SCRATCH_READONLY]: true }),
              id: Type.String({ [X_SCRATCH_READONLY]: true }),
              name: Type.String({ [X_SCRATCH_READONLY]: true }),
            }),
            { [X_SCRATCH_READONLY]: true },
          ),
        },
        { description: 'Tags', [X_SCRATCH_READONLY]: true },
      ),
      segments: Type.Object(
        {
          type: Type.String({ [X_SCRATCH_READONLY]: true }),
          segments: Type.Array(Type.Record(Type.String(), Type.Unknown()), { [X_SCRATCH_READONLY]: true }),
        },
        { description: 'Segments', [X_SCRATCH_READONLY]: true },
      ),
      custom_attributes: Type.Object(buildIntercomCustomAttributeProperties(companyAttributeDefinitions), {
        description: 'Custom attributes',
        additionalProperties: true,
      }),
    },
    {
      $id: 'intercom/companies',
      title: 'Companies',
    },
  );

  return {
    id,
    slug: id.wsId,
    name: 'Companies',
    schema,
    idPath: dotPath('id'),
    titlePath: dotPath('name'),
    slugPath: dotPath('name'),
    basePath: [],
    generatedAt: new Date().toISOString(),
  };
}
