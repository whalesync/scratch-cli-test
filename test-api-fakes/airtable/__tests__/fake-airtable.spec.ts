import request from 'supertest';
import { createApp } from '../src/index';
import { store } from '../src/store';
import type { Express } from 'express';

const AUTH = { Authorization: 'Bearer fake-api-key' };

let app: Express;

beforeAll(() => {
  app = createApp();
});

beforeEach(async () => {
  await request(app).post('/test/reset').expect(200);
});

// ─── Auth ────────────────────────────────────────────────────────────────────

describe('auth', () => {
  it('rejects requests without auth header', async () => {
    const res = await request(app).get('/v0/meta/bases').expect(401);
    expect(res.body.error.type).toBe('AUTHENTICATION_REQUIRED');
  });

  it('rejects requests with malformed auth header', async () => {
    const res = await request(app)
      .get('/v0/meta/bases')
      .set('Authorization', 'Basic abc123')
      .expect(401);
    expect(res.body.error.type).toBe('AUTHENTICATION_REQUIRED');
  });

  it('allows requests with valid Bearer token', async () => {
    const res = await request(app).get('/v0/meta/bases').set(AUTH).expect(200);
    expect(res.body.bases).toEqual([]);
  });

  it('does not require auth for /test/ endpoints', async () => {
    await request(app).post('/test/reset').expect(200);
  });
});

// ─── Test Admin ──────────────────────────────────────────────────────────────

describe('test admin', () => {
  it('POST /test/setup creates bases, tables, and records', async () => {
    await request(app)
      .post('/test/setup')
      .send({
        bases: [{ id: 'appABC', name: 'My Base', permissionLevel: 'create' }],
        tables: [
          {
            baseId: 'appABC',
            tables: [
              {
                id: 'tblXYZ',
                name: 'Tasks',
                primaryFieldId: 'fldName',
                fields: [
                  { id: 'fldName', name: 'Name', type: 'singleLineText' },
                  { id: 'fldStatus', name: 'Status', type: 'singleSelect' },
                ],
                views: [{ id: 'viwMain', name: 'Grid view', type: 'grid' }],
              },
            ],
          },
        ],
        records: [
          {
            baseId: 'appABC',
            tableId: 'tblXYZ',
            records: [{ fields: { Name: 'Task 1', Status: 'Done' } }, { fields: { Name: 'Task 2', Status: 'Todo' } }],
          },
        ],
      })
      .expect(200);

    // Verify bases were created
    const basesRes = await request(app).get('/v0/meta/bases').set(AUTH).expect(200);
    expect(basesRes.body.bases).toHaveLength(1);
    expect(basesRes.body.bases[0].name).toBe('My Base');

    // Verify tables were created
    const tablesRes = await request(app).get('/v0/meta/bases/appABC/tables').set(AUTH).expect(200);
    expect(tablesRes.body.tables).toHaveLength(1);
    expect(tablesRes.body.tables[0].name).toBe('Tasks');
    expect(tablesRes.body.tables[0].fields).toHaveLength(2);

    // Verify records were created
    const recordsRes = await request(app).get('/v0/appABC/tblXYZ').set(AUTH).expect(200);
    expect(recordsRes.body.records).toHaveLength(2);
    expect(recordsRes.body.records[0].fields.Name).toBe('Task 1');
    expect(recordsRes.body.records[0].id).toMatch(/^rec/);
    expect(recordsRes.body.records[0].createdTime).toBeDefined();
  });

  it('POST /test/reset clears all state', async () => {
    await request(app)
      .post('/test/setup')
      .send({ bases: [{ id: 'appABC', name: 'Base', permissionLevel: 'create' }] })
      .expect(200);

    await request(app).post('/test/reset').expect(200);

    const res = await request(app).get('/v0/meta/bases').set(AUTH).expect(200);
    expect(res.body.bases).toEqual([]);
  });
});

// ─── Meta Routes ─────────────────────────────────────────────────────────────

