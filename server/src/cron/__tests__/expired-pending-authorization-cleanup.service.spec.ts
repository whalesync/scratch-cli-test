/* eslint-disable @typescript-eslint/unbound-method */
import { DbService } from 'src/db/db.service';
import { WSLogger } from 'src/logger';
import { ExpiredPendingAuthorizationCleanupService } from '../expired-pending-authorization-cleanup.service';

const FIXED_NOW = new Date('2026-10-30T12:00:00.000Z');
const ONE_HOUR_BEFORE_FIXED_NOW = new Date('2026-10-30T11:00:00.000Z');

describe('ExpiredPendingAuthorizationCleanupService', () => {
  let service: ExpiredPendingAuthorizationCleanupService;
  let dbService: jest.Mocked<DbService>;
  let pendingOAuthInstallDeleteMany: jest.Mock;
  let authorizationCodeDeleteMany: jest.Mock;

  beforeEach(() => {
    jest.useFakeTimers({ now: FIXED_NOW });
    jest.spyOn(WSLogger, 'info').mockImplementation();
    jest.spyOn(WSLogger, 'warn').mockImplementation();

    pendingOAuthInstallDeleteMany = jest.fn().mockResolvedValue({ count: 0 });
    authorizationCodeDeleteMany = jest.fn().mockResolvedValue({ count: 0 });
    dbService = {
      client: {
        pendingOAuthInstall: { deleteMany: pendingOAuthInstallDeleteMany },
        authorizationCode: { deleteMany: authorizationCodeDeleteMany },
      },
    } as unknown as jest.Mocked<DbService>;

    service = new ExpiredPendingAuthorizationCleanupService(dbService);
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('deletes rows from both tables that expired more than an hour ago, keeping rows inside the grace period', async () => {
    pendingOAuthInstallDeleteMany.mockResolvedValueOnce({ count: 2 });
    authorizationCodeDeleteMany.mockResolvedValueOnce({ count: 254 });

    await service.deleteExpiredPendingOAuthInstallsAndCliAuthorizationCodes();

    expect(pendingOAuthInstallDeleteMany).toHaveBeenCalledWith({
      where: { expiresAt: { lt: ONE_HOUR_BEFORE_FIXED_NOW } },
    });
    expect(authorizationCodeDeleteMany).toHaveBeenCalledWith({
      where: { expiresAt: { lt: ONE_HOUR_BEFORE_FIXED_NOW } },
    });
    const loggedMessages = (WSLogger.info as jest.Mock).mock.calls.map(
      (call: unknown[]) => (call[0] as { message: string }).message,
    );
    expect(loggedMessages).toEqual([
      'Deleted 2 expired PendingOAuthInstall row(s) (cutoff: 2026-10-30T11:00:00.000Z)',
      'Deleted 254 expired AuthorizationCode row(s) (cutoff: 2026-10-30T11:00:00.000Z)',
    ]);
  });

  it('logs nothing when neither table has expired rows', async () => {
    await service.deleteExpiredPendingOAuthInstallsAndCliAuthorizationCodes();

    expect(pendingOAuthInstallDeleteMany).toHaveBeenCalledTimes(1);
    expect(authorizationCodeDeleteMany).toHaveBeenCalledTimes(1);
    expect(WSLogger.info).not.toHaveBeenCalled();
    expect(WSLogger.warn).not.toHaveBeenCalled();
  });

  it('still sweeps the second table when the first fails, then throws so the failure surfaces', async () => {
    pendingOAuthInstallDeleteMany.mockRejectedValueOnce(new Error('connection reset'));
    authorizationCodeDeleteMany.mockResolvedValueOnce({ count: 3 });

    await expect(service.deleteExpiredPendingOAuthInstallsAndCliAuthorizationCodes()).rejects.toThrow(
      'Failed to delete expired rows from: PendingOAuthInstall',
    );

    expect(authorizationCodeDeleteMany).toHaveBeenCalledTimes(1);
    expect(WSLogger.warn).toHaveBeenCalledTimes(1);
    expect(WSLogger.info).toHaveBeenCalledTimes(1);
  });
});
