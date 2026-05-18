import {
  buildNotionLastEditedFilter,
  combineNotionFilters,
  isCompoundNotionFilter,
  NOTION_INCREMENTAL_CLOCK_SKEW_MS,
  type NotionFilter,
} from '../notion-incremental';

describe('NOTION_INCREMENTAL_CLOCK_SKEW_MS', () => {
  it('is 0 — Notion on_or_after is inclusive and compares server-side timestamps', () => {
    expect(NOTION_INCREMENTAL_CLOCK_SKEW_MS).toBe(0);
  });
});

describe('buildNotionLastEditedFilter', () => {
  it('builds an inclusive on_or_after last_edited_time timestamp filter with no skew applied', () => {
    const since = new Date('2026-05-14T12:00:00.000Z');
    expect(buildNotionLastEditedFilter(since)).toEqual({
      timestamp: 'last_edited_time',
      last_edited_time: { on_or_after: '2026-05-14T12:00:00.000Z' },
    });
  });
});

describe('isCompoundNotionFilter', () => {
  it('is true for a top-level compound and/or', () => {
    expect(isCompoundNotionFilter({ and: [] })).toBe(true);
    expect(isCompoundNotionFilter({ or: [] })).toBe(true);
  });

  it('is false for a simple property filter', () => {
    const simple: NotionFilter = { property: 'Status', checkbox: { equals: true } };
    expect(isCompoundNotionFilter(simple)).toBe(false);
  });
});

describe('combineNotionFilters', () => {
  const ts = buildNotionLastEditedFilter(new Date('2026-05-14T12:00:00.000Z'));

  it('returns the timestamp filter alone when there is no user filter', () => {
    expect(combineNotionFilters(undefined, ts)).toEqual({ demoteToFull: false, filter: ts });
  });

  it('AND-combines a simple user filter with the timestamp filter', () => {
    const userFilter: NotionFilter = { property: 'Status', checkbox: { equals: true } };
    expect(combineNotionFilters(userFilter, ts)).toEqual({
      demoteToFull: false,
      filter: { and: [userFilter, ts] },
    });
  });

  it('demotes to full when the user filter is a compound `and` (would exceed Notion nesting limit)', () => {
    const userFilter: NotionFilter = { and: [{ property: 'A', checkbox: { equals: true } }] };
    expect(combineNotionFilters(userFilter, ts)).toEqual({ demoteToFull: true });
  });

  it('demotes to full when the user filter is a compound `or`', () => {
    const userFilter: NotionFilter = { or: [{ property: 'A', checkbox: { equals: true } }] };
    expect(combineNotionFilters(userFilter, ts)).toEqual({ demoteToFull: true });
  });
});
