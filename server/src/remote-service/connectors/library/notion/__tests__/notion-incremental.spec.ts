import {
  addRequiredMemberToNotionFilter,
  buildNotionLastEditedFilter,
  combineNotionFilters,
  isCompoundNotionFilter,
  NOTION_INCREMENTAL_CLOCK_SKEW_MS,
  NOTION_MAX_COMPOUND_FILTER_NESTING_LEVELS,
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

  it('appends to a compound `and` user filter without adding a nesting level — stays incremental', () => {
    const memberA = { property: 'A', checkbox: { equals: true } } as const;
    expect(combineNotionFilters({ and: [memberA] }, ts)).toEqual({
      demoteToFull: false,
      filter: { and: [memberA, ts] },
    });
  });

  it('AND-wraps a compound `or` user filter of simple members — two levels, which Notion allows', () => {
    const userFilter = {
      or: [
        { property: 'A', checkbox: { equals: true } },
        { property: 'B', checkbox: { equals: false } },
      ],
    };
    expect(combineNotionFilters(userFilter, ts)).toEqual({
      demoteToFull: false,
      filter: { and: [userFilter, ts] },
    });
  });

  it('appends to an `and` user filter that already nests a compound — still no extra level', () => {
    const nestedOr = { or: [{ property: 'A', checkbox: { equals: true } }] };
    expect(combineNotionFilters({ and: [nestedOr] }, ts)).toEqual({
      demoteToFull: false,
      filter: { and: [nestedOr, ts] },
    });
  });

  it('demotes to full only when the `or` user filter already nests a compound (wrapping would be a third level)', () => {
    const userFilter: NotionFilter = {
      or: [{ and: [{ property: 'A', checkbox: { equals: true } }] }, { property: 'B', checkbox: { equals: true } }],
    };
    expect(combineNotionFilters(userFilter, ts)).toEqual({ demoteToFull: true });
  });
});

describe('addRequiredMemberToNotionFilter', () => {
  const ts = buildNotionLastEditedFilter(new Date('2026-05-14T12:00:00.000Z'));

  it('never exceeds Notion two-level nesting limit for any combinable shape', () => {
    const shapes: NotionFilter[] = [
      { property: 'A', checkbox: { equals: true } },
      { and: [{ property: 'A', checkbox: { equals: true } }] },
      { or: [{ property: 'A', checkbox: { equals: true } }] },
      { and: [{ or: [{ property: 'A', checkbox: { equals: true } }] }] },
    ];
    for (const shape of shapes) {
      const combined = addRequiredMemberToNotionFilter(shape, ts);
      expect(combined).not.toBeNull();
      expect(countCompoundNestingLevels(combined)).toBeLessThanOrEqual(NOTION_MAX_COMPOUND_FILTER_NESTING_LEVELS);
    }
  });
});

/** Test-local depth probe, so the assertion above doesn't just re-run production logic. */
function countCompoundNestingLevels(filter: unknown): number {
  if (typeof filter !== 'object' || filter === null) {
    return 0;
  }
  const members = 'and' in filter ? filter.and : 'or' in filter ? filter.or : undefined;
  if (!Array.isArray(members)) {
    return 0;
  }
  return 1 + Math.max(0, ...members.map((member) => countCompoundNestingLevels(member)));
}
