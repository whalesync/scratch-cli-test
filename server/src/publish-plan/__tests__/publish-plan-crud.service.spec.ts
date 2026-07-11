import { BullEnqueuerService } from 'src/worker-enqueuer/bull-enqueuer.service';
import { DbService } from '../../db/db.service';
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
