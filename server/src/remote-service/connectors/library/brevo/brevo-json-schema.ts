import { Type, type TSchema } from '@sinclair/typebox';
import { X_SCRATCH_READONLY } from '@spinner/shared-types';
import { BaseJsonTableSpec, EntityId, idPath } from '../../types';
import { BrevoContactAttribute } from './brevo-types';

// ---------------------------------------------------------------------------
// Contacts (dynamic schema — attributes discovered from the API)
// ---------------------------------------------------------------------------

/**
 * Build a BaseJsonTableSpec for the Brevo Contacts table.
 * System fields are always present; custom attributes are added dynamically
 * from the result of `GET /contacts/attributes`.
 */
export function buildBrevoContactsJsonTableSpec(id: EntityId, attributes: BrevoContactAttribute[]): BaseJsonTableSpec {
  const schema = buildContactsSchema(attributes);

  return {
    id,
    slug: id.wsId,
    name: 'Contacts',
    schema,
    idColumnRemoteId: idPath('id'),
    titleColumnRemoteId: ['email'],
    slugFieldPath: 'email',
    basePath: [],
    generatedAt: new Date().toISOString(),
  };
}

function buildContactsSchema(attributes: BrevoContactAttribute[]): TSchema {
  // Build dynamic attribute properties from API-discovered fields.
  // Attribute names from the API are UPPERCASE and must remain so.
  const attributeProperties: Record<string, TSchema> = {};
  for (const attr of attributes) {
    // Skip calculated and global attributes — they are not per-contact editable fields
    if (attr.category === 'calculated' || attr.category === 'global') {
      attributeProperties[attr.name] = attributeTypeToSchema(attr);
      attributeProperties[attr.name][X_SCRATCH_READONLY] = true;
      continue;
    }
    attributeProperties[attr.name] = attributeTypeToSchema(attr);
  }

  return Type.Object(
    {
      id: Type.Number({ description: 'Brevo contact ID', [X_SCRATCH_READONLY]: true }),
      email: Type.String({ description: 'Email address', format: 'email' }),
      emailBlacklisted: Type.Boolean({ description: 'Whether the contact is email-blacklisted' }),
      smsBlacklisted: Type.Boolean({ description: 'Whether the contact is SMS-blacklisted' }),
      listIds: Type.Array(Type.Number(), { description: 'IDs of contact lists the contact belongs to' }),
      listUnsubscribed: Type.Array(Type.Number(), {
        description: 'IDs of contact lists the contact unsubscribed from',
        [X_SCRATCH_READONLY]: true,
      }),
      attributes: Type.Object(attributeProperties, {
        description: 'Contact attributes (custom and default)',
      }),
      createdAt: Type.String({
        description: 'When the contact was created',
        format: 'date-time',
        [X_SCRATCH_READONLY]: true,
      }),
      modifiedAt: Type.String({
        description: 'When the contact was last modified',
        format: 'date-time',
        [X_SCRATCH_READONLY]: true,
      }),
    },
    {
      $id: 'brevo/contacts',
      title: 'Contacts',
    },
  );
}

/**
 * Convert a Brevo contact attribute type to a TypeBox schema.
 */
function attributeTypeToSchema(attr: BrevoContactAttribute): TSchema {
  const description = attr.name;

  switch (attr.type) {
    case 'text':
      return Type.Union([Type.String(), Type.Null()], { description });
    case 'float':
      return Type.Union([Type.Number(), Type.Null()], { description });
    case 'date':
      return Type.Union([Type.String({ format: 'date-time' }), Type.Null()], { description });
    case 'boolean':
      return Type.Union([Type.Boolean(), Type.Null()], { description });
    case 'id':
      return Type.Union([Type.Number(), Type.Null()], { description, [X_SCRATCH_READONLY]: true });
    case 'multiple-choice':
      return Type.Union([Type.String(), Type.Null()], { description });
    default:
      return Type.Unknown({ description });
  }
}

// ---------------------------------------------------------------------------
// Templates (static schema)
// ---------------------------------------------------------------------------

/**
 * Build a BaseJsonTableSpec for the Brevo Email Templates table.
 */
