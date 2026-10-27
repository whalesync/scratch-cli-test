/**
 * Where a MySQL connection's socket goes. In deployed environments mysql2 connects through the database host guard
 * (`SsrfSafeSocket`), which refuses loopback / private / link-local / metadata addresses after its own DNS lookup and
 * connects only to the addresses it vetted, so a user's host can't point the connection inside our network (and a
 * name can't be rebound to a private address between the check and the connect). mysql2 keeps `host` as the
 * hostname, so TLS SNI and VERIFY_IDENTITY still check the real name. Locally (see `isDatabaseHostGuardEnabled`),
 * mysql2 dials the host itself.
 *
 * A refusal fails the connect with an `SsrfError`, whose `internalDetails` the error mapper logs and never shows.
 */
import type net from 'node:net';
import { isDatabaseHostGuardEnabled, SsrfSafeSocket } from '../../utils/ssrf-safe-socket';

export interface MySqlNetworkRouteTarget {
  readonly host: string;
  readonly port: number;
}

export interface MySqlNetworkRoute {
  /** mysql2 `stream` factory. Undefined = mysql2 dials `host` itself. */
  readonly createPinnedSocket?: () => net.Socket;
}

export type ResolveMySqlNetworkRoute = (target: MySqlNetworkRouteTarget) => Promise<MySqlNetworkRoute>;

// eslint-disable-next-line @typescript-eslint/require-await
export const resolveMySqlNetworkRoute: ResolveMySqlNetworkRoute = async (target) => {
  if (!isDatabaseHostGuardEnabled()) {
    return {};
  }
  return { createPinnedSocket: () => connectMySqlSocketThroughDatabaseHostGuard(target) };
};

/**
 * mysql2 uses a socket it's given as is: it neither connects it nor sets the TCP options it sets on its own sockets.
 * So this connects it and applies mysql2's defaults (`setNoDelay`, and keep-alive once connected). It must run inside
 * mysql2's own call to the factory: mysql2 attaches its error handler right after, and a refused host fails on a later
 * tick.
 */
function connectMySqlSocketThroughDatabaseHostGuard(target: MySqlNetworkRouteTarget): net.Socket {
  const socketThroughDatabaseHostGuard = new SsrfSafeSocket();
  socketThroughDatabaseHostGuard.setNoDelay(true);
  socketThroughDatabaseHostGuard.once('connect', () => socketThroughDatabaseHostGuard.setKeepAlive(true));
  return socketThroughDatabaseHostGuard.connect(target.port, target.host);
}