describe('GET /v0/meta/bases', () => {
  it('returns empty array when no bases exist', async () => {
    const res = await request(app).get('/v0/meta/bases').set(AUTH).expect(200);
    expect(res.body.bases).toEqual([]);
  });

  it('returns all bases', async () => {
    await request(app)
      .post('/test/setup')
      .send({
        bases: [
          { id: 'app1', name: 'Base 1', permissionLevel: 'create' },
          { id: 'app2', name: 'Base 2', permissionLevel: 'edit' },
        ],
      })
      .expect(200);

    const res = await request(app).get('/v0/meta/bases').set(AUTH).expect(200);
    expect(res.body.bases).toHaveLength(2);
  });
});

describe('GET /v0/meta/bases/:baseId/tables', () => {
  it('returns 404 for unknown base', async () => {
    const res = await request(app).get('/v0/meta/bases/appNONE/tables').set(AUTH).expect(404);
    expect(res.body.error.type).toBe('NOT_FOUND');
  });

  it('returns tables for a base', async () => {
    await request(app)
      .post('/test/setup')
      .send({
        bases: [{ id: 'appABC', name: 'Base', permissionLevel: 'create' }],
        tables: [
          {
            baseId: 'appABC',
            tables: [
              {
                id: 'tbl1',
                name: 'Table 1',
                primaryFieldId: 'fld1',
                fields: [{ id: 'fld1', name: 'Name', type: 'singleLineText' }],
                views: [],
              },
              {
                id: 'tbl2',
                name: 'Table 2',
                primaryFieldId: 'fld2',
                fields: [{ id: 'fld2', name: 'Title', type: 'singleLineText' }],
                views: [],
              },
            ],
          },
        ],
      })
      .expect(200);

    const res = await request(app).get('/v0/meta/bases/appABC/tables').set(AUTH).expect(200);
    expect(res.body.tables).toHaveLength(2);
    expect(res.body.tables[0].name).toBe('Table 1');
    expect(res.body.tables[1].name).toBe('Table 2');
  });
});

// ─── Records CRUD ────────────────────────────────────────────────────────────

function setupBaseAndTable() {
  return request(app)
    .post('/test/setup')
    .send({
      bases: [{ id: 'appABC', name: 'Base', permissionLevel: 'create' }],
      tables: [
        {
          baseId: 'appABC',
          tables: [
            {
              id: 'tblXYZ',
              name: 'Tasks',
              primaryFieldId: 'fldName',
              fields: [{ id: 'fldName', name: 'Name', type: 'singleLineText' }],
              views: [],
            },
          ],
        },
      ],
    });
}

describe('GET /v0/:baseId/:tableId (list records)', () => {
  beforeEach(() => setupBaseAndTable());

  it('returns empty records when table has no data', async () => {
    const res = await request(app).get('/v0/appABC/tblXYZ').set(AUTH).expect(200);
    expect(res.body.records).toEqual([]);
    expect(res.body.offset).toBeUndefined();
  });

  it('returns 404 for unknown table', async () => {
    const res = await request(app).get('/v0/appABC/tblNONE').set(AUTH).expect(404);
    expect(res.body.error.type).toBe('NOT_FOUND');
  });

  it('returns records with correct shape', async () => {
    await request(app)
      .post('/test/setup')
      .send({
        records: [{ baseId: 'appABC', tableId: 'tblXYZ', records: [{ fields: { Name: 'Hello' } }] }],
      })
      .expect(200);

    const res = await request(app).get('/v0/appABC/tblXYZ').set(AUTH).expect(200);
    expect(res.body.records).toHaveLength(1);
    expect(res.body.records[0]).toMatchObject({
      id: expect.stringMatching(/^rec/),
      fields: { Name: 'Hello' },
      createdTime: expect.any(String),
    });
  });

  it('paginates with offset when records exceed page size', async () => {
    // Seed 150 records (page size is 100)
    const records = Array.from({ length: 150 }, (_, i) => ({ fields: { Name: `Record ${i}` } }));
    await request(app)
      .post('/test/setup')
      .send({ records: [{ baseId: 'appABC', tableId: 'tblXYZ', records }] })
      .expect(200);

    // First page
    const page1 = await request(app).get('/v0/appABC/tblXYZ').set(AUTH).expect(200);
    expect(page1.body.records).toHaveLength(100);
    expect(page1.body.offset).toBeDefined();

    // Second page
    const page2 = await request(app)
      .get(`/v0/appABC/tblXYZ?offset=${page1.body.offset}`)
      .set(AUTH)
      .expect(200);
    expect(page2.body.records).toHaveLength(50);
    expect(page2.body.offset).toBeUndefined();
  });

  it('filters records with RECORD_ID() formula', async () => {
    // Create some records
    const createRes = await request(app)
      .post('/v0/appABC/tblXYZ')
      .set(AUTH)
      .send({ records: [{ fields: { Name: 'A' } }, { fields: { Name: 'B' } }, { fields: { Name: 'C' } }] })
      .expect(200);

    const [recA, , recC] = createRes.body.records;
    const formula = `OR(RECORD_ID()='${recA.id}',RECORD_ID()='${recC.id}')`;

    const res = await request(app)
      .get(`/v0/appABC/tblXYZ?filterByFormula=${encodeURIComponent(formula)}`)
      .set(AUTH)
      .expect(200);

    expect(res.body.records).toHaveLength(2);
    const names = res.body.records.map((r: any) => r.fields.Name);
    expect(names).toContain('A');
    expect(names).toContain('C');
    expect(names).not.toContain('B');
  });
});

