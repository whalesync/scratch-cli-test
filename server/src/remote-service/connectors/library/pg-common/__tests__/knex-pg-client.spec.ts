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

/**
 * Regression tests for KnexPGClient.updateMany's per-row change-set handling
 * (DEV-10787). Each record's `data` is a SPARSE change set, so a batch where
 * different rows changed different columns MUST NOT be collapsed into one fixed
 * SET clause — that would NULL sibling rows' untouched columns and drop their
 * real changes. We assert the SQL grouping behavior against the mocked
 * `knex.raw`, reading back the SET clause and json_populate_recordset payload.
 */
describe('KnexPGClient.updateMany sparse change-set grouping', () => {
  let client: KnexPGClient;

  interface RawCall {
    setColumns: string[];
    payload: Record<string, unknown>[];
  }

  /** Parse each mocked knex.raw call into the SET columns and JSON payload it carried. */
  function rawCallsAsSetAndPayload(): RawCall[] {
    return mockRaw.mock.calls.map(([query, bindings]) => {
      const setClause = /SET ([\s\S]*?)\s+FROM json_populate_recordset/.exec(query as string);
      const setColumns = (setClause?.[1] ?? '')
        .split(',')
        .map((assignment) => assignment.trim())
        .filter((assignment) => assignment.length > 0)
        // "col" = v."col"  →  col
        .map((assignment) => assignment.split('=')[0].trim().replace(/"/g, ''));
      const jsonParam = (bindings as unknown[])[0] as string;
      return { setColumns, payload: JSON.parse(jsonParam) as Record<string, unknown>[] };
    });
  }

  beforeEach(() => {
    jest.clearAllMocks();
    client = new KnexPGClient('postgres://u:p@localhost:5432/db');
    // Default: every UPDATE returns the rows it targeted, keyed by their PK.
    mockRaw.mockImplementation((_query: string, bindings: unknown[]) => {
      const payload = JSON.parse((bindings as string[])[0]) as Record<string, unknown>[];
      return Promise.resolve({ rows: payload });
    });
  });

  it('returns [] for an empty batch without querying', async () => {
    const result = await client.updateMany('public', 'records', 'id', []);
    expect(result).toEqual([]);
    expect(mockRaw).not.toHaveBeenCalled();
  });

  it('issues a single UPDATE for a homogeneous batch (all rows change the same columns)', async () => {
    await client.updateMany('public', 'records', 'id', [
      { id: 1, data: { name: 'a' } },
      { id: 2, data: { name: 'b' } },
    ]);

    const raws = rawCallsAsSetAndPayload();
    expect(raws).toHaveLength(1);
    expect(raws[0].setColumns).toEqual(['name']);
    expect(raws[0].payload).toEqual([
      { name: 'a', id: 1 },
      { name: 'b', id: 2 },
    ]);
  });

  it('splits a mixed batch into one UPDATE per changed-column set so siblings are not corrupted', async () => {
    await client.updateMany('public', 'records', 'id', [
      { id: 1, data: { name: 'a' } },
      { id: 2, data: { price: 5 } },
    ]);

    const raws = rawCallsAsSetAndPayload();
    expect(raws).toHaveLength(2);

    const nameGroup = raws.find((r) => r.setColumns.includes('name'));
    const priceGroup = raws.find((r) => r.setColumns.includes('price'));
    // Row 1 only updates `name`; its query never touches `price` (which would
    // otherwise NULL row 1's price via json_populate_recordset).
    expect(nameGroup?.setColumns).toEqual(['name']);
    expect(nameGroup?.payload).toEqual([{ name: 'a', id: 1 }]);
    // Row 2 only updates `price`; its real change is not dropped.
    expect(priceGroup?.setColumns).toEqual(['price']);
    expect(priceGroup?.payload).toEqual([{ price: 5, id: 2 }]);
  });

  it('groups rows that change the same columns regardless of key order', async () => {
    await client.updateMany('public', 'records', 'id', [
      { id: 1, data: { name: 'a', price: 1 } },
      { id: 2, data: { price: 2, name: 'b' } },
    ]);

    const raws = rawCallsAsSetAndPayload();
    expect(raws).toHaveLength(1);
    expect([...raws[0].setColumns].sort()).toEqual(['name', 'price']);
    expect(raws[0].payload).toHaveLength(2);
  });

  it('preserves an explicit null-clear as a SET column (does not treat it as "no change")', async () => {
    await client.updateMany('public', 'records', 'id', [{ id: 1, data: { name: null } }]);

    const raws = rawCallsAsSetAndPayload();
    expect(raws).toHaveLength(1);
    expect(raws[0].setColumns).toEqual(['name']);
    expect(raws[0].payload).toEqual([{ name: null, id: 1 }]);
  });

  it('marks records with no changed columns as not_found without issuing a query for them', async () => {
    const result = await client.updateMany('public', 'records', 'id', [
      { id: 1, data: {} },
      { id: 2, data: { id: 2 } },
    ]);

    expect(mockRaw).not.toHaveBeenCalled();
    expect(result).toEqual(['not_found', 'not_found']);
  });

  it('returns updated rows aligned to the input order, with not_found for rows that vanished', async () => {
    // Row 2's UPDATE affects zero rows (deleted mid-publish): return no rows for it.
    mockRaw.mockImplementation((_query: string, bindings: unknown[]) => {
      const payload = JSON.parse((bindings as string[])[0]) as Record<string, unknown>[];
      return Promise.resolve({ rows: payload.filter((row) => row.id !== 2) });
    });

    const result = await client.updateMany('public', 'records', 'id', [
      { id: 1, data: { name: 'a' } },
      { id: 2, data: { name: 'b' } },
      { id: 3, data: { name: 'c' } },
    ]);

    expect(result).toEqual([{ name: 'a', id: 1 }, 'not_found', { name: 'c', id: 3 }]);
  });
});