export function buildBrevoTemplatesJsonTableSpec(id: EntityId): BaseJsonTableSpec {
  const schema = buildTemplatesSchema();

  return {
    id,
    slug: id.wsId,
    name: 'Email Templates',
    schema,
    idColumnRemoteId: idPath('id'),
    titleColumnRemoteId: ['name'],
    slugFieldPath: 'name',
    basePath: [],
    generatedAt: new Date().toISOString(),
  };
}

function buildTemplatesSchema(): TSchema {
  return Type.Object(
    {
      id: Type.Number({ description: 'Brevo template ID', [X_SCRATCH_READONLY]: true }),
      name: Type.String({ description: 'Template name' }),
      subject: Type.Union([Type.String(), Type.Null()], { description: 'Email subject line' }),
      htmlContent: Type.Union([Type.String(), Type.Null()], {
        description: 'HTML body content',
        contentMediaType: 'text/html',
      }),
      isActive: Type.Boolean({ description: 'Whether the template is active' }),
      testSent: Type.Boolean({ description: 'Whether a test email has been sent', [X_SCRATCH_READONLY]: true }),
      sender: Type.Object(
        {
          name: Type.Union([Type.String(), Type.Null()], { description: 'Sender display name' }),
          email: Type.Union([Type.String(), Type.Null()], { description: 'Sender email address' }),
          id: Type.Union([Type.String(), Type.Null()], { description: 'Sender ID' }),
        },
        { description: 'Email sender details' },
      ),
      replyTo: Type.Union([Type.String({ format: 'email' }), Type.Null()], { description: 'Reply-to email address' }),
      toField: Type.Union([Type.String(), Type.Null()], { description: 'Personalized to-field value' }),
      tag: Type.Union([Type.String(), Type.Null()], { description: 'Template tag' }),
      createdAt: Type.String({
        description: 'When the template was created',
        format: 'date-time',
        [X_SCRATCH_READONLY]: true,
      }),
      modifiedAt: Type.String({
        description: 'When the template was last modified',
        format: 'date-time',
        [X_SCRATCH_READONLY]: true,
      }),
    },
    {
      $id: 'brevo/templates',
      title: 'Email Templates',
    },
  );
}

// ---------------------------------------------------------------------------
// Mailing Lists (read-only static schema)
// ---------------------------------------------------------------------------

/**
 * Build a BaseJsonTableSpec for the Brevo Mailing Lists table.
 * All fields are read-only since the Brevo API does not support creating or modifying lists.
 */
export function buildBrevoMailingListsJsonTableSpec(id: EntityId): BaseJsonTableSpec {
  const schema = buildMailingListsSchema();

  return {
    id,
    slug: id.wsId,
    name: 'Mailing Lists',
    schema,
    idColumnRemoteId: idPath('id'),
    titleColumnRemoteId: ['name'],
    slugFieldPath: 'name',
    basePath: [],
    generatedAt: new Date().toISOString(),
  };
}

function buildMailingListsSchema(): TSchema {
  return Type.Object(
    {
      id: Type.Number({ description: 'Brevo list ID', [X_SCRATCH_READONLY]: true }),
      name: Type.String({ description: 'List name', [X_SCRATCH_READONLY]: true }),
      totalSubscribers: Type.Number({ description: 'Total number of subscribers', [X_SCRATCH_READONLY]: true }),
      uniqueSubscribers: Type.Number({ description: 'Number of unique subscribers', [X_SCRATCH_READONLY]: true }),
      totalBlacklisted: Type.Number({ description: 'Number of blacklisted contacts', [X_SCRATCH_READONLY]: true }),
      folderId: Type.Number({ description: 'ID of the folder containing this list', [X_SCRATCH_READONLY]: true }),
      dynamicList: Type.Boolean({ description: 'Whether this is a dynamic list', [X_SCRATCH_READONLY]: true }),
      createdAt: Type.String({
        description: 'When the list was created',
        format: 'date-time',
        [X_SCRATCH_READONLY]: true,
      }),
    },
    {
      $id: 'brevo/mailing_lists',
      title: 'Mailing Lists',
    },
  );
}
