/* eslint-disable @typescript-eslint/unbound-method */
import { DbService } from '../../db/db.service';
import { RecreatedIdMapService } from '../recreated-id-map.service';

/**
 * Build an in-memory stub of the Prisma `RecreatedIdMap` table behind a
 * `DbService`-shaped object. Backs the upsert/findUnique/findMany surface used
 * by `RecreatedIdMapService` with a `Map` keyed on the unique composite. Tests
 * call `seed()` to populate rows up front and inspect `.entries` to assert
 * post-conditions.
 */
function makeStubDb() {
  type Row = {
    id: string;
    workbookId: string;
    connectorAccountId: string;
    folder: string;
    priorRemoteId: string;
    newRemoteId: string;
    settledAt: Date;
  };
  const rows = new Map<string, Row>();
  const key = (r: Pick<Row, 'workbookId' | 'connectorAccountId' | 'folder' | 'priorRemoteId'>) =>
    `${r.workbookId}|${r.connectorAccountId}|${r.folder}|${r.priorRemoteId}`;
  let nextId = 0;

  const db = {
    client: {
      recreatedIdMap: {
        upsert: jest.fn(
          ({
            where,
            create,
            update,
          }: {
            where: {
              workbookId_connectorAccountId_folder_priorRemoteId: Pick<
                Row,
                'workbookId' | 'connectorAccountId' | 'folder' | 'priorRemoteId'
              >;
            };
            create: Omit<Row, 'id' | 'settledAt'>;
            update: { newRemoteId: string; settledAt: Date };
          }) => {
            const k = key(where.workbookId_connectorAccountId_folder_priorRemoteId);
            const existing = rows.get(k);
            if (existing) {
              rows.set(k, { ...existing, ...update });
            } else {
              rows.set(k, { id: `r${nextId++}`, settledAt: new Date(), ...create });
            }
            return Promise.resolve(rows.get(k));
          },
        ),
        findUnique: jest.fn(
          ({
            where,
          }: {
            where: {
              workbookId_connectorAccountId_folder_priorRemoteId: Pick<
                Row,
                'workbookId' | 'connectorAccountId' | 'folder' | 'priorRemoteId'
              >;
            };
            select?: Record<string, boolean>;
          }) => {
            const r = rows.get(key(where.workbookId_connectorAccountId_folder_priorRemoteId));
            return Promise.resolve(r ?? null);
          },
        ),
        findMany: jest.fn(),
        deleteMany: jest.fn(({ where }: { where: { workbookId: string } }) => {
          let count = 0;
          for (const [k, v] of rows) {
            if (v.workbookId === where.workbookId) {
              rows.delete(k);
              count++;
            }
          }
          return Promise.resolve({ count });
        }),
      },
      dataFolder: {
        findMany: jest.fn(),
      },
    },
  } as unknown as DbService;

  return {
    db,
    rows,
    seed(row: Omit<Row, 'id' | 'settledAt'>) {
      rows.set(key(row), { id: `seeded-${nextId++}`, settledAt: new Date(), ...row });
    },
  };
}

const WORKBOOK = 'wkb_t';
const CONNECTOR = 'coa_t';
const FOLDER = 'public/projects';

