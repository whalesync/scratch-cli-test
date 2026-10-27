/**
 * The database host guard: the TCP socket the Postgres, Supabase and MySQL connectors connect through in deployed
 * environments, so a user's database host can't point our connection at cloud metadata, localhost services or other
 * addresses inside our VPC.
 *
 * Without it, whatever host a user types is dialed from inside our Cloud Run network (Direct VPC egress), and a refused
 * connection and a timeout come back as different errors — so a connection could be used to find which internal
 * addresses and ports are open.
 *
 * Kept in sync with Whalesync's `SsrfSafeSocket` in `api/bottlenose/src/util/ssrf-safe-fetch.ts` of the whalesync
 * repo (see `ssrf-address-guard.ts`).
 */
import { isIP, type LookupFunction, Socket } from 'net';
import { ScratchConfigService } from 'src/config/scratch-config.service';
import { assertSafeAddress, assertSafeHost, SsrfError } from './ssrf-address-guard';

/**
 * The message a refused database host fails with. It never says the host was refused, or why: connectors show the same
 * text they show for any other unreachable host (see each connector's error mapping), and the reason (resolved IP and
 * block reason) is only in the error's `internalDetails`, for the server log.
 */
export const DATABASE_HOST_REFUSED_PUBLIC_MESSAGE = "Couldn't connect to the database server.";

/**
 * Whether database connections go through {@link SsrfSafeSocket}: in every deployed environment (api, worker and cron
 * all set `RUNNING_IN_CLOUD=true`). Local development, CI and the integration tests legitimately run their databases
 * on localhost or a Docker network, so there the drivers dial the host themselves.
 */
export function isDatabaseHostGuardEnabled(): boolean {
  return ScratchConfigService.isRunningInCloudRun();
}

/**
 * A TCP socket that only connects to public addresses, for database drivers that open their own connection to a
 * user-supplied host and accept a socket but no DNS hook (node-postgres's and mysql2's `stream` options).
 *
 * The host is vetted with `assertSafeHost` inside the socket's own DNS lookup, and the socket connects to exactly the
 * addresses that lookup vetted. Vetting the host before handing it to the driver would leave a gap: the driver resolves
 * the name again when it connects, and a name with a zero TTL can answer that second time with a private address. Vetting
 * here also checks the host the driver actually connects to, rather than our own reading of its configuration
 * (node-postgres lets a `?host=` parameter override the host in a connection string URL). Unix socket paths are refused.
 *
 * The driver keeps using the original hostname for everything else, so TLS certificate checks and SNI (the Supabase
 * pooler, Neon) are unchanged. A refused connect fails with an `SsrfError` on the socket's `error` event.
 */
export class SsrfSafeSocket extends Socket {
  override connect(...connectArguments: unknown[]): this {
    // node-postgres calls connect(port, host), or connect(path) for a Unix socket. The MySQL socket factory calls
    // connect(port, host).
    const [port, host] = connectArguments;
    if (typeof host !== 'string' || (typeof port !== 'number' && typeof port !== 'string')) {
      return this.refuse(
        new SsrfError({
          code: 'private_address',
          publicMessage: DATABASE_HOST_REFUSED_PUBLIC_MESSAGE,
          internalDetails: `Refusing to connect to "${String(port)}": not a network host.`,
        }),
      );
    }
    if (isIP(host) !== 0) {
      // A literal IP never goes through the lookup below, so check it here.
      try {
        assertSafeAddress(host, host, DATABASE_HOST_REFUSED_PUBLIC_MESSAGE);
      } catch (refusal) {
        return this.refuse(refusal as SsrfError);
      }
      return super.connect(Number(port), host);
    }
    return super.connect({ port: Number(port), host, lookup: lookUpOnlyVettedPublicAddresses });
  }

  /** Fail the connect with an `error` event, after the caller has had the chance to listen for it. */
  private refuse(refusal: SsrfError): this {
    process.nextTick(() => this.destroy(refusal));
    return this;
  }
}

/**
 * A `dns.lookup` replacement that answers only with addresses `assertSafeHost` vetted. Supports both callback shapes:
 * Node's connect asks for every address (`all: true`) when it tries IPv4 and IPv6 in turn.
 */
const lookUpOnlyVettedPublicAddresses: LookupFunction = (hostname, options, callback) => {
  assertSafeHost(hostname, DATABASE_HOST_REFUSED_PUBLIC_MESSAGE).then(
    (vettedAddresses) => {
      if (options.all === true) {
        callback(null, vettedAddresses);
      } else {
        callback(null, vettedAddresses[0].address, vettedAddresses[0].family);
      }
    },
    (refusal: unknown) => callback(refusal as NodeJS.ErrnoException, ''),
  );
};
