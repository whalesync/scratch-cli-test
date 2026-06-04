import { X_SCRATCH_LAST_MODIFIED_FIELD } from '@spinner/shared-types';
import { findLastModifiedFieldName } from '../../../types';
import { HubspotApiClient } from '../hubspot-api-client';
import { buildHubspotJsonTableSpec, resolveHubspotLastModifiedPropertyName } from '../hubspot-json-schema';
import { HubspotProperty } from '../hubspot-types';

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
