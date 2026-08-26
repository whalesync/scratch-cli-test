import { BullEnqueuerService } from 'src/worker-enqueuer/bull-enqueuer.service';
import { DbService } from '../../db/db.service';
import { collapseFailedOperationsByPath } from '../failed-operations.util';
import { PublishPlanCrudService } from '../publish-plan-crud.service';

/**
 * Focused coverage for the Publish History list pagination (DEV-10708). The list
 * used to hard-code `take: 20` and return a bare array; it now pages server-side
 * and returns a `{ data, total, page, pageSize }` envelope.
 */
describe('PublishPlanCrudService.listPublishPlans', () => {
  let findMany: jest.Mock;
  let count: jest.Mock;
  let service: PublishPlanCrudService;

  beforeEach(() => {
    findMany = jest.fn().mockResolvedValue([]);
    count = jest.fn().mockResolvedValue(0);
    const db = {
      client: {
        publishPlan: { findMany, count },
        dbJob: { findMany: jest.fn().mockResolvedValue([]) },
      },
    } as unknown as DbService;
    const bull = { getJob: jest.fn().mockResolvedValue(null) } as unknown as BullEnqueuerService;
    service = new PublishPlanCrudService(db, bull);
  });

  it('defaults to page 1 with a page size of 20, newest first', async () => {
    count.mockResolvedValue(123);

    const result = await service.listPublishPlans('wb1');

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { workbookId: 'wb1', connectorAccountId: undefined },
        orderBy: { createdAt: 'desc' },
        skip: 0,
        take: 20,
      }),
    );
    expect(count).toHaveBeenCalledWith({ where: { workbookId: 'wb1', connectorAccountId: undefined } });
    expect(result).toEqual({ data: [], total: 123, page: 1, pageSize: 20 });
  });

  it('computes skip from page/pageSize and echoes them back', async () => {
    count.mockResolvedValue(200);

    const result = await service.listPublishPlans('wb1', { page: 3, pageSize: 10 });

    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ skip: 20, take: 10 }));
    expect(result).toMatchObject({ total: 200, page: 3, pageSize: 10 });
  });

  it('caps the page size at 100', async () => {
    const result = await service.listPublishPlans('wb1', { pageSize: 500 });

    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 100 }));
    expect(result.pageSize).toBe(100);
  });

  it('filters by connectorAccountId when provided', async () => {
    await service.listPublishPlans('wb1', { connectorAccountId: 'conn-42' });

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { workbookId: 'wb1', connectorAccountId: 'conn-42' } }),
    );
    expect(count).toHaveBeenCalledWith({ where: { workbookId: 'wb1', connectorAccountId: 'conn-42' } });
  });
});

/**
 * DEV-10756: the COMPLETE, uncapped failed-operations set that the post-publish
 * reconcile fetches (as opposed to the run-job's capped `publicProgress`
 * `failedOperations`). The bug being fixed was a 20-record display cap consumed
 * as if it were the full rejection set, so the load-bearing assertions here are
 * that the list is NOT capped at 20 and that the `failed-batch` status filter
 * (not `hasError`) is used.
 */
