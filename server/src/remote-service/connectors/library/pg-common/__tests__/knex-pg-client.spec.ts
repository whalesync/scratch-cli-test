/**
 * Unit tests for KnexPGClient.selectAll's query composition — specifically the
 * incremental modified-since predicate added for incremental pulls.
 *
 * Knex is mocked with a chainable, awaitable query-builder stub so we can
 * assert which builder methods the client invokes (and with what args) without
 * a live database. We assert behavior, not generated SQL strings.
 */

interface BuilderCall {
  method: string;
  args: unknown[];
}

const builderCalls: BuilderCall[] = [];
let lastTableArg: string | undefined;

function makeQueryBuilder(rows: Record<string, unknown>[]) {
  const qb: Record<string, unknown> = {};
  const chain =
    (method: string) =>
    (...args: unknown[]) => {
      builderCalls.push({ method, args });
      return qb;
    };
  for (const m of ['select', 'orderBy', 'offset', 'limit', 'whereRaw', 'where', 'whereIn']) {
    qb[m] = jest.fn(chain(m));
  }
  // Make the builder awaitable: `await query` resolves to the rows.
  qb.then = (resolve: (v: unknown) => unknown) => resolve(rows);
  return qb;
}

const mockRef = jest.fn((col: string) => ({ __knexRef: col }));
const mockRaw = jest.fn();
const mockDestroy = jest.fn().mockResolvedValue(undefined);

const knexInstance = jest.fn((table: string) => {
  lastTableArg = table;
  return makeQueryBuilder([{ id: 1 }, { id: 2 }]);
}) as unknown as jest.Mock & {
  ref: jest.Mock;
  raw: jest.Mock;
  destroy: jest.Mock;
};
knexInstance.ref = mockRef;
knexInstance.raw = mockRaw;
knexInstance.destroy = mockDestroy;

jest.mock('knex', () => ({
  __esModule: true,
  default: jest.fn(() => knexInstance),
}));

import { KnexPGClient } from '../knex-pg-client';

describe('KnexPGClient.selectAll modified-since predicate', () => {
  let client: KnexPGClient;

  beforeEach(() => {
    jest.clearAllMocks();
    builderCalls.length = 0;
    lastTableArg = undefined;
    client = new KnexPGClient('postgres://u:p@localhost:5432/db');
  });

  function calls(method: string) {
    return builderCalls.filter((c) => c.method === method);
  }

  it('does not add a where predicate when modifiedSince args are absent', async () => {
    await client.selectAll('public', 'records', undefined, 'id', 500, 0);

    expect(lastTableArg).toBe('public.records');
    expect(calls('where')).toHaveLength(0);
    expect(calls('whereRaw')).toHaveLength(0);
    expect(mockRef).not.toHaveBeenCalled();
  });

  it('adds a parameterized "> datetime" predicate via knex.ref when both modifiedSince args are present', async () => {
    const since = new Date('2026-05-14T12:00:00.000Z');
    await client.selectAll('public', 'records', undefined, 'id', 500, 0, undefined, 'updated_at', since);

    expect(mockRef).toHaveBeenCalledWith('updated_at');
    const whereCalls = calls('where');
    expect(whereCalls).toHaveLength(1);
    // Column is a knex Ref (quoted identifier), operator is '>', value is the
    // raw Date bound as a parameter — never string-interpolated.
    expect(whereCalls[0].args).toEqual([{ __knexRef: 'updated_at' }, '>', since]);
  });

  it('ANDs the modified-since predicate with an existing raw filter', async () => {
    const since = new Date('2026-05-14T12:00:00.000Z');
    await client.selectAll('public', 'records', undefined, 'id', 500, 0, "status = 'active'", 'updated_at', since);

    expect(calls('whereRaw')).toHaveLength(1);
    expect(calls('whereRaw')[0].args).toEqual(["status = 'active'"]);
    // Knex chains .whereRaw(...).where(...) as AND by default.
    expect(calls('where')).toHaveLength(1);
  });

  it('does not add the predicate when only the column is supplied (no datetime)', async () => {
    await client.selectAll('public', 'records', undefined, 'id', 500, 0, undefined, 'updated_at', undefined);

    expect(calls('where')).toHaveLength(0);
    expect(mockRef).not.toHaveBeenCalled();
  });
});
