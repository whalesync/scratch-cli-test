import { TSchema } from '@sinclair/typebox';
import { type BaseJsonTableSpec, dotPath } from '../../../../remote-service/connectors/types';
import { buildGitFilesFromConnectorFiles } from '../connector-file-utils';

function buildTableSpec(): BaseJsonTableSpec {
  return {
    id: { wsId: 'tbl', remoteId: ['tbl_remote'] },
    slug: 'tbl',
    name: 'tbl',
    idPath: dotPath('id'),
    schema: {} as unknown as TSchema,
  };
}

describe('buildGitFilesFromConnectorFiles — re-delivered records', () => {
  const tableSpec = buildTableSpec();

  it('gives a record re-delivered later in the same run the same path, not an id-suffixed twin', () => {
    // A connector can re-deliver a record within one run — Notion's
    // 10,000-result continuation re-returns the boundary minute. The FileIndex
    // lookup can't know about a record first seen earlier in this same run, so
    // without the run-scoped map the second delivery mints `post-rec_1.json`.
    const usedFileNames = new Set<string>();
    const fileNamesAssignedByRecordIdInThisRun = new Map<string, string>();

    const firstBatch = buildGitFilesFromConnectorFiles(
      '/notion',
      [{ id: 'rec_1' }],
      tableSpec,
      usedFileNames,
      new Map(),
      ['post'],
      fileNamesAssignedByRecordIdInThisRun,
    );

    // Second batch: the FileIndex lookup is still empty for this record (the
    // upsert is best-effort and, within a batch, hasn't happened at all).
    const secondBatch = buildGitFilesFromConnectorFiles(
      '/notion',
      [{ id: 'rec_1' }],
      tableSpec,
      usedFileNames,
      new Map(),
      ['post'],
      fileNamesAssignedByRecordIdInThisRun,
    );

    expect(firstBatch[0].path).toBe('/notion/post.json');
    expect(secondBatch[0].path).toBe('/notion/post.json');
  });

  it('gives a record repeated inside a single batch one path', () => {
    const built = buildGitFilesFromConnectorFiles(
      '/notion',
      [{ id: 'rec_1' }, { id: 'rec_1' }],
      tableSpec,
      new Set<string>(),
      new Map(),
      ['post', 'post'],
      new Map(),
    );

    expect(built.map((f) => f.path)).toEqual(['/notion/post.json', '/notion/post.json']);
  });

  it('still disambiguates two DIFFERENT records whose suggested names collide', () => {
    const built = buildGitFilesFromConnectorFiles(
      '/notion',
      [{ id: 'rec_1' }, { id: 'rec_2' }],
      tableSpec,
      new Set<string>(),
      new Map(),
      ['post', 'post'],
      new Map(),
    );

    expect(built[0].path).toBe('/notion/post.json');
    expect(built[1].path).not.toBe('/notion/post.json');
    expect(built[1].path).toContain('rec_2');
  });

  it('prefers the FileIndex name for a record already on disk from a previous run', () => {
    const built = buildGitFilesFromConnectorFiles(
      '/notion',
      [{ id: 'rec_1' }],
      tableSpec,
      new Set<string>(),
      new Map([['rec_1', 'previously-named.json']]),
      ['post'],
      new Map(),
    );

    expect(built[0].path).toBe('/notion/previously-named.json');
  });
});
