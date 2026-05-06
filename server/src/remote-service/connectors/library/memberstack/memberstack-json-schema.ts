import { Type, type TSchema } from '@sinclair/typebox';
import { X_SCRATCH_READONLY } from '@spinner/shared-types';
import { BaseJsonTableSpec, EntityId, idPath } from '../../types';

/**
 * Build a BaseJsonTableSpec for the Memberstack Members table.
 * Generates a JSON Schema describing the raw Memberstack member API response format.
 */
export function buildMemberstackJsonTableSpec(id: EntityId): BaseJsonTableSpec {
  const schema = buildMembersSchema();

  return {
    id,
    slug: id.wsId,
    name: 'Members',
    schema,
    idColumnRemoteId: idPath('id'),
    titleColumnRemoteId: ['auth', 'email'],
    slugFieldPath: 'auth.email',
    basePath: [],
    generatedAt: new Date().toISOString(),
  };
}

/**
 * Build the TypeBox schema for a member record.
 * Matches the raw Memberstack API response shape.
 */
function buildMembersSchema(): TSchema {
  return Type.Object(
    {
      id: Type.String({ description: 'Unique member ID (mem_*)', [X_SCRATCH_READONLY]: true }),
      auth: Type.Object(
        {
          email: Type.String({ description: 'Member email address', format: 'email' }),
        },
        { description: 'Authentication details' },
      ),
      customFields: Type.Record(Type.String(), Type.String(), {
        description: 'Custom fields defined in Memberstack',
      }),
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