describe('POST /v0/:baseId/:tableId (create records)', () => {
  beforeEach(() => setupBaseAndTable());

  it('creates records and returns them with IDs', async () => {
    const res = await request(app)
      .post('/v0/appABC/tblXYZ')
      .set(AUTH)
      .send({ records: [{ fields: { Name: 'New Task' } }] })
      .expect(200);

    expect(res.body.records).toHaveLength(1);
    expect(res.body.records[0].id).toMatch(/^rec/);
    expect(res.body.records[0].fields.Name).toBe('New Task');
    expect(res.body.records[0].createdTime).toBeDefined();

    // Verify it's actually stored
    const listRes = await request(app).get('/v0/appABC/tblXYZ').set(AUTH).expect(200);
    expect(listRes.body.records).toHaveLength(1);
  });

  it('creates multiple records in a batch', async () => {
    const res = await request(app)
      .post('/v0/appABC/tblXYZ')
      .set(AUTH)
      .send({
        records: [{ fields: { Name: 'Task 1' } }, { fields: { Name: 'Task 2' } }, { fields: { Name: 'Task 3' } }],
      })
      .expect(200);

    expect(res.body.records).toHaveLength(3);
    // Each should have a unique ID
    const ids = res.body.records.map((r: any) => r.id);
    expect(new Set(ids).size).toBe(3);
  });

  it('rejects batch larger than 10 records', async () => {
    const records = Array.from({ length: 11 }, (_, i) => ({ fields: { Name: `Task ${i}` } }));
    const res = await request(app).post('/v0/appABC/tblXYZ').set(AUTH).send({ records }).expect(422);
    expect(res.body.error.type).toBe('INVALID_REQUEST');
  });

  it('returns 404 for unknown table', async () => {
    const res = await request(app)
      .post('/v0/appABC/tblNONE')
      .set(AUTH)
      .send({ records: [{ fields: { Name: 'Task' } }] })
      .expect(404);
    expect(res.body.error.type).toBe('NOT_FOUND');
  });
});

describe('PATCH /v0/:baseId/:tableId (update records)', () => {
  beforeEach(() => setupBaseAndTable());

  it('updates record fields', async () => {
    // Create a record
    const createRes = await request(app)
      .post('/v0/appABC/tblXYZ')
      .set(AUTH)
      .send({ records: [{ fields: { Name: 'Original', Extra: 'keep' } }] })
      .expect(200);

    const recordId = createRes.body.records[0].id;

    // Update it
    const updateRes = await request(app)
      .patch('/v0/appABC/tblXYZ')
      .set(AUTH)
      .send({ records: [{ id: recordId, fields: { Name: 'Updated' } }] })
      .expect(200);

    expect(updateRes.body.records[0].fields.Name).toBe('Updated');
    // Shallow merge — other fields should be preserved
    expect(updateRes.body.records[0].fields.Extra).toBe('keep');
  });

  it('returns 404 for unknown record', async () => {
    const res = await request(app)
      .patch('/v0/appABC/tblXYZ')
      .set(AUTH)
      .send({ records: [{ id: 'recNONEXISTENT', fields: { Name: 'Nope' } }] })
      .expect(404);
    expect(res.body.error.type).toBe('NOT_FOUND');
  });

  it('rejects batch larger than 10 records', async () => {
    const records = Array.from({ length: 11 }, (_, i) => ({ id: `rec${i}`, fields: { Name: `Task ${i}` } }));
    const res = await request(app).patch('/v0/appABC/tblXYZ').set(AUTH).send({ records }).expect(422);
    expect(res.body.error.type).toBe('INVALID_REQUEST');
  });
});

