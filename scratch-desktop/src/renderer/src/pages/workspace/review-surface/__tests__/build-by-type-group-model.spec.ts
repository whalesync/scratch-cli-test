import { describe, expect, it } from 'vitest';
import { buildByTypeGroupModel, type ByTypeSourceColumn, type ByTypeSourceRow } from '../build-by-type-group-model';
import type { ChangeRowStatus } from '../group-pending-changes-by-change-type';

function row(
  status: ChangeRowStatus,
  options: {
    changedFields?: string[];
    fromFields?: Record<string, unknown>;
    unpublishedFields?: string[];
    masterFields?: Record<string, unknown>;
    raw?: Record<string, unknown>;
    filename?: string;
  } = {},
): ByTypeSourceRow {
  return {
    __rowStatus: status,
    __changedFields: options.changedFields ?? [],
    __fromFields: options.fromFields ?? {},
    __unpublishedFields: options.unpublishedFields ?? [],
    __masterFields: options.masterFields ?? {},
    __raw: options.raw ?? {},
    __filename: options.filename ?? 'r.json',
  };
}

function col(id: string, displayName: string = id): ByTypeSourceColumn {
  return { id, displayName };
}

const NO_EFFECTIVE_PATHS = new Map<string, string>();

describe('buildByTypeGroupModel', () => {
  it('returns no groups for empty input', () => {
    expect(buildByTypeGroupModel([], [], NO_EFFECTIVE_PATHS, null)).toEqual([]);
  });

  it('builds a field group whose column id equals its leaf path', () => {
    const groups = buildByTypeGroupModel(
      [
        row('modified', {
          changedFields: ['name'],
          fromFields: { name: 'Old' },
          raw: { name: 'New' },
          filename: 'a.json',
        }),
      ],
      [col('name', 'Name')],
      NO_EFFECTIVE_PATHS,
      null,
    );

    expect(groups).toEqual([
      {
        kind: 'field',
        columnId: 'name',
        effectivePath: 'name',
        title: 'Name',
        dotColorVar: 'var(--modified-needs-review-stroke)',
        recordFilenames: ['a.json'],
        rows: [
          {
            filename: 'a.json',
            recordName: 'a',
            fromDisplay: 'Old',
            toDisplay: 'New',
            rowStatus: 'modified',
            approved: false,
          },
        ],
      },
    ]);
  });

  it('matches and reads a subfield column at its EFFECTIVE leaf path, not the column id', () => {
    // The crux: WordPress-style `title` column drills to the `title.raw` leaf.
    // `__changedFields` / `__fromFields` are keyed by `title.raw`; the raw record
    // nests `{ title: { raw: ... } }`. Matching on the column id `title` would
    // miss the change entirely and produce a blank `from`.
    const groups = buildByTypeGroupModel(
      [
        row('modified', {
          changedFields: ['title.raw'],
          fromFields: { 'title.raw': 'Old title' },
          raw: { title: { raw: 'New title' } },
          filename: 'post.json',
        }),
      ],
      [col('title', 'Title')],
      new Map([['title', 'title.raw']]),
      'title.raw',
    );

    expect(groups).toHaveLength(1);
    const group = groups[0];
    expect(group.kind).toBe('field');
    expect(group.columnId).toBe('title');
    expect(group.effectivePath).toBe('title.raw');
    expect(group.title).toBe('Title');
    expect(group.rows[0]).toEqual({
      filename: 'post.json',
      recordName: 'New title',
      fromDisplay: 'Old title',
      toDisplay: 'New title',
      rowStatus: 'modified',
      approved: false,
    });
  });

  it('omits columns with no member rows', () => {
    const groups = buildByTypeGroupModel(
      [row('modified', { changedFields: ['name'], fromFields: { name: 'a' }, raw: { name: 'b' } })],
      [col('name'), col('status'), col('notes')],
      NO_EFFECTIVE_PATHS,
      null,
    );

    expect(groups.map((group) => group.columnId)).toEqual(['name']);
  });

  it('collects every member of a field group, in row order', () => {
    const groups = buildByTypeGroupModel(
      [
        row('modified', { changedFields: ['name'], fromFields: { name: '1' }, raw: { name: '2' }, filename: 'a.json' }),
        row('modified', { changedFields: ['name'], fromFields: { name: '3' }, raw: { name: '4' }, filename: 'b.json' }),
      ],
      [col('name')],
      NO_EFFECTIVE_PATHS,
      null,
    );

    expect(groups[0].recordFilenames).toEqual(['a.json', 'b.json']);
    expect(groups[0].rows.map((groupRow) => groupRow.toDisplay)).toEqual(['2', '4']);
  });

  it('includes an approved-but-unpublished field row (from = master, marked approved)', () => {
    const groups = buildByTypeGroupModel(
      [
        row('unpublished', {
          unpublishedFields: ['name'],
          masterFields: { name: 'Published' },
          raw: { name: 'Approved' },
          filename: 'u.json',
        }),
      ],
      [col('name')],
      NO_EFFECTIVE_PATHS,
      null,
    );

    expect(groups).toHaveLength(1);
    expect(groups[0].rows[0]).toEqual({
      filename: 'u.json',
      recordName: 'u',
      fromDisplay: 'Published',
      toDisplay: 'Approved',
      rowStatus: 'unpublished',
      approved: true,
    });
  });

  it('mixes unreviewed and approved rows in one column group, preserving order and from-sides', () => {
    const groups = buildByTypeGroupModel(
      [
        row('modified', {
          changedFields: ['name'],
          fromFields: { name: 'ApprovedOld' },
          raw: { name: 'Working' },
          filename: 'm.json',
        }),
        row('unpublished', {
          unpublishedFields: ['name'],
          masterFields: { name: 'Published' },
          raw: { name: 'Approved' },
          filename: 'u.json',
        }),
      ],
      [col('name')],
      NO_EFFECTIVE_PATHS,
      null,
    );

    expect(groups[0].rows.map((groupRow) => [groupRow.filename, groupRow.approved])).toEqual([
      ['m.json', false],
      ['u.json', true],
    ]);
    expect(groups[0].rows.map((groupRow) => groupRow.fromDisplay)).toEqual(['ApprovedOld', 'Published']);
    expect(groups[0].rows.map((groupRow) => groupRow.toDisplay)).toEqual(['Working', 'Approved']);
  });

  it('JSON-stringifies non-scalar field values for display', () => {
    const groups = buildByTypeGroupModel(
      [
        row('modified', {
          changedFields: ['tags'],
          fromFields: { tags: ['a'] },
          raw: { tags: ['a', 'b'] },
        }),
      ],
      [col('tags')],
      NO_EFFECTIVE_PATHS,
      null,
    );

    expect(groups[0].rows[0].fromDisplay).toBe('["a"]');
    expect(groups[0].rows[0].toDisplay).toBe('["a","b"]');
  });

  it('buckets created, deleted, and invalid-JSON rows into record-level groups (no from/to)', () => {
    const groups = buildByTypeGroupModel(
      [
        row('added', { filename: 'new.json' }),
        row('deleted', { filename: 'gone.json' }),
        row('invalidJson', { filename: 'broken.json' }),
      ],
      [],
      NO_EFFECTIVE_PATHS,
      null,
    );

    expect(groups.map((group) => [group.kind, group.title, group.recordFilenames])).toEqual([
      ['created', 'New', ['new.json']],
      ['deleted', 'Removed', ['gone.json']],
      ['invalidJson', 'Needs attention', ['broken.json']],
    ]);
    for (const group of groups) {
      expect(
        group.rows.every(
          (groupRow) => groupRow.fromDisplay === '' && groupRow.toDisplay === '' && groupRow.approved === false,
        ),
      ).toBe(true);
    }
  });

  it('orders groups: field columns (input order) → New → Removed → Needs attention', () => {
    const groups = buildByTypeGroupModel(
      [
        row('modified', { changedFields: ['zzz'], fromFields: { zzz: '1' }, raw: { zzz: '2' }, filename: 'm1.json' }),
        row('modified', { changedFields: ['aaa'], fromFields: { aaa: '1' }, raw: { aaa: '2' }, filename: 'm2.json' }),
        row('invalidJson', { filename: 'broken.json' }),
        row('deleted', { filename: 'gone.json' }),
        row('added', { filename: 'new.json' }),
      ],
      [col('zzz'), col('aaa')],
      NO_EFFECTIVE_PATHS,
      null,
    );

    expect(groups.map((group) => group.title)).toEqual(['zzz', 'aaa', 'New', 'Removed', 'Needs attention']);
  });

  it('names a record from the title column, falling back to the filename', () => {
    const groups = buildByTypeGroupModel(
      [row('added', { raw: { name: 'Acme' }, filename: 'rec-1.json' })],
      [],
      NO_EFFECTIVE_PATHS,
      'name',
    );

    expect(groups[0].rows[0].recordName).toBe('Acme');
  });
});
