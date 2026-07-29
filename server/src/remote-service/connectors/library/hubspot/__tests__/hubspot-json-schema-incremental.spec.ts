import { TSchema } from '@sinclair/typebox';
import { X_SCRATCH_FOREIGN_KEY_OPTIONS, X_SCRATCH_LAST_MODIFIED_FIELD } from '@spinner/shared-types';
import { extractSchemaFields } from 'src/utils/schema-helpers';
import { findLastModifiedFieldName } from '../../../types';
import { HubspotApiClient } from '../hubspot-api-client';
import { buildHubspotJsonTableSpec, resolveHubspotLastModifiedPropertyName } from '../hubspot-json-schema';
import { ASSOCIATIONS_BY_OBJECT_TYPE, HubspotProperty } from '../hubspot-types';

function property(name: string): HubspotProperty {
  return {
    name,
    label: name,
    type: 'string',
    fieldType: 'text',
    description: '',
    hidden: false,
  };
}

/** Minimal fake client exposing only what buildHubspotJsonTableSpec uses. */
function fakeClient(properties: HubspotProperty[]): HubspotApiClient {
  return { getProperties: () => Promise.resolve(properties) } as unknown as HubspotApiClient;
}

function lastModifiedAnnotation(spec: { schema: unknown }, propertyName: string): unknown {
  const schema = spec.schema as { properties: { properties: { properties: Record<string, Record<string, unknown>> } } };
  return schema.properties.properties.properties[propertyName]?.[X_SCRATCH_LAST_MODIFIED_FIELD];
}

describe('resolveHubspotLastModifiedPropertyName', () => {
  it('prefers hs_lastmodifieddate when both candidates are present', () => {
    expect(resolveHubspotLastModifiedPropertyName(new Set(['hs_lastmodifieddate', 'lastmodifieddate']))).toBe(
      'hs_lastmodifieddate',
    );
  });

  it('falls back to lastmodifieddate when hs_lastmodifieddate is absent (contacts)', () => {
    expect(resolveHubspotLastModifiedPropertyName(new Set(['lastmodifieddate', 'name']))).toBe('lastmodifieddate');
  });

  it('returns undefined when the object exposes neither candidate', () => {
    expect(resolveHubspotLastModifiedPropertyName(new Set(['name', 'email']))).toBeUndefined();
  });
});

describe('buildHubspotJsonTableSpec last-modified annotation', () => {
  const id = { wsId: 'companies', remoteId: ['companies'] };

  it('annotates hs_lastmodifieddate (preferred) and findLastModifiedFieldName resolves it', async () => {
    const { spec } = await buildHubspotJsonTableSpec(
      id,
      'companies',
      fakeClient([property('name'), property('hs_lastmodifieddate'), property('lastmodifieddate')]),
    );

    expect(lastModifiedAnnotation(spec, 'hs_lastmodifieddate')).toBe(true);
    // The fallback candidate is NOT annotated when the preferred one exists.
    expect(lastModifiedAnnotation(spec, 'lastmodifieddate')).toBeUndefined();
    expect(findLastModifiedFieldName(spec)).toBe('hs_lastmodifieddate');
  });

  it('annotates lastmodifieddate when it is the only candidate (contacts)', async () => {
    const { spec } = await buildHubspotJsonTableSpec(
      { wsId: 'contacts', remoteId: ['contacts'] },
      'contacts',
      fakeClient([property('email'), property('lastmodifieddate')]),
    );

    expect(lastModifiedAnnotation(spec, 'lastmodifieddate')).toBe(true);
    expect(findLastModifiedFieldName(spec)).toBe('lastmodifieddate');
  });

  it('annotates nothing when the object exposes no last-modified property (custom object)', async () => {
    const { spec } = await buildHubspotJsonTableSpec(
      { wsId: 'p123_widgets', remoteId: ['p123_widgets'] },
      'p123_widgets',
      fakeClient([property('name'), property('color')]),
    );

    expect(lastModifiedAnnotation(spec, 'name')).toBeUndefined();
    expect(findLastModifiedFieldName(spec)).toBeUndefined();
  });
});

