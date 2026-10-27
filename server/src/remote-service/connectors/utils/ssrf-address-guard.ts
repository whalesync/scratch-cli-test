/**
 * Public-address checks for every connector that reaches a user-supplied host from inside our network: the Generic
 * API's HTTP transport (`library/generic-api/apiget/ssrf-fetch.ts`) and the database connectors' sockets
 * (`ssrf-safe-socket.ts`, used by Postgres, Supabase and MySQL).
 *
 * A user-supplied host is a server-side request forgery primitive: it can point our connection at cloud metadata
 * (169.254.169.254), localhost services, or other addresses inside our VPC. {@link assertSafeHost} resolves the host
 * and refuses it unless every address it reaches is public. It rejects private (RFC 1918) / link-local / loopback /
 * metadata / multicast / "any" / broadcast / CGNAT / reserved IPs, v4 and v6. IPv4-mapped IPv6 forms (::ffff:a.b.c.d,
 * ::ffff:xxxx:yyyy, 0:0:0:0:0:ffff:xxxx:yyyy, ::a.b.c.d) all reduce to the v4 check, as do NAT64 (64:ff9b::/96) and
 * 6to4 (2002::/16) addresses.
 *
 * Checking a host only tells you about the addresses it had at the time of the check: a client that resolves the same
 * name again can get a different, private answer (DNS rebinding). Callers must connect to the addresses this returns,
 * as `ssrfSafeFetch` (a pinned undici lookup) and `SsrfSafeSocket` (a vetted socket lookup) do.
 *
 * Error surface: `SsrfError` carries two messages. `message` is generic and safe to surface to end users;
 * `internalDetails` is the verbose form with the resolved IP and block reason and MUST only be logged server-side.
 * Surfacing `internalDetails` to a user turns the guard into an internal DNS / IP oracle (probe
 * `https://kubernetes.default.svc/` → the response tells you whether it resolved and what private IP it pointed at).
 * `code` says which check refused, for callers that word the failure themselves.
 *
 * Kept in sync with Whalesync's copy of the same checks and of `SsrfSafeSocket`, in
 * `api/bottlenose/src/util/ssrf-safe-fetch.ts` of the whalesync repo. Change both.
 */

import { promises as dns } from 'dns';
import { isIP } from 'net';

/** Which check refused the request. */
export type SsrfErrorCode =
  | 'invalid_url'
  | 'not_https'
  | 'unresolvable'
  | 'private_address'
  | 'too_many_redirects'
  | 'response_too_large';

/**
 * SSRF guard rejection.
 *
 * `message` is the safe, generic version: surfaced to end users without revealing whether a hostname resolved, what
 * it resolved to, or what kind of private range was hit. `internalDetails` carries the verbose form (resolved IP,
 * exact block reason) and MUST only be logged server-side via WSLogger or similar — never returned in an API response
 * or error body.
 */
export class SsrfError extends Error {
  readonly code: SsrfErrorCode;
  /** Verbose detail for server-side logs. Never expose to end users. */
  readonly internalDetails: string;
  /**
   * For `unresolvable`, the DNS lookup's own error code (`ENOTFOUND`, `EAI_AGAIN`, ...). Never expose to end users
   * either: it tells whether a name exists.
   */
  readonly dnsErrorCode?: string;

  constructor(opts: { code: SsrfErrorCode; publicMessage: string; internalDetails?: string; dnsErrorCode?: string }) {
    super(opts.publicMessage);
    this.code = opts.code;
    this.internalDetails = opts.internalDetails ?? opts.publicMessage;
    this.dnsErrorCode = opts.dnsErrorCode;
    this.name = 'SsrfError';
  }
}

/** One address a host resolved to, after it passed the public-address check. */
export interface VettedAddress {
  address: string;
  family: 4 | 6;
}

/**
 * Resolve `hostname` (a DNS name or a literal IP, without IPv6 brackets) and assert every address it reaches is
 * public. Throws `SsrfError` (with `publicMessageForRefusal` as its message) on any failed check; returns the vetted
 * addresses, in the resolver's order.
 *
 * On its own this only checks the addresses at the time of the call: connect to the returned addresses rather than
 * to the name (see the module comment).
 */
