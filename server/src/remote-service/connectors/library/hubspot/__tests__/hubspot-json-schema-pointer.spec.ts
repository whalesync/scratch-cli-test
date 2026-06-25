import { Type } from '@sinclair/typebox';
import { X_SCRATCH_READONLY } from '@spinner/shared-types';
import { BaseJsonTableSpec, dotPath } from '../../../types';
import { isReadonlyHubspotProperty } from '../hubspot-json-schema';

// Regression for DEV-10126: HubSpot property names are auto-sanitized to
// snake_case so the bug is unlikely to fire in practice, but the lookup must
// still RFC 6901-escape any interpolated segment.
describe('hubspot JSON Pointer escaping (RFC 6901)', () => {
  const propertyWithSlash = 'custom/prop';
  const propertyWithTilde = 'custom~prop';

  function buildSpec(): BaseJsonTableSpec {
    return {
      id: { wsId: 't', remoteId: ['t'] },
      slug: 't',
      name: 't',
      schema: Type.Object({
        properties: Type.Object({
          [propertyWithSlash]: Type.String({ [X_SCRATCH_READONLY]: true }),
          [propertyWithTilde]: Type.String({ [X_SCRATCH_READONLY]: true }),
        }),
      }),
      idPath: dotPath('id'),
    };
  }

  it('isReadonlyHubspotProperty handles property names containing `/`', () => {
    expect(isReadonlyHubspotProperty(propertyWithSlash, buildSpec())).toBe(true);
  });

  it('isReadonlyHubspotProperty handles property names containing `~`', () => {
    expect(isReadonlyHubspotProperty(propertyWithTilde, buildSpec())).toBe(true);
  });
});