describe('RecreatedIdMapService', () => {
  describe('upsert', () => {
    it('inserts a new mapping when the (workbook, account, folder, prior) tuple is new', async () => {
      const { db, rows } = makeStubDb();
      const svc = new RecreatedIdMapService(db);

      await svc.upsert({
        workbookId: WORKBOOK,
        connectorAccountId: CONNECTOR,
        folder: FOLDER,
        priorRemoteId: '5',
        newRemoteId: '105',
      });

      expect(rows.size).toBe(1);
      const [row] = [...rows.values()];
      expect(row.priorRemoteId).toBe('5');
      expect(row.newRemoteId).toBe('105');
    });

    it('overwrites newRemoteId when the same prior id is upserted again', async () => {
      // Same record deleted-and-recreated more than once before the dispatch
      // loop saw the prior mapping. Newer id wins.
      const { db, rows, seed } = makeStubDb();
      seed({
        workbookId: WORKBOOK,
        connectorAccountId: CONNECTOR,
        folder: FOLDER,
        priorRemoteId: '5',
        newRemoteId: '105',
      });
      const svc = new RecreatedIdMapService(db);

      await svc.upsert({
        workbookId: WORKBOOK,
        connectorAccountId: CONNECTOR,
        folder: FOLDER,
        priorRemoteId: '5',
        newRemoteId: '205',
      });

      expect(rows.size).toBe(1);
      const [row] = [...rows.values()];
      expect(row.newRemoteId).toBe('205');
    });
  });

  describe('resolveLatest', () => {
    it('returns null when the prior id has no mapping at all', async () => {
      // No mapping → caller should leave the FK literal alone (live FK, not
      // a stale revert reference).
      const { db } = makeStubDb();
      const svc = new RecreatedIdMapService(db);

      const result = await svc.resolveLatest({
        workbookId: WORKBOOK,
        connectorAccountId: CONNECTOR,
        folder: FOLDER,
        priorRemoteId: '5',
      });

      expect(result).toBeNull();
    });

    it('returns the direct new id when a single hop exists', async () => {
      const { db, seed } = makeStubDb();
      seed({
        workbookId: WORKBOOK,
        connectorAccountId: CONNECTOR,
        folder: FOLDER,
        priorRemoteId: '5',
        newRemoteId: '105',
      });
      const svc = new RecreatedIdMapService(db);

      const result = await svc.resolveLatest({
        workbookId: WORKBOOK,
        connectorAccountId: CONNECTOR,
        folder: FOLDER,
        priorRemoteId: '5',
      });

      expect(result).toBe('105');
    });

    it('chain-follows through multiple recreate cycles to the latest id', async () => {
      // Project 5 was deleted+revived as 105, then 105 was deleted+revived
      // as 205. A FK pointing at the original `5` must resolve to `205`,
      // not `105` — the intermediate id is also gone.
      const { db, seed } = makeStubDb();
      seed({
        workbookId: WORKBOOK,
        connectorAccountId: CONNECTOR,
        folder: FOLDER,
        priorRemoteId: '5',
        newRemoteId: '105',
      });
      seed({
        workbookId: WORKBOOK,
        connectorAccountId: CONNECTOR,
        folder: FOLDER,
        priorRemoteId: '105',
        newRemoteId: '205',
      });
      const svc = new RecreatedIdMapService(db);

      const result = await svc.resolveLatest({
        workbookId: WORKBOOK,
        connectorAccountId: CONNECTOR,
        folder: FOLDER,
        priorRemoteId: '5',
      });

      expect(result).toBe('205');
    });

    it('terminates with the last visited id when the chain forms a cycle', async () => {
      // Defensive: shouldn't happen in practice (each new id is connector-
      // assigned and unique), but a corrupted remap with a cycle must not
      // hang the publish job. The cycle-guard returns the id where we
      // detected the loop.
      const { db, seed } = makeStubDb();
      seed({
        workbookId: WORKBOOK,
        connectorAccountId: CONNECTOR,
        folder: FOLDER,
        priorRemoteId: 'A',
        newRemoteId: 'B',
      });
      seed({
        workbookId: WORKBOOK,
        connectorAccountId: CONNECTOR,
        folder: FOLDER,
        priorRemoteId: 'B',
        newRemoteId: 'C',
      });
      seed({
        workbookId: WORKBOOK,
        connectorAccountId: CONNECTOR,
        folder: FOLDER,
        priorRemoteId: 'C',
        newRemoteId: 'A',
      });
      const svc = new RecreatedIdMapService(db);

      const result = await svc.resolveLatest({
        workbookId: WORKBOOK,
        connectorAccountId: CONNECTOR,
        folder: FOLDER,
        priorRemoteId: 'A',
      });

      // A → B → C → A (cycle detected at A again). Returns the id where the
      // cycle closed; the warn-log carries the diagnostic.
      expect(result).toBe('A');
    });

    it('scopes the lookup to (workbook, account, folder) — same prior in a different scope is a miss', async () => {
      // Two workbooks each have a project with prior id `5` that got
      // recreated. Lookups in workbook A must not see workbook B's row.
      const { db, seed } = makeStubDb();
      seed({
        workbookId: 'wkb_A',
        connectorAccountId: CONNECTOR,
        folder: FOLDER,
        priorRemoteId: '5',
        newRemoteId: '105',
      });
      seed({
        workbookId: 'wkb_B',
        connectorAccountId: CONNECTOR,
        folder: FOLDER,
        priorRemoteId: '5',
        newRemoteId: '999',
      });
      const svc = new RecreatedIdMapService(db);

      const a = await svc.resolveLatest({
        workbookId: 'wkb_A',
        connectorAccountId: CONNECTOR,
        folder: FOLDER,
        priorRemoteId: '5',
      });
      const b = await svc.resolveLatest({
        workbookId: 'wkb_B',
        connectorAccountId: CONNECTOR,
        folder: FOLDER,
        priorRemoteId: '5',
      });

      expect(a).toBe('105');
      expect(b).toBe('999');
    });
  });

  describe('resolveLatestBatch', () => {
    it('returns only the prior ids that resolved to a different new id', async () => {
      // `5` has a mapping, `7` doesn't. Output should only carry `5 → 105`;
      // `7` is omitted (caller treats absence as "leave literal alone").
      const { db, seed } = makeStubDb();
      seed({
        workbookId: WORKBOOK,
        connectorAccountId: CONNECTOR,
        folder: FOLDER,
        priorRemoteId: '5',
        newRemoteId: '105',
      });
      const svc = new RecreatedIdMapService(db);

      const result = await svc.resolveLatestBatch({
        workbookId: WORKBOOK,
        connectorAccountId: CONNECTOR,
        folder: FOLDER,
        priorRemoteIds: ['5', '7'],
      });

      expect(result.size).toBe(1);
      expect(result.get('5')).toBe('105');
      expect(result.has('7')).toBe(false);
    });
  });

  describe('resolveFkTargetFolders', () => {
    it('matches DataFolder.path that ends with /<linkedTableId>', async () => {
      // Postgres connector: FK schema's `linkedTableId = "authors"` (table
      // name only, no schema qualifier). DataFolder.path = "/public/authors".
      // Suffix match on `/authors` → folder = "public/authors" (leading
      // slash stripped to match how the CLI patch paths are stored).
      const { db } = makeStubDb();
      (db.client.dataFolder.findMany as jest.Mock).mockResolvedValue([
        { path: '/public/authors', tableId: ['public', 'authors'] },
      ]);
      const svc = new RecreatedIdMapService(db);

      const result = await svc.resolveFkTargetFolders({
        workbookId: WORKBOOK,
        connectorAccountId: CONNECTOR,
        linkedTableIds: ['authors'],
      });

      expect(result.get('authors')).toBe('public/authors');
    });

    it('matches via the dotted variant when linkedTableId carries a schema qualifier', async () => {
      // Postgres connector: when the FK target is in a non-public schema,
      // linkedTableId looks like "myschema.authors". Match by replacing
      // dots with slashes so the suffix matches the on-disk path.
      const { db } = makeStubDb();
      (db.client.dataFolder.findMany as jest.Mock).mockResolvedValue([
        { path: '/myschema/authors', tableId: ['myschema', 'authors'] },
      ]);
      const svc = new RecreatedIdMapService(db);

      const result = await svc.resolveFkTargetFolders({
        workbookId: WORKBOOK,
        connectorAccountId: CONNECTOR,
        linkedTableIds: ['myschema.authors'],
      });

      expect(result.get('myschema.authors')).toBe('myschema/authors');
    });

    it('skips ambiguous matches (multiple folders ending with the same suffix)', async () => {
      // Two folders end with `/authors` — we can't pick one. Skip the
      // rewrite for this FK target rather than picking the wrong folder
      // and silently corrupting data. The service logs a warning; the
      // caller's FK rewrite leaves the literal alone.
      const { db } = makeStubDb();
      (db.client.dataFolder.findMany as jest.Mock).mockResolvedValue([
        { path: '/public/authors', tableId: ['public', 'authors'] },
        { path: '/other/authors', tableId: ['other', 'authors'] },
      ]);
      const svc = new RecreatedIdMapService(db);

      const result = await svc.resolveFkTargetFolders({
        workbookId: WORKBOOK,
        connectorAccountId: CONNECTOR,
        linkedTableIds: ['authors'],
      });

      expect(result.has('authors')).toBe(false);
    });

    it('returns an empty map when no DataFolder matches the linkedTableId', async () => {
      const { db } = makeStubDb();
      (db.client.dataFolder.findMany as jest.Mock).mockResolvedValue([
        { path: '/public/posts', tableId: ['public', 'posts'] },
      ]);
      const svc = new RecreatedIdMapService(db);

      const result = await svc.resolveFkTargetFolders({
        workbookId: WORKBOOK,
        connectorAccountId: CONNECTOR,
        linkedTableIds: ['authors'],
      });

      expect(result.size).toBe(0);
    });
  });

  describe('deleteForWorkbook', () => {
    it('removes all rows for the workbook regardless of connector or folder', async () => {
      const { db, rows, seed } = makeStubDb();
      seed({
        workbookId: 'wkb_A',
        connectorAccountId: 'coa_1',
        folder: 'public/x',
        priorRemoteId: '1',
        newRemoteId: '11',
      });
      seed({
        workbookId: 'wkb_A',
        connectorAccountId: 'coa_2',
        folder: 'public/y',
        priorRemoteId: '2',
        newRemoteId: '22',
      });
      seed({
        workbookId: 'wkb_B',
        connectorAccountId: 'coa_1',
        folder: 'public/x',
        priorRemoteId: '3',
        newRemoteId: '33',
      });
      const svc = new RecreatedIdMapService(db);

      await svc.deleteForWorkbook('wkb_A');

      // Only wkb_B's row survives.
      expect(rows.size).toBe(1);
      const [row] = [...rows.values()];
      expect(row.workbookId).toBe('wkb_B');
    });
  });
});