describe('PublishPlanCrudService.listFailedPublishPlanOperations', () => {
  let findManyOperations: jest.Mock;

  const makeService = (rows: unknown[]): PublishPlanCrudService => {
    findManyOperations = jest.fn().mockResolvedValue(rows);
    const db = { client: { publishPlanOperation: { findMany: findManyOperations } } } as unknown as DbService;
    const bull = {} as unknown as BullEnqueuerService;
    return new PublishPlanCrudService(db, bull);
  };

  const failedRows = (count: number, phase = 'edits') =>
    Array.from({ length: count }, (_, i) => ({
      filePath: `Folder/rec-${String(i).padStart(2, '0')}.json`,
      phase,
      error: `rejected ${i}`,
    }));

  it('queries only failed-batch operations for the plan, ordered by filePath', async () => {
    const service = makeService([]);

    await service.listFailedPublishPlanOperations('plan-1');

    expect(findManyOperations).toHaveBeenCalledWith({
      where: { planId: 'plan-1', status: 'failed-batch' },
      select: { filePath: true, phase: true, error: true },
      orderBy: { filePath: 'asc' },
    });
  });

  it('returns every distinct failed record — uncapped past the 20-record display cap', async () => {
    const service = makeService(failedRows(25));

    const result = await service.listFailedPublishPlanOperations('plan-1');

    // The whole point of the fix: 25 > the summary cap of 20, yet all 25 come back.
    expect(result.total).toBe(25);
    expect(result.data).toHaveLength(25);
    expect(result.data[0]).toEqual({ filePath: 'Folder/rec-00.json', phase: 'edits', error: 'rejected 0' });
  });

  it('paginates the collapsed list (default page size 50, cap 200)', async () => {
    const service = makeService(failedRows(25));

    const page1 = await service.listFailedPublishPlanOperations('plan-1', { page: 1, pageSize: 20 });
    expect(page1).toMatchObject({ total: 25, page: 1, pageSize: 20 });
    expect(page1.data).toHaveLength(20);

    const page2 = await service.listFailedPublishPlanOperations('plan-1', { page: 2, pageSize: 20 });
    expect(page2.data).toHaveLength(5);
    expect(page2.data[0].filePath).toBe('Folder/rec-20.json');

    const capped = await service.listFailedPublishPlanOperations('plan-1', { pageSize: 5000 });
    expect(capped.pageSize).toBe(200);
  });

  it('collapses multiple failed rows for one record, preferring the non-rename phase', async () => {
    // Rename row seen first — the connector rejection must still win.
    const service = makeService([
      { filePath: 'Folder/rec.json', phase: 'rename-files', error: 'rename failed' },
      { filePath: 'Folder/rec.json', phase: 'edits', error: 'connector rejected' },
    ]);

    const result = await service.listFailedPublishPlanOperations('plan-1');

    expect(result.total).toBe(1);
    expect(result.data).toEqual([{ filePath: 'Folder/rec.json', phase: 'edits', error: 'connector rejected' }]);
  });
});

describe('PublishPlanCrudService.listSucceededPublishPlanOperations', () => {
  let findManyOperations: jest.Mock;

  const makeService = (rows: unknown[]): PublishPlanCrudService => {
    findManyOperations = jest.fn().mockResolvedValue(rows);
    const db = { client: { publishPlanOperation: { findMany: findManyOperations } } } as unknown as DbService;
    const bull = {} as unknown as BullEnqueuerService;
    return new PublishPlanCrudService(db, bull);
  };

  // The query already collapses via `distinct: ['filePath']`, so the mock returns
  // one row per distinct path (unlike the failed spec, which collapses in code).
  const succeededRows = (count: number) =>
    Array.from({ length: count }, (_, i) => ({
      filePath: `Folder/rec-${String(i).padStart(2, '0')}.json`,
    }));

  it('queries only success operations for the plan, distinct by filePath, ordered by filePath', async () => {
    const service = makeService([]);

    await service.listSucceededPublishPlanOperations('plan-1');

    expect(findManyOperations).toHaveBeenCalledWith({
      where: { planId: 'plan-1', status: 'success' },
      select: { filePath: true },
      distinct: ['filePath'],
      orderBy: { filePath: 'asc' },
    });
  });

  it('returns every distinct succeeded record as { filePath } entries', async () => {
    const service = makeService(succeededRows(250));

    const result = await service.listSucceededPublishPlanOperations('plan-1', { pageSize: 500 });

    expect(result.total).toBe(250);
    expect(result.data).toHaveLength(250);
    expect(result.data[0]).toEqual({ filePath: 'Folder/rec-00.json' });
  });

  it('paginates (default page size 200, cap 500)', async () => {
    const service = makeService(succeededRows(250));

    const page1 = await service.listSucceededPublishPlanOperations('plan-1');
    expect(page1).toMatchObject({ total: 250, page: 1, pageSize: 200 });
    expect(page1.data).toHaveLength(200);

    const page2 = await service.listSucceededPublishPlanOperations('plan-1', { page: 2, pageSize: 200 });
    expect(page2.data).toHaveLength(50);
    expect(page2.data[0].filePath).toBe('Folder/rec-200.json');

    const capped = await service.listSucceededPublishPlanOperations('plan-1', { pageSize: 5000 });
    expect(capped.pageSize).toBe(500);
  });
});

