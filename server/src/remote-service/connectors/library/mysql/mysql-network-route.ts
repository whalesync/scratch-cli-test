/**
 * Where a MySQL connection's socket goes. The seam for the shared database host guard (separate MR): once it
 * lands, this resolves and vets the host (refusing loopback / private / link-local / metadata addresses) and
 * returns a `createPinnedSocket` factory that dials the vetted IP while mysql2 keeps `host` as the hostname for
 * TLS SNI and certificate identity checks — closing the DNS-rebinding gap.
 *
 * INTERIM: the connector is hidden but still creatable through the API and CLI, and nothing vets the host yet,
 * so connecting from a deployed environment would turn MySQL into a network-probing oracle. Until the guard
 * lands, deployed (Cloud Run) environments refuse to connect at all; local development and CI (where
 * `RUNNING_IN_CLOUD` is unset) work normally.
 */
import type net from 'node:net';
import { ScratchConfigService } from 'src/config/scratch-config.service';
import { MySqlClientError, MySqlClientProblem } from './mysql-client-error';

export interface MySqlNetworkRouteTarget {
  readonly host: string;
  readonly port: number;
}

export interface MySqlNetworkRoute {
  /** mysql2 `stream` factory. Undefined = mysql2 dials `host` itself. */
  readonly createPinnedSocket?: () => net.Socket;
}

export type ResolveMySqlNetworkRoute = (target: MySqlNetworkRouteTarget) => Promise<MySqlNetworkRoute>;

export const MYSQL_CONNECTIONS_UNAVAILABLE_IN_DEPLOYED_ENVIRONMENTS_MESSAGE =
  "MySQL connections aren't available in this environment yet.";

// eslint-disable-next-line @typescript-eslint/require-await, @typescript-eslint/no-unused-vars
export const resolveMySqlNetworkRoute: ResolveMySqlNetworkRoute = async (_target) => {
  if (ScratchConfigService.isRunningInCloudRun()) {
    throw new MySqlClientError(
      MySqlClientProblem.DatabaseHostGuardUnavailable,
      MYSQL_CONNECTIONS_UNAVAILABLE_IN_DEPLOYED_ENVIRONMENTS_MESSAGE,
    );
  }
  return {};
};
