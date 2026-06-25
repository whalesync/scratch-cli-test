import { Type, type TSchema } from '@sinclair/typebox';
import { X_SCRATCH_READONLY } from '@spinner/shared-types';
import { BaseJsonTableSpec, EntityId, dotPath } from '../../types';

/**
 * Build a BaseJsonTableSpec for the Memberstack Members table.
 * Generates a JSON Schema describing the raw Memberstack member API response format.
 *
 * `customFieldKeys` are the custom-field keys discovered by sampling members
 * (see `MemberstackApiClient.fetchSampleCustomFieldKeys`). Each becomes its own
 * editable string column; pass `[]` to leave `customFields` as an open record.
 */
export function buildMemberstackJsonTableSpec(id: EntityId, customFieldKeys: string[] = []): BaseJsonTableSpec {
  const schema = buildMembersSchema(customFieldKeys);

  return {
    id,
    slug: id.wsId,
    name: 'Members',
    schema,
    idPath: dotPath('id'),
    titlePath: dotPath('auth.email'),
    slugPath: dotPath('auth.email'),
    basePath: [],
    generatedAt: new Date().toISOString(),
  };
}

/**
 * A custom-field key is path-safe when it can serve as a dot-delimited column path
 * segment. The frontends address fields by dot-paths (`customFields.<key>`) and have
 * no way to escape a literal `.`, so a key containing `.` would be parsed as a nested
 * object boundary — reading/writing the wrong location and silently corrupting data on
 * save. `.` is the only character that breaks the path engine.
 */
export function isPathSafeCustomFieldKey(key: string): boolean {
  return !key.includes('.');
}

/**
 * Build the schema for the `customFields` object.
 *
 * Memberstack returns custom fields as a flat `{ key: value }` object of strings. When
 * every discovered key is path-safe, we expand each into its own string property so the
 * frontends render it as a separate, individually-editable column instead of one JSON
 * blob — keeping the object open (`additionalProperties: string`) so a custom field
 * added after the last schema refresh still validates and round-trips.
 *
 * If there are no keys to expand, or ANY key contains a `.` (which would collide with
 * the dot-path column engine), we fall back to a single open object — the prior
 * single-JSON-field behavior — so the dotted field stays visible and editable as part
 * of the blob rather than silently vanishing from the grid. (An object with an *empty*
 * `properties` map would expand to zero columns and hide `customFields` entirely, so
 * the fallback deliberately uses a `properties`-less record.)
 *
 * The record data itself is never reshaped; this only describes the keys we've seen.
 */
function buildCustomFieldsSchema(customFieldKeys: string[]): TSchema {
  const canExpandIntoColumns =
    customFieldKeys.length > 0 && customFieldKeys.every((key) => isPathSafeCustomFieldKey(key));

  if (!canExpandIntoColumns) {
    return Type.Record(Type.String(), Type.String(), {
      description: 'Custom fields defined in Memberstack',
    });
  }

  const properties: Record<string, TSchema> = {};
  for (const key of customFieldKeys) {
    properties[key] = Type.Optional(Type.String());
  }
  return Type.Object(properties, {
    description: 'Custom fields defined in Memberstack',
    additionalProperties: Type.String(),
  });
}

/**
 * Build the TypeBox schema for a member record.
 * Matches the raw Memberstack API response shape.
 */
function buildMembersSchema(customFieldKeys: string[]): TSchema {
  return Type.Object(
    {
      id: Type.String({ description: 'Unique member ID (mem_*)', [X_SCRATCH_READONLY]: true }),
      auth: Type.Object(
        {
          email: Type.String({ description: 'Member email address', format: 'email' }),
        },
        { description: 'Authentication details' },
      ),
      customFields: buildCustomFieldsSchema(customFieldKeys),
      metaData: Type.Record(Type.String(), Type.Unknown(), {
        description: 'Arbitrary metadata JSON',
      }),
      json: Type.Record(Type.String(), Type.Unknown(), {
        description: 'Custom JSON data storage',
      }),
      planConnections: Type.Array(
        Type.Object(
          {
            id: Type.String({ description: 'Plan connection ID' }),
            active: Type.Boolean({ description: 'Whether the plan is currently active' }),
            status: Type.Optional(Type.String({ description: 'Plan connection status' })),
            planId: Type.String({ description: 'Plan ID (pln_*)' }),
            planName: Type.Optional(Type.String({ description: 'Plan display name' })),
            type: Type.String({ description: 'Plan type' }),
            payment: Type.Optional(Type.Union([Type.String(), Type.Null()], { description: 'Payment info' })),
          },
          { additionalProperties: true },
        ),
        { description: 'Connected plans for this member', [X_SCRATCH_READONLY]: true },
      ),
      loginRedirect: Type.String({ description: 'URL to redirect after login' }),
      permissions: Type.Array(Type.String(), {
        description: 'Permissions granted to this member',
        [X_SCRATCH_READONLY]: true,
      }),
      verified: Type.Optional(Type.Boolean({ description: 'Whether email is verified', [X_SCRATCH_READONLY]: true })),
      createdAt: Type.String({
        description: 'When the member was created',
        format: 'date-time',
        [X_SCRATCH_READONLY]: true,
      }),
      lastLogin: Type.Optional(
        Type.String({
          description: 'When the member last logged in',
          format: 'date-time',
          [X_SCRATCH_READONLY]: true,
        }),
      ),
    },
    {
      $id: 'memberstack/members',
      title: 'Members',
    },
  );
}