describe('buildHubspotJsonTableSpec datetime format annotation', () => {
  const id = { wsId: 'deals', remoteId: ['deals'] };

  /**
   * The `format` the generic flattener reads for a field — the exact path the
   * schema-builder consumes to decide a date vs datetime destination column.
   */
  function fieldFormat(spec: { schema: unknown }, fieldPath: string): string | undefined {
    return extractSchemaFields(spec.schema as TSchema).find((field) => field.path === fieldPath)?.format;
  }

  it('annotates datetime properties with format date-time and leaves date/other properties alone', async () => {
    const datetimeProp: HubspotProperty = { ...property('closedate'), type: 'datetime', fieldType: 'date' };
    const dateProp: HubspotProperty = { ...property('pilot_start_date'), type: 'date', fieldType: 'date' };

    const { spec } = await buildHubspotJsonTableSpec(
      id,
      'deals',
      fakeClient([datetimeProp, dateProp, property('dealname')]),
    );

    expect(fieldFormat(spec, 'properties.closedate')).toBe('date-time');
    expect(fieldFormat(spec, 'properties.pilot_start_date')).toBeUndefined();
    expect(fieldFormat(spec, 'properties.dealname')).toBeUndefined();
    // The record-level createdAt/updatedAt timestamps are full datetimes too.
    expect(fieldFormat(spec, 'createdAt')).toBe('date-time');
    expect(fieldFormat(spec, 'updatedAt')).toBe('date-time');
  });

  it('admits the empty-string sentinel HubSpot returns for an unset datetime property', async () => {
    const datetimeProp: HubspotProperty = {
      ...property('notes_next_activity_date'),
      type: 'datetime',
      fieldType: 'date',
    };

    const { spec } = await buildHubspotJsonTableSpec(id, 'deals', fakeClient([datetimeProp]));

    // HubSpot returns `""` (not `null`) for an unset datetime property, and an empty
    // string fails the `date-time` format check — the union must carry an explicit
    // empty-string variant so verbatim records pass enforce_schema. Round-trip
    // through JSON to check the serialized shape (what lands in schema.json on disk),
    // stripping TypeBox's symbol keys.
    const serializedSchema = JSON.parse(JSON.stringify(spec.schema)) as {
      properties: { properties: { properties: Record<string, { anyOf: Record<string, unknown>[] }> } };
    };
    const datetimeUnionVariants = serializedSchema.properties.properties.properties['notes_next_activity_date'].anyOf;
    expect(datetimeUnionVariants).toContainEqual({ const: '', type: 'string' });
  });
});

describe('buildHubspotJsonTableSpec association foreign keys', () => {
  /** Reach the FK options on `associations.<assocType>.results[].id`. */
  function associationForeignKey(spec: { schema: unknown }, assocType: string): unknown {
    const schema = spec.schema as {
      properties: {
        associations: {
          properties: Record<
            string,
            { properties: { results: { items: { properties: { id: Record<string, unknown> } } } } }
          >;
        };
      };
    };
    return schema.properties.associations.properties[assocType]?.properties.results.items.properties.id?.[
      X_SCRATCH_FOREIGN_KEY_OPTIONS
    ];
  }

  it('annotates each association id with linkedTableId = the association object type', async () => {
    const { spec } = await buildHubspotJsonTableSpec(
      { wsId: 'deals', remoteId: ['deals'] },
      'deals',
      fakeClient([property('dealname')]),
    );

    // Deals associate with companies, contacts, deals (self), notes, tasks, tickets.
    // linkedTableRemoteId is the target standard object's single-segment remoteId.
    expect(associationForeignKey(spec, 'companies')).toEqual({
      linkedTableId: 'companies',
      linkedTableRemoteId: ['companies'],
    });
    expect(associationForeignKey(spec, 'contacts')).toEqual({
      linkedTableId: 'contacts',
      linkedTableRemoteId: ['contacts'],
    });
    expect(associationForeignKey(spec, 'deals')).toEqual({ linkedTableId: 'deals', linkedTableRemoteId: ['deals'] });
    expect(associationForeignKey(spec, 'notes')).toEqual({ linkedTableId: 'notes', linkedTableRemoteId: ['notes'] });
  });

  it('uses the raw HubSpot object-type code as linkedTableId (appointments → 0-421)', async () => {
    const { spec } = await buildHubspotJsonTableSpec(
      { wsId: 'meetings', remoteId: ['meetings'] },
      'meetings',
      fakeClient([property('hs_meeting_title')]),
    );

    // Meetings associate with 0-421 (Appointments), whose table wsId is the code itself.
    // 0-421 is a standard object with remoteId ['0-421'], so the array is that code too.
    expect(associationForeignKey(spec, '0-421')).toEqual({ linkedTableId: '0-421', linkedTableRemoteId: ['0-421'] });
  });

  it('annotates every association declared for an object type', async () => {
    const { spec } = await buildHubspotJsonTableSpec(
      { wsId: 'contacts', remoteId: ['contacts'] },
      'contacts',
      fakeClient([property('email')]),
    );

    for (const assocType of ASSOCIATIONS_BY_OBJECT_TYPE['contacts']) {
      expect(associationForeignKey(spec, assocType)).toEqual({
        linkedTableId: assocType,
        linkedTableRemoteId: [assocType],
      });
    }
  });

  it('builds no associations group for an object type without associations (products)', async () => {
    const { spec } = await buildHubspotJsonTableSpec(
      { wsId: 'products', remoteId: ['products'] },
      'products',
      fakeClient([property('name')]),
    );

    const schema = spec.schema as unknown as { properties: Record<string, unknown> };
    expect(schema.properties.associations).toBeUndefined();
  });
});
