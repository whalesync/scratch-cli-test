import { SsrfError } from '../../../utils/ssrf-address-guard';
import { SsrfSafeSocket } from '../../../utils/ssrf-safe-socket';
import { resolveMySqlNetworkRoute } from '../mysql-network-route';

describe('resolveMySqlNetworkRoute', () => {
  const runningInCloudBeforeEachTest = process.env.RUNNING_IN_CLOUD;

  afterEach(() => {
    if (runningInCloudBeforeEachTest === undefined) {
      delete process.env.RUNNING_IN_CLOUD;
    } else {
      process.env.RUNNING_IN_CLOUD = runningInCloudBeforeEachTest;
    }
  });

  it('lets mysql2 dial the host itself locally', async () => {
    delete process.env.RUNNING_IN_CLOUD;
    await expect(resolveMySqlNetworkRoute({ host: '127.0.0.1', port: 3306 })).resolves.toEqual({});
  });

  it('hands mysql2 a socket that is already connecting through the database host guard in deployed environments', async () => {
    process.env.RUNNING_IN_CLOUD = 'true';

    const networkRoute = await resolveMySqlNetworkRoute({ host: '127.0.0.1', port: 3306 });
    expect(networkRoute.createPinnedSocket).toBeDefined();
    const socket = networkRoute.createPinnedSocket?.();

    expect(socket).toBeInstanceOf(SsrfSafeSocket);
    // mysql2 listens for errors right after its factory call returns; the refusal arrives on a later tick.
    const refusal = await new Promise<unknown>((resolve) => socket?.once('error', resolve));
    expect(refusal).toBeInstanceOf(SsrfError);
    expect((refusal as SsrfError).internalDetails).toContain('127.0.0.1');
  });
});
