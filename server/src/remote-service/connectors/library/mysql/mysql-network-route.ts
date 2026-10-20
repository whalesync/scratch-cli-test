/**
 * Where a MySQL connection's socket goes. Today mysql2 dials the user's host itself and nothing vets it (the same
 * as the Postgres and Supabase connectors), so a deployed environment can be pointed at an internal address.
 *
 * The seam for a shared database host guard (follow-up): it would resolve and vet the host (refusing loopback /
 * private / link-local / metadata addresses) and return a `createPinnedSocket` factory that dials the vetted IP
 * while mysql2 keeps `host` as the hostname for TLS SNI and certificate identity checks — closing the DNS-rebinding
 * gap. Only this body would change.
 */
import type net from 'node:net';

export interface MySqlNetworkRouteTarget {
  readonly host: string;
  readonly port: number;
}

export interface MySqlNetworkRoute {
  /** mysql2 `stream` factory. Undefined = mysql2 dials `host` itself. */
  readonly createPinnedSocket?: () => net.Socket;
}

export type ResolveMySqlNetworkRoute = (target: MySqlNetworkRouteTarget) => Promise<MySqlNetworkRoute>;

// eslint-disable-next-line @typescript-eslint/require-await, @typescript-eslint/no-unused-vars
export const resolveMySqlNetworkRoute: ResolveMySqlNetworkRoute = async (_target) => {
  return {};
};
