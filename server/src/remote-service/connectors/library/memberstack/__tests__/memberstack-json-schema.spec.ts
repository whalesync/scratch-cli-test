import { TSchema } from '@sinclair/typebox';
import { EntityId } from '../../../types';
import { buildMemberstackJsonTableSpec } from '../memberstack-json-schema';

const MEMBERS_ID: EntityId = { wsId: 'members', remoteId: ['members'] };

type ObjectSchema = TSchema & {
  type?: string;
  properties?: Record<string, TSchema>;
  additionalProperties?: TSchema | boolean;
};

function customFieldsSchema(spec: ReturnType<typeof buildMemberstackJsonTableSpec>): ObjectSchema {
  const root = spec.schema as ObjectSchema;
  const customFields = root.properties?.customFields as ObjectSchema | undefined;
  if (!customFields) throw new Error('customFields property missing from schema');
  return customFields;
}

describe('buildMemberstackJsonTableSpec — customFields expansion', () => {
  it('expands each discovered key into its own string property', () => {
    const spec = buildMemberstackJsonTableSpec(MEMBERS_ID, ['first-name', 'company']);
    const customFields = customFieldsSchema(spec);

    expect(customFields.type).toBe('object');
    expect(Object.keys(customFields.properties ?? {})).toEqual(['first-name', 'company']);
    expect((customFields.properties?.['first-name'] as TSchema & { type?: string }).type).toBe('string');
    expect((customFields.properties?.['company'] as TSchema & { type?: string }).type).toBe('string');
  });

  it('keeps the object open so unseen custom fields still validate and round-trip', () => {
    const spec = buildMemberstackJsonTableSpec(MEMBERS_ID, ['first-name']);
    const customFields = customFieldsSchema(spec);

    // additionalProperties is a string schema (not `false`), so a custom field added
    // after the last schema refresh is still accepted.
    expect(customFields.additionalProperties).toMatchObject({ type: 'string' });
  });

  it('leaves customFields as a single open object (no properties map) when no keys are discovered', () => {
    const spec = buildMemberstackJsonTableSpec(MEMBERS_ID, []);
    const customFields = customFieldsSchema(spec);

    // A `properties`-less object renders as ONE leaf blob column. An empty `properties`
    // map would instead expand to zero columns and hide customFields — so it must be
    // absent here, not `{}`.
    expect(customFields.type).toBe('object');
    expect(customFields.properties).toBeUndefined();
  });

  it('defaults to no expansion when keys are omitted', () => {
    const spec = buildMemberstackJsonTableSpec(MEMBERS_ID);
    const customFields = customFieldsSchema(spec);

    expect(customFields.properties).toBeUndefined();
  });

  it('does NOT expand when a key contains a dot (would collide with the dot-path engine)', () => {
    // All-or-nothing: a single unsafe key keeps the whole object as a blob so the dotted
    // field stays visible/editable rather than producing a broken `customFields.plan.tier`
    // column (which would read/write the wrong nested location).
    const spec = buildMemberstackJsonTableSpec(MEMBERS_ID, ['plan.tier']);
    const customFields = customFieldsSchema(spec);

    expect(customFields.type).toBe('object');
    expect(customFields.properties).toBeUndefined();
  });

  it('does NOT expand any keys when only some are path-safe', () => {
    const spec = buildMemberstackJsonTableSpec(MEMBERS_ID, ['first-name', 'plan.tier']);
    const customFields = customFieldsSchema(spec);

    expect(customFields.properties).toBeUndefined();
  });
});
