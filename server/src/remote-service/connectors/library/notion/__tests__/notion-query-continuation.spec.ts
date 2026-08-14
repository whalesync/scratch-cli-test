import {
  buildNotionCreatedOnOrAfterFilter,
  combineNotionFilterWithCreatedTimeContinuation,
} from '../notion-query-continuation';

const BOUNDARY = '2026-08-01T12:34:00.000Z';
const CONTINUATION_FILTER = {
  timestamp: 'created_time',
  created_time: { on_or_after: BOUNDARY },
};

describe('buildNotionCreatedOnOrAfterFilter', () => {
  it('builds an inclusive on_or_after created_time timestamp filter', () => {
    expect(buildNotionCreatedOnOrAfterFilter(BOUNDARY)).toEqual(CONTINUATION_FILTER);
  });
});

describe('combineNotionFilterWithCreatedTimeContinuation', () => {
  it('returns the continuation filter alone when there is no base filter', () => {
    expect(combineNotionFilterWithCreatedTimeContinuation(undefined, BOUNDARY)).toEqual(CONTINUATION_FILTER);
  });

  it('AND-wraps a simple base filter with the continuation filter', () => {
    const simpleBaseFilter = { property: 'Status', checkbox: { equals: true } } as const;
    expect(combineNotionFilterWithCreatedTimeContinuation(simpleBaseFilter, BOUNDARY)).toEqual({
      and: [simpleBaseFilter, CONTINUATION_FILTER],
    });
  });

  it('appends the continuation filter as one more member of an `and` compound (no extra nesting)', () => {
    const memberA = { property: 'A', checkbox: { equals: true } } as const;
    const memberB = {
      timestamp: 'last_edited_time',
      last_edited_time: { on_or_after: '2026-07-01T00:00:00.000Z' },
    } as const;
    expect(combineNotionFilterWithCreatedTimeContinuation({ and: [memberA, memberB] }, BOUNDARY)).toEqual({
      and: [memberA, memberB, CONTINUATION_FILTER],
    });
  });

  it('AND-wraps an `or` compound of simple members — two levels, which Notion allows', () => {
    const orCompoundBaseFilter = {
      or: [
        { property: 'A', checkbox: { equals: true } },
        { property: 'B', checkbox: { equals: false } },
      ],
    };
    expect(combineNotionFilterWithCreatedTimeContinuation(orCompoundBaseFilter, BOUNDARY)).toEqual({
      and: [orCompoundBaseFilter, CONTINUATION_FILTER],
    });
  });

  it('appends to an `and` compound that already nests a compound, without adding a level', () => {
    const nestedOr = { or: [{ property: 'A', checkbox: { equals: true } }] };
    expect(combineNotionFilterWithCreatedTimeContinuation({ and: [nestedOr] }, BOUNDARY)).toEqual({
      and: [nestedOr, CONTINUATION_FILTER],
    });
  });

  it('returns null only for an `or` compound that already nests a compound (wrapping would be a third level)', () => {
    const orCompoundContainingACompound = {
      or: [{ and: [{ property: 'A', checkbox: { equals: true } }] }, { property: 'B', checkbox: { equals: true } }],
    };
    expect(combineNotionFilterWithCreatedTimeContinuation(orCompoundContainingACompound, BOUNDARY)).toBeNull();
  });
});
