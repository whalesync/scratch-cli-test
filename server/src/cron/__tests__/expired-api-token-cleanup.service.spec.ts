/* eslint-disable @typescript-eslint/unbound-method */
import { DbService } from 'src/db/db.service';
import { WSLogger } from 'src/logger';
import { ExpiredApiTokenCleanupService } from '../expired-api-token-cleanup.service';

describe('ExpiredApiTokenCleanupService', () => {
  let service: ExpiredApiTokenCleanupService;
  let dbService: jest.Mocked<DbService>;

  beforeEach(() => {
    jest.spyOn(WSLogger, 'info').mockImplementation();

    dbService = {
      client: {
        apiToken: {
          findMany: jest.fn(),
          deleteMany: jest.fn(),
        },
      },
    } as unknown as jest.Mocked<DbService>;

    service = new ExpiredApiTokenCleanupService(dbService);
  });

  afterEach(() => jest.clearAllMocks());

  it('deletes only expired WHALESYNC_SESSION tokens (expiresAt < now) and reports the total', async () => {
    (dbService.client.apiToken.findMany as jest.Mock).mockResolvedValueOnce([{ id: 'tok_1' }, { id: 'tok_2' }]);
    (dbService.client.apiToken.deleteMany as jest.Mock).mockResolvedValueOnce({ count: 2 });

    await service.cleanupExpiredWhalesyncSessionTokens();

    const findArgs = (dbService.client.apiToken.findMany as jest.Mock).mock.calls[0] as unknown[];
    const findWhere = (findArgs[0] as { where: { type: string; expiresAt: { lt: unknown } } }).where;
    expect(findWhere.type).toBe('WHALESYNC_SESSION');
    expect(findWhere.expiresAt.lt).toBeInstanceOf(Date);
    expect(dbService.client.apiToken.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: ['tok_1', 'tok_2'] } },
    });
  });

  it('is a no-op when there are no expired tokens', async () => {
    (dbService.client.apiToken.findMany as jest.Mock).mockResolvedValueOnce([]);

    await service.cleanupExpiredWhalesyncSessionTokens();

    expect(dbService.client.apiToken.deleteMany).not.toHaveBeenCalled();
    expect(WSLogger.info).not.toHaveBeenCalled();
  });

  it('loops across batches until the backlog is drained', async () => {
    const fullBatch = Array.from({ length: 1000 }, (_, i) => ({ id: `tok_${i}` }));
    (dbService.client.apiToken.findMany as jest.Mock)
      .mockResolvedValueOnce(fullBatch) // first full batch → keep going
      .mockResolvedValueOnce([{ id: 'tok_last' }]); // short batch → stop after deleting
    (dbService.client.apiToken.deleteMany as jest.Mock)
      .mockResolvedValueOnce({ count: 1000 })
      .mockResolvedValueOnce({ count: 1 });

    await service.cleanupExpiredWhalesyncSessionTokens();

    expect(dbService.client.apiToken.findMany).toHaveBeenCalledTimes(2);
    expect(dbService.client.apiToken.deleteMany).toHaveBeenCalledTimes(2);
    const logArgs = (WSLogger.info as jest.Mock).mock.calls[0] as unknown[];
    expect((logArgs[0] as { message: string }).message).toContain('1001');
  });
});