export async function assertSafeHost(hostname: string, publicMessageForRefusal: string): Promise<VettedAddress[]> {
  // If the hostname is a literal IP, check it directly. Otherwise resolve.
  const literalIpVersion = isIP(hostname);

  let candidateAddresses: VettedAddress[];
  if (literalIpVersion !== 0) {
    candidateAddresses = [{ address: hostname, family: literalIpVersion as 4 | 6 }];
  } else {
    let resolvedAddresses: { address: string; family: number }[];
    try {
      resolvedAddresses = await dns.lookup(hostname, { all: true });
    } catch (lookupError) {
      const lookupErrorMessage = lookupError instanceof Error ? lookupError.message : String(lookupError);
      const dnsErrorCode = (lookupError as NodeJS.ErrnoException | undefined)?.code;
      throw new SsrfError({
        code: 'unresolvable',
        publicMessage: publicMessageForRefusal,
        internalDetails: `Could not resolve hostname "${hostname}": ${lookupErrorMessage}`,
        ...(typeof dnsErrorCode === 'string' ? { dnsErrorCode } : {}),
      });
    }
    candidateAddresses = resolvedAddresses
      .filter((resolvedAddress) => resolvedAddress.family === 4 || resolvedAddress.family === 6)
      .map((resolvedAddress) => ({ address: resolvedAddress.address, family: resolvedAddress.family as 4 | 6 }));
    if (candidateAddresses.length === 0) {
      throw new SsrfError({
        code: 'unresolvable',
        publicMessage: publicMessageForRefusal,
        internalDetails: `Hostname "${hostname}" did not resolve to any address.`,
      });
    }
  }

  // Every resolved IP must be safe. This is strict on purpose: an attacker who controls DNS can return mixed answers
  // (public + private) hoping the connect races onto the private one. Refusing the whole hostname when any returned
  // IP is private kills that vector.
  for (const candidateAddress of candidateAddresses) {
    assertSafeAddress(hostname, candidateAddress.address, publicMessageForRefusal);
  }

  return candidateAddresses;
}

/** Throws `SsrfError` when `address`, which `hostname` names or resolved to, is one we refuse to connect to. */
export function assertSafeAddress(hostname: string, address: string, publicMessageForRefusal: string): void {
  const blockReason = blockReasonForIp(address);
  if (blockReason !== null) {
    throw new SsrfError({
      code: 'private_address',
      publicMessage: publicMessageForRefusal,
      internalDetails: `Refusing to connect to "${hostname}" (${address}): ${blockReason}.`,
    });
  }
}

/**
 * True if the IP is in any block we refuse to connect to. Returns a human-readable reason for the SsrfError's
 * internal details, or null when allowed.
 *
 * Exported for tests; {@link assertSafeAddress} is the only production caller.
 */
export function blockReasonForIp(ip: string): string | null {
  const version = isIP(ip);
  if (version === 4) return blockReasonForIpv4(ip);
  if (version === 6) return blockReasonForIpv6(ip);
  return `not a valid IP address`;
}

function blockReasonForIpv4(ip: string): string | null {
  const parts = ip.split('.').map((p) => Number(p));
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) {
    return 'invalid IPv4 address';
  }
  const [a, b] = parts;
  if (a === 0) return 'unspecified address (0.0.0.0/8)';
  if (a === 10) return 'private RFC 1918 (10.0.0.0/8)';
  if (a === 127) return 'loopback (127.0.0.0/8)';
  if (a === 169 && b === 254) return 'link-local (169.254.0.0/16, includes cloud metadata)';
  if (a === 172 && b >= 16 && b <= 31) return 'private RFC 1918 (172.16.0.0/12)';
  if (a === 192 && b === 168) return 'private RFC 1918 (192.168.0.0/16)';
  if (a === 100 && b >= 64 && b <= 127) return 'shared address space (100.64.0.0/10, CGNAT)';
  if (a >= 224 && a <= 239) return 'multicast (224.0.0.0/4)';
  if (a >= 240) return 'reserved Class E (240.0.0.0/4) or broadcast (255.255.255.255)';
  return null;
}

