import {
  isIncrementalPullDestinationService,
  parseIncrementalPullDestinationServicesPayload,
} from '../live-export-incremental-destination-pull';

describe('ENABLE_LIVE_EXPORT_INCREMENTAL_DESTINATION_PULL payload', () => {
  it('a plain array of service ids enrols exactly those connectors, case-insensitively', () => {
    const enrolled = parseIncrementalPullDestinationServicesPayload(['notion', 'AIRTABLE']);
    expect(enrolled).toEqual({ allServices: false, services: new Set(['NOTION', 'AIRTABLE']) });
    if (!enrolled) throw new Error('unreachable');
    expect(isIncrementalPullDestinationService(enrolled, 'NOTION')).toBe(true);
    expect(isIncrementalPullDestinationService(enrolled, 'Airtable')).toBe(true);
    expect(isIncrementalPullDestinationService(enrolled, 'SUPABASE')).toBe(false);
    expect(isIncrementalPullDestinationService(enrolled, null)).toBe(false);
  });

  it('["*"] enrols every connector', () => {
    const enrolled = parseIncrementalPullDestinationServicesPayload(['*']);
    expect(enrolled).toEqual({ allServices: true });
    if (!enrolled) throw new Error('unreachable');
    expect(isIncrementalPullDestinationService(enrolled, 'ANYTHING')).toBe(true);
    // The wildcard wins even alongside explicit entries.
    expect(parseIncrementalPullDestinationServicesPayload(['NOTION', '*'])).toEqual({ allServices: true });
  });

  it('an empty array enrols nothing', () => {
    const enrolled = parseIncrementalPullDestinationServicesPayload([]);
    expect(enrolled).toEqual({ allServices: false, services: new Set() });
    if (!enrolled) throw new Error('unreachable');
    expect(isIncrementalPullDestinationService(enrolled, 'NOTION')).toBe(false);
  });

  it('anything that is not an array of non-empty strings is malformed (null), never "everything"', () => {
    expect(parseIncrementalPullDestinationServicesPayload({ destinationServices: ['NOTION'] })).toBeNull();
    expect(parseIncrementalPullDestinationServicesPayload('NOTION')).toBeNull();
    expect(parseIncrementalPullDestinationServicesPayload(true)).toBeNull();
    expect(parseIncrementalPullDestinationServicesPayload(null)).toBeNull();
    expect(parseIncrementalPullDestinationServicesPayload(['NOTION', 42])).toBeNull();
    expect(parseIncrementalPullDestinationServicesPayload([''])).toBeNull();
  });
});
