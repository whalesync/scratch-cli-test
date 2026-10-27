/**
 * Unit tests for the database host guard: `SsrfSafeSocket` against a real local TCP server, with `dns.lookup` mocked
 * so a "public" name can be made to resolve anywhere. The connectors' own use of it (Postgres, Supabase, MySQL) is
 * covered by their integration specs.
 */
import { promises as dns } from 'dns';
import { type AddressInfo, createServer, type Server, type Socket } from 'net';
import { SsrfError } from '../ssrf-address-guard';
import { DATABASE_HOST_REFUSED_PUBLIC_MESSAGE, isDatabaseHostGuardEnabled, SsrfSafeSocket } from '../ssrf-safe-socket';

describe('SsrfSafeSocket', () => {
  let lookupSpy: jest.SpyInstance;
  let localServer: Server;
  let localServerPort: number;
  let acceptedConnectionCount: number;

  beforeEach(async () => {
    lookupSpy = jest.spyOn(dns, 'lookup');
    acceptedConnectionCount = 0;
    localServer = createServer((acceptedSocket) => {
      acceptedConnectionCount++;
      acceptedSocket.destroy();
    });
    await new Promise<void>((resolve) => localServer.listen(0, '127.0.0.1', resolve));
    localServerPort = (localServer.address() as AddressInfo).port;
  });

  afterEach(async () => {
    lookupSpy.mockRestore();
    await new Promise<void>((resolve) => localServer.close(() => resolve()));
  });

  /** Connects the way node-postgres does and settles with the socket's error, or 'connected'. */
  function connectAndSettle(socket: Socket, ...connectArguments: [number, string] | [string]): Promise<unknown> {
    return new Promise((resolve) => {
      socket.once('connect', () => {
        socket.destroy();
        resolve('connected');
      });
      socket.once('error', resolve);
      if (connectArguments.length === 1) {
        socket.connect(connectArguments[0]);
      } else {
        socket.connect(connectArguments[0], connectArguments[1]);
      }
    });
  }

  it('refuses a literal private address without opening a connection or looking anything up', async () => {
    const settled = await connectAndSettle(new SsrfSafeSocket(), localServerPort, '127.0.0.1');

    expect(settled).toBeInstanceOf(SsrfError);
    expect((settled as SsrfError).code).toBe('private_address');
    expect(acceptedConnectionCount).toBe(0);
    expect(lookupSpy).not.toHaveBeenCalled();
  });

  it.each(['169.254.169.254', '10.0.0.5', '::1', '::ffff:127.0.0.1'])('refuses the literal address %s', async (ip) => {
    expect(await connectAndSettle(new SsrfSafeSocket(), localServerPort, ip)).toBeInstanceOf(SsrfError);
  });

  it('refuses a hostname that resolves to a private address, with a generic message and the address only in the internal details', async () => {
    lookupSpy.mockResolvedValue([{ address: '127.0.0.1', family: 4 }]);

    const settled = await connectAndSettle(new SsrfSafeSocket(), localServerPort, 'db.example.com');

    expect(settled).toBeInstanceOf(SsrfError);
    const refusal = settled as SsrfError;
    expect(refusal.message).toBe(DATABASE_HOST_REFUSED_PUBLIC_MESSAGE);
    expect(refusal.message).not.toContain('127.0.0.1');
    expect(refusal.message).not.toContain('db.example.com');
    expect(refusal.internalDetails).toContain('127.0.0.1');
    expect(acceptedConnectionCount).toBe(0);
  });

  it('refuses a hostname when any one of its addresses is private', async () => {
    lookupSpy.mockResolvedValue([
      { address: '192.0.2.10', family: 4 },
      { address: '10.1.2.3', family: 4 },
    ]);

    expect(await connectAndSettle(new SsrfSafeSocket(), localServerPort, 'mixed.example.com')).toBeInstanceOf(
      SsrfError,
    );
    expect(acceptedConnectionCount).toBe(0);
  });

  it("refuses a hostname that doesn't resolve, keeping the DNS error code for the logs", async () => {
    lookupSpy.mockRejectedValue(
      Object.assign(new Error('getaddrinfo ENOTFOUND nonexistent.invalid'), { code: 'ENOTFOUND' }),
    );

    const settled = await connectAndSettle(new SsrfSafeSocket(), localServerPort, 'nonexistent.invalid');

    expect(settled).toBeInstanceOf(SsrfError);
    expect((settled as SsrfError).code).toBe('unresolvable');
    expect((settled as SsrfError).dnsErrorCode).toBe('ENOTFOUND');
    expect((settled as SsrfError).message).toBe(DATABASE_HOST_REFUSED_PUBLIC_MESSAGE);
  });

  it('refuses a Unix socket path', async () => {
    expect(await connectAndSettle(new SsrfSafeSocket(), '/var/run/postgresql/.s.PGSQL.5432')).toBeInstanceOf(SsrfError);
  });

  it('connects to the address it vetted without resolving the name a second time', async () => {
    // A rebinding name: public for the first answer, our own server for every answer after it.
    lookupSpy
      .mockResolvedValueOnce([{ address: '192.0.2.10', family: 4 }])
      .mockResolvedValue([{ address: '127.0.0.1', family: 4 }]);
    const socket = new SsrfSafeSocket();
    const attemptedAddress = new Promise<string>((resolve) => {
      socket.once('connectionAttempt', (ip: string) => {
        // Node can't take a destroy from inside this event.
        setImmediate(() => socket.destroy());
        resolve(ip);
      });
    });

    socket.connect(localServerPort, 'db.example.com');

    expect(await attemptedAddress).toBe('192.0.2.10');
    expect(lookupSpy).toHaveBeenCalledTimes(1);
    expect(acceptedConnectionCount).toBe(0);
  });
});

describe('isDatabaseHostGuardEnabled', () => {
  const runningInCloudBeforeEachTest = process.env.RUNNING_IN_CLOUD;

  afterEach(() => {
    if (runningInCloudBeforeEachTest === undefined) {
      delete process.env.RUNNING_IN_CLOUD;
    } else {
      process.env.RUNNING_IN_CLOUD = runningInCloudBeforeEachTest;
    }
  });

  it('is on in deployed environments', () => {
    process.env.RUNNING_IN_CLOUD = 'true';
    expect(isDatabaseHostGuardEnabled()).toBe(true);
  });

  it('is off locally, where databases run on localhost', () => {
    delete process.env.RUNNING_IN_CLOUD;
    expect(isDatabaseHostGuardEnabled()).toBe(false);
  });
});
