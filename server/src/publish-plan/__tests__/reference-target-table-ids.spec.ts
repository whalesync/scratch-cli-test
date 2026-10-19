import { type ForeignKeyPathInSchema } from '../ref-cleaner.service';
import { listReferenceTargetTableIdsForTable } from '../reference-target-table-ids';

describe('listReferenceTargetTableIdsForTable', () => {
  it('adds the linkedTableId of every annotation whose linkedTableRemoteId is the table (MySQL `db.table`)', () => {
    const foreignKeyPathsInConnectionSchemas: ForeignKeyPathInSchema[] = [
      { path: ['author_id'], targetRemoteTableId: 'test_db.authors', linkedTableRemoteId: ['test_db', 'authors'] },
      { path: ['best_friend_id'], targetRemoteTableId: 'test_db.authors', linkedTableRemoteId: ['test_db', 'authors'] },
    ];

    expect(listReferenceTargetTableIdsForTable(['test_db', 'authors'], foreignKeyPathsInConnectionSchemas)).toEqual([
      'authors',
      'test_db.authors',
    ]);
  });

  it('names a Postgres table outside `public` by its `schema.table` linkedTableId', () => {
    const foreignKeyPathsInConnectionSchemas: ForeignKeyPathInSchema[] = [
      { path: ['author_id'], targetRemoteTableId: 'sales.authors', linkedTableRemoteId: ['sales', 'authors'] },
    ];

    expect(listReferenceTargetTableIdsForTable(['sales', 'authors'], foreignKeyPathsInConnectionSchemas)).toEqual([
      'authors',
      'sales.authors',
    ]);
  });

  it('ignores annotations that point at a different table, even one with the same table name in another database', () => {
    const foreignKeyPathsInConnectionSchemas: ForeignKeyPathInSchema[] = [
      { path: ['author_id'], targetRemoteTableId: 'other_db.authors', linkedTableRemoteId: ['other_db', 'authors'] },
      { path: ['post_id'], targetRemoteTableId: 'test_db.posts', linkedTableRemoteId: ['test_db', 'posts'] },
    ];

    expect(listReferenceTargetTableIdsForTable(['test_db', 'authors'], foreignKeyPathsInConnectionSchemas)).toEqual([
      'authors',
    ]);
  });

  it('falls back to the last tableId segment for connectors that emit no linkedTableRemoteId', () => {
    const foreignKeyPathsInConnectionSchemas: ForeignKeyPathInSchema[] = [
      { path: ['fields', 'Author'], targetRemoteTableId: 'tblAuthors' },
    ];

    expect(listReferenceTargetTableIdsForTable(['appBase', 'tblAuthors'], foreignKeyPathsInConnectionSchemas)).toEqual([
      'tblAuthors',
    ]);
  });

  it('returns nothing for a folder without a tableId', () => {
    expect(listReferenceTargetTableIdsForTable([], [])).toEqual([]);
  });
});
