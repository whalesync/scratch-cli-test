import { WSLogger } from 'src/logger';
import { type ConnectorErrorDetails } from '../../types';
import { describeScratchNetworkAddressForAllowlisting } from '../../utils/scratch-egress-ip-address';
import { SsrfError } from '../../utils/ssrf-address-guard';

/**
 * What a Postgres or Supabase connection says when its host can't be reached by name: the name doesn't resolve, or the
 * database host guard refused it (`SsrfSafeSocket`: it is, or resolves to, a private, loopback or metadata address).
 * One message for both on purpose: a connection must not tell an internal name that exists from one that doesn't, and
 * a refused address from one that is open or closed.
 */
export const POSTGRES_HOST_NOT_REACHABLE_MESSAGE =
  "Couldn't connect to the database host. Make sure the host in the connection string is the database's public " +
  `address, and that the database accepts connections from the internet and from ${describeScratchNetworkAddressForAllowlisting()}. ` +
  'If your password has special characters (@ / ? # %), percent-encode them (e.g. @ as %40).';

/**
 * The user-facing details for a connection the database host guard refused, or undefined for any other error. The
 * refusal's `internalDetails` (the resolved IP and block reason) go to the server log only.
 *
 * Check it before any branch that reads an error's `code`: an `SsrfError` has one too (`private_address`, ...).
 */
export function describeRefusedPostgresHost(error: unknown, logSource: string): ConnectorErrorDetails | undefined {
  if (!(error instanceof SsrfError)) return undefined;
  WSLogger.warn({
    source: logSource,
    message: 'Refused to connect to a database host that is not a public address',
    internalDetails: error.internalDetails,
  });
  return { userFriendlyMessage: POSTGRES_HOST_NOT_REACHABLE_MESSAGE, description: POSTGRES_HOST_NOT_REACHABLE_MESSAGE };
}