describe('collapseFailedOperationsByPath', () => {
  it('keeps one entry per path, preferring a non-rename phase regardless of row order', () => {
    const collapsed = collapseFailedOperationsByPath([
      { filePath: 'a.json', phase: 'rename-files', error: 'rename a' },
      { filePath: 'a.json', phase: 'edits', error: 'reject a' },
      { filePath: 'b.json', phase: 'creates', error: null },
    ]);

    expect(collapsed).toEqual([
      { filePath: 'a.json', phase: 'edits', error: 'reject a' },
      { filePath: 'b.json', phase: 'creates', error: null },
    ]);
  });

  it('does not overwrite an already-primary phase with a later rename row', () => {
    const collapsed = collapseFailedOperationsByPath([
      { filePath: 'a.json', phase: 'edits', error: 'reject a' },
      { filePath: 'a.json', phase: 'rename-files', error: 'rename a' },
    ]);

    expect(collapsed).toEqual([{ filePath: 'a.json', phase: 'edits', error: 'reject a' }]);
  });
});

/**
 * DEV-11208: the dev-tools index endpoints (file / ref / asset) used to read a
 * workbook's ENTIRE index into one response (no take/skip). They now page
 * server-side and return a `{ data, total, page, pageSize }` envelope, mirroring
 * `listPublishPlans` — default page size 100, capped at 500.
 */
describe('PublishPlanCrudService index pagination (DEV-11208)', () => {
  const makeService = (model: 'fileIndex' | 'fileReference' | 'asset') => {
    const findMany = jest.fn().mockResolvedValue([]);
    const count = jest.fn().mockResolvedValue(0);
    const db = { client: { [model]: { findMany, count } } } as unknown as DbService;
    const service = new PublishPlanCrudService(db, {} as unknown as BullEnqueuerService);
    return { service, findMany, count };
  };

  it('listFileIndex: defaults to page 1 / pageSize 100, newest folder+filename order, envelope shape', async () => {
    const { service, findMany, count } = makeService('fileIndex');
    count.mockResolvedValue(250);

    const result = await service.listFileIndex('wb1');

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { workbookId: 'wb1' },
        orderBy: [{ folderPath: 'asc' }, { filename: 'asc' }],
        skip: 0,
        take: 100,
      }),
    );
    expect(count).toHaveBeenCalledWith({ where: { workbookId: 'wb1' } });
    expect(result).toEqual({ data: [], total: 250, page: 1, pageSize: 100 });
  });

  it('listFileIndex: computes skip from page/pageSize and caps the page size at 500', async () => {
    const { service, findMany } = makeService('fileIndex');

    await service.listFileIndex('wb1', { page: 4, pageSize: 25 });
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ skip: 75, take: 25 }));

    const capped = await service.listFileIndex('wb1', { pageSize: 5000 });
    expect(capped.pageSize).toBe(500);
  });

  it('listRefIndex: paginates ordered by sourceFilePath and echoes the page back', async () => {
    const { service, findMany, count } = makeService('fileReference');
    count.mockResolvedValue(3);

    const result = await service.listRefIndex('wb1', { page: 2, pageSize: 50 });

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { workbookId: 'wb1' },
        orderBy: [{ sourceFilePath: 'asc' }],
        skip: 50,
        take: 50,
      }),
    );
    expect(result).toMatchObject({ total: 3, page: 2, pageSize: 50 });
  });

  it('listAssetIndex: scopes the page query AND the count by dataFolderId, and maps BigInt size to number', async () => {
    const { service, findMany, count } = makeService('asset');
    findMany.mockResolvedValue([
      { id: 'a1', size: BigInt(2048) },
      { id: 'a2', size: null },
    ]);
    count.mockResolvedValue(2);

    const result = await service.listAssetIndex('wb1', { dataFolderId: 'df1', page: 1, pageSize: 100 });

    const expectedWhere = { workbookId: 'wb1', dataFolderId: 'df1' };
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expectedWhere,
        orderBy: [{ service: 'asc' }, { lastSeenAt: 'desc' }],
        skip: 0,
        take: 100,
      }),
    );
    expect(count).toHaveBeenCalledWith({ where: expectedWhere });
    expect(result.total).toBe(2);
    expect(result.data).toEqual([
      { id: 'a1', size: 2048 },
      { id: 'a2', size: null },
    ]);
    expect(typeof result.data[0].size).toBe('number');
  });

  it('listAssetIndex: omits the dataFolderId filter when none is provided', async () => {
    const { service, findMany, count } = makeService('asset');

    await service.listAssetIndex('wb1');

    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { workbookId: 'wb1' } }));
    expect(count).toHaveBeenCalledWith({ where: { workbookId: 'wb1' } });
  });
});