function blockReasonForIpv6(ip: string): string | null {
  const bytes = ipv6ToBytes(ip);
  if (!bytes) return 'invalid IPv6 address';

  // Loopback (::1) and unspecified (::)
  const allButLastZero = bytes.slice(0, 15).every((bb) => bb === 0);
  if (allButLastZero && bytes[15] === 0) return 'IPv6 unspecified (::)';
  if (allButLastZero && bytes[15] === 1) return 'IPv6 loopback (::1)';

  // IPv4-mapped IPv6 (::ffff:a.b.c.d / ::ffff:xxxx:yyyy / fully expanded form):
  // 80 bits zero, 16 bits 0xffff, last 32 bits = embedded v4. Catches the
  // Codex-flagged bypass where Node canonicalizes ::ffff:127.0.0.1 to
  // ::ffff:7f00:1 and the leading-hextet heuristic returned null.
  const isV4Mapped = bytes.slice(0, 10).every((bb) => bb === 0) && bytes[10] === 0xff && bytes[11] === 0xff;
  if (isV4Mapped) {
    const v4 = `${bytes[12]}.${bytes[13]}.${bytes[14]}.${bytes[15]}`;
    const inner = blockReasonForIpv4(v4);
    if (inner !== null) return `IPv4-mapped IPv6 of ${v4}: ${inner}`;
    return null;
  }

  // IPv4-compatible IPv6 (::a.b.c.d, deprecated but still parseable): 96 bits
  // zero + 32 bits v4. Treat like mapped.
  const isV4Compat =
    bytes.slice(0, 12).every((bb) => bb === 0) &&
    (bytes[12] !== 0 || bytes[13] !== 0 || bytes[14] !== 0 || bytes[15] !== 0);
  if (isV4Compat) {
    const v4 = `${bytes[12]}.${bytes[13]}.${bytes[14]}.${bytes[15]}`;
    const inner = blockReasonForIpv4(v4);
    if (inner !== null) return `IPv4-compatible IPv6 of ${v4}: ${inner}`;
    // Allow if the embedded v4 is itself public.
    return null;
  }

  const first = (bytes[0] << 8) | bytes[1];
  const second = (bytes[2] << 8) | bytes[3];

  // NAT64 well-known prefix 64:ff9b::/96 (RFC 6052): a NAT64 gateway sends these to the v4 in the last 32 bits, so
  // 64:ff9b::a9fe:a9fe reaches 169.254.169.254. Check the embedded v4 like the mapped form.
  const isNat64 = first === 0x0064 && second === 0xff9b && bytes.slice(4, 12).every((bb) => bb === 0);
  if (isNat64) {
    const v4 = `${bytes[12]}.${bytes[13]}.${bytes[14]}.${bytes[15]}`;
    const inner = blockReasonForIpv4(v4);
    if (inner !== null) return `NAT64 IPv6 of ${v4}: ${inner}`;
    return null;
  }
  // Local-use NAT64 64:ff9b:1::/48 (RFC 8215): never routed publicly, and where the v4 sits depends on the operator's
  // prefix length, so refuse the whole range.
  if (first === 0x0064 && second === 0xff9b && ((bytes[4] << 8) | bytes[5]) === 0x0001) {
    return 'IPv6 local-use NAT64 (64:ff9b:1::/48)';
  }
  // 6to4 2002::/16 (RFC 3056): the 32 bits after the prefix are a v4 that relays deliver to.
  if (first === 0x2002) {
    const v4 = `${bytes[2]}.${bytes[3]}.${bytes[4]}.${bytes[5]}`;
    const inner = blockReasonForIpv4(v4);
    if (inner !== null) return `6to4 IPv6 of ${v4}: ${inner}`;
    return null;
  }

  // Link-local fe80::/10 — first 10 bits = 1111 1110 10
  if ((first & 0xffc0) === 0xfe80) return 'IPv6 link-local (fe80::/10)';
  // Site-local fec0::/10 (deprecated by RFC 3879, but still private where it's used) — first 10 bits = 1111 1110 11
  if ((first & 0xffc0) === 0xfec0) return 'IPv6 site-local (fec0::/10)';
  // Unique-local fc00::/7 — first 7 bits = 1111 110
  if ((first & 0xfe00) === 0xfc00) return 'IPv6 unique-local (fc00::/7)';
  // Multicast ff00::/8 — first 8 bits = 1111 1111
  if ((first & 0xff00) === 0xff00) return 'IPv6 multicast (ff00::/8)';

  return null;
}

/**
 * Expand any well-formed IPv6 text representation into 16 bytes. Handles
 * compressed `::`, dotted-quad embedded v4 (`::ffff:127.0.0.1`), hex pairs
 * (`::ffff:7f00:1`), zone IDs (`fe80::1%eth0`), and the fully expanded form
 * (`0:0:0:0:0:ffff:7f00:1`). Returns null if the input doesn't parse —
 * upstream caller already ran `isIP`, so this should only fail on
 * pathological inputs.
 */
function ipv6ToBytes(ip: string): Uint8Array | null {
  // Strip zone id and lowercase for hex parsing.
  const noZone = ip.toLowerCase().split('%')[0];

  let head: string;
  let tail: string;
  const dcIdx = noZone.indexOf('::');
  if (dcIdx >= 0) {
    head = noZone.slice(0, dcIdx);
    tail = noZone.slice(dcIdx + 2);
  } else {
    head = noZone;
    tail = '';
  }

  const headHextets = head ? head.split(':') : [];
  const tailHextets = tail ? tail.split(':') : [];

  // If the last hextet of the tail (or head, if no `::`) is dotted-quad v4,
  // expand it into two hextets so the rest of the parser is uniform.
  const lastSource = tailHextets.length > 0 ? tailHextets : headHextets;
  const v4 = lastSource.length > 0 && lastSource[lastSource.length - 1].includes('.') ? lastSource.pop() : undefined;
  if (v4 !== undefined) {
    const parts = v4.split('.').map((p) => Number(p));
    if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) {
      return null;
    }
    const high = (parts[0] << 8) | parts[1];
    const low = (parts[2] << 8) | parts[3];
    lastSource.push(high.toString(16));
    lastSource.push(low.toString(16));
  }

  const total = headHextets.length + tailHextets.length;
  if (total > 8) return null;
  const fillCount = dcIdx >= 0 ? 8 - total : total === 8 ? 0 : -1;
  if (fillCount < 0) return null;

  const hextets = [...headHextets, ...new Array<string>(fillCount).fill('0'), ...tailHextets];
  if (hextets.length !== 8) return null;

  const bytes = new Uint8Array(16);
  for (let i = 0; i < 8; i++) {
    const text = hextets[i] || '0';
    const n = parseInt(text, 16);
    if (!Number.isFinite(n) || n < 0 || n > 0xffff) return null;
    bytes[i * 2] = (n >> 8) & 0xff;
    bytes[i * 2 + 1] = n & 0xff;
  }
  return bytes;
}