describe('DELETE /v0/:baseId/:tableId (delete records)', () => {
  beforeEach(() => setupBaseAndTable());

  it('deletes records', async () => {
    // Create records
    const createRes = await request(app)
      .post('/v0/appABC/tblXYZ')
      .set(AUTH)
      .send({ records: [{ fields: { Name: 'Doomed' } }] })
      .expect(200);

    const recordId = createRes.body.records[0].id;

    // Delete
    const deleteRes = await request(app)
      .delete(`/v0/appABC/tblXYZ?records[]=${recordId}`)
      .set(AUTH)
      .expect(200);

    expect(deleteRes.body.records).toEqual([{ id: recordId, deleted: true }]);

    // Verify it's gone
    const listRes = await request(app).get('/v0/appABC/tblXYZ').set(AUTH).expect(200);
    expect(listRes.body.records).toHaveLength(0);
  });

  it('is idempotent — deleting a nonexistent record succeeds', async () => {
    const res = await request(app)
      .delete('/v0/appABC/tblXYZ?records[]=recNONEXISTENT')
      .set(AUTH)
      .expect(200);

    expect(res.body.records).toEqual([{ id: 'recNONEXISTENT', deleted: true }]);
  });

  it('deletes multiple records at once', async () => {
    const createRes = await request(app)
      .post('/v0/appABC/tblXYZ')
      .set(AUTH)
      .send({ records: [{ fields: { Name: 'A' } }, { fields: { Name: 'B' } }] })
      .expect(200);

    const [rec1, rec2] = createRes.body.records;

    const deleteRes = await request(app)
      .delete(`/v0/appABC/tblXYZ?records[]=${rec1.id}&records[]=${rec2.id}`)
      .set(AUTH)
      .expect(200);

    expect(deleteRes.body.records).toHaveLength(2);

    const listRes = await request(app).get('/v0/appABC/tblXYZ').set(AUTH).expect(200);
    expect(listRes.body.records).toHaveLength(0);
  });
});

// ─── Error Simulation ────────────────────────────────────────────────────────

describe('error simulation', () => {
  it('returns 429 with Retry-After when rate limit is simulated', async () => {
    await request(app).post('/test/simulate-rate-limit').send({ count: 2, retryAfterSeconds: 5 }).expect(200);

    // First request: rate limited
    const res1 = await request(app).get('/v0/meta/bases').set(AUTH).expect(429);
    expect(res1.headers['retry-after']).toBe('5');
    expect(res1.body.error.type).toBe('RATE_LIMIT_REACHED');

    // Second request: still rate limited
    const res2 = await request(app).get('/v0/meta/bases').set(AUTH).expect(429);
    expect(res2.headers['retry-after']).toBe('5');

    // Third request: back to normal
    await request(app).get('/v0/meta/bases').set(AUTH).expect(200);
  });

  it('returns queued error responses in order', async () => {
    await request(app)
      .post('/test/simulate-error')
      .send({ statusCode: 503, body: { error: 'Service unavailable' } })
      .expect(200);

    await request(app)
      .post('/test/simulate-error')
      .send({ statusCode: 500, body: { error: 'Internal server error' } })
      .expect(200);

    // First request gets first error
    const res1 = await request(app).get('/v0/meta/bases').set(AUTH).expect(503);
    expect(res1.body.error).toBe('Service unavailable');

    // Second request gets second error
    const res2 = await request(app).get('/v0/meta/bases').set(AUTH).expect(500);
    expect(res2.body.error).toBe('Internal server error');

    // Third request is normal
    await request(app).get('/v0/meta/bases').set(AUTH).expect(200);
  });

  it('does not apply error simulation to /test/ endpoints', async () => {
    await request(app).post('/test/simulate-rate-limit').send({ count: 100, retryAfterSeconds: 1 }).expect(200);

    // /test/reset should still work fine
    await request(app).post('/test/reset').expect(200);
  });
});
