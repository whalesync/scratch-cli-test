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
