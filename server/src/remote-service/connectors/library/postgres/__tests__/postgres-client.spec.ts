const mockPoolQuery = jest.fn();
const mockTxQuery = jest.fn();
const mockRelease = jest.fn();
const mockConnect = jest.fn();
const mockEnd = jest.fn();

jest.mock('pg', () => ({
  Pool: jest.fn().mockImplementation(() => ({
    query: mockPoolQuery,
    connect: mockConnect,
    end: mockEnd,
    on: jest.fn(),
  })),
}));

import { PostgresClient } from '../postgres-client';

describe('PostgresClient batched CRUD', () => {
  let client: PostgresClient;

  beforeEach(() => {
    jest.clearAllMocks();
    mockConnect.mockResolvedValue({
      query: mockTxQuery,
      release: mockRelease,
    });
    client = new PostgresClient('postgres://test');
    (client as unknown as { validatedTables: Set<string> }).validatedTables = new Set(['smoke_records']);
  });

  it('inserts rows inside one transaction and rolls back on failure', async () => {
    mockPoolQuery.mockResolvedValueOnce({
      rows: [{ column_name: 'id' }, { column_name: 'name' }, { column_name: 'published_at' }],
    });
    mockTxQuery
      .mockResolvedValueOnce(undefined) // BEGIN
      .mockResolvedValueOnce({ rows: [{ id: 1, name: 'Record 1' }] })
      .mockRejectedValueOnce(new Error('bad row'))
      .mockResolvedValueOnce(undefined); // ROLLBACK

    await expect(
      client.insertRows('smoke_records', [{ name: 'Record 1', published_at: '2026-04-15' }, { name: 'Record 2' }]),
    ).rejects.toThrow('bad row');

    expect(mockTxQuery).toHaveBeenNthCalledWith(1, 'BEGIN');
    expect(mockTxQuery).toHaveBeenNthCalledWith(
      2,
      'INSERT INTO "smoke_records" ("name", "published_at") VALUES ($1, $2) RETURNING *',
      ['Record 1', '2026-04-15'],
    );
    expect(mockTxQuery).toHaveBeenNthCalledWith(3, 'INSERT INTO "smoke_records" ("name") VALUES ($1) RETURNING *', [
      'Record 2',
    ]);
    expect(mockTxQuery).toHaveBeenNthCalledWith(4, 'ROLLBACK');
    expect(mockRelease).toHaveBeenCalledTimes(1);
  });

  it('updates rows inside one transaction and commits on success', async () => {
    mockPoolQuery.mockResolvedValueOnce({
      rows: [
        { column_name: 'id' },
        { column_name: 'name' },
        { column_name: 'published_at' },
        { column_name: 'status' },
      ],
    });
    mockTxQuery
      .mockResolvedValueOnce(undefined) // BEGIN
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce(undefined); // COMMIT

    await client.updateRows('smoke_records', 'id', [
      { id: 1, data: { name: 'Record 1.1' } },
      { id: 2, data: { status: 'published', published_at: null } },
    ]);

    expect(mockTxQuery).toHaveBeenNthCalledWith(1, 'BEGIN');
    expect(mockTxQuery).toHaveBeenNthCalledWith(
      2,
      'UPDATE "smoke_records" SET "name" = $2 WHERE "id"::text = $1::text',
      [1, 'Record 1.1'],
    );
    expect(mockTxQuery).toHaveBeenNthCalledWith(
      3,
      'UPDATE "smoke_records" SET "published_at" = $2, "status" = $3 WHERE "id"::text = $1::text',
      [2, null, 'published'],
    );
    expect(mockTxQuery).toHaveBeenNthCalledWith(4, 'COMMIT');
    expect(mockRelease).toHaveBeenCalledTimes(1);
  });

  it('deletes rows inside one transaction and commits on success', async () => {
    mockTxQuery
      .mockResolvedValueOnce(undefined) // BEGIN
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce(undefined); // COMMIT

    await client.deleteRows('smoke_records', 'id', [1, 2, 3]);

    expect(mockTxQuery).toHaveBeenNthCalledWith(1, 'BEGIN');
    expect(mockTxQuery).toHaveBeenNthCalledWith(2, 'DELETE FROM "smoke_records" WHERE "id"::text = $1::text', [1]);
    expect(mockTxQuery).toHaveBeenNthCalledWith(3, 'DELETE FROM "smoke_records" WHERE "id"::text = $1::text', [2]);
    expect(mockTxQuery).toHaveBeenNthCalledWith(4, 'DELETE FROM "smoke_records" WHERE "id"::text = $1::text', [3]);
    expect(mockTxQuery).toHaveBeenNthCalledWith(5, 'COMMIT');
    expect(mockRelease).toHaveBeenCalledTimes(1);
  });
});
