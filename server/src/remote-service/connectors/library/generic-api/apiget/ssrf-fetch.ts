/**
 * SSRF-safe transport for the GENERIC_API connector.
 *
 * The connector lets users (and AI-suggested configs) point Scratch's server
 * at arbitrary URLs. Without this guard, a malicious or careless config can
 * target AWS metadata (169.254.169.254), localhost services (Postgres, admin
 * panels), in-cluster Kubernetes URLs, or HTTP-redirect chains landing on
 * the same. This module is the single chokepoint that:
 *
 *   1. Rejects non-HTTPS URLs.
 *   2. DNS-resolves the target hostname and rejects private (RFC 1918) /
 *      link-local / loopback / metadata / multicast / "any" / broadcast IPs,
 *      v4 and v6. IPv4-mapped IPv6 forms (::ffff:a.b.c.d, ::ffff:xxxx:yyyy,
 *      0:0:0:0:0:ffff:xxxx:yyyy, ::a.b.c.d) all reduce to the v4 check.
 *   3. Pins the TCP connect to the IP we just vetted via an undici dispatcher
 *      with a custom `lookup`. This closes the DNS-rebinding TOCTOU between
 *      `dns.lookup` and the eventual socket connect, which is the standard
 *      SSRF-guard bypass.
 *   4. Re-validates the Location target on every redirect — `redirect: 'follow'`
 *      is unsafe because native fetch follows without re-checking.
 *   5. Caps response body size so one upstream cannot OOM the server.
 *
 * Error surface: `SsrfError` carries two messages. `message` is generic and
 * safe to surface to end users; `internalDetails` is the verbose form with
 * the resolved IP and block reason and MUST only be logged server-side.
 * Surfacing `internalDetails` to a user turns the guard into an internal
 * DNS / IP oracle (probe `https://kubernetes.default.svc/` → response tells
 * you whether it resolved and what private IP it pointed at).
 *
 * The connector's makeRateLimitedFetch and apiget's defaultFetch both route
 * through `ssrfSafeFetch` so every outbound HTTP call from GENERIC_API is
 * guarded uniformly. Tests can inject their own FetchFn to bypass — the guard
 * lives only on the default transport.
 */

import { promises as dns } from 'dns';
import { isIP } from 'net';
import { Agent, fetch as undiciFetch } from 'undici';
import { FetchRequest, FetchResponse } from './types';

/** Hard cap on response body bytes — runaway-protection, not a usage cap. */
const MAX_BODY_BYTES = 10 * 1024 * 1024;

/** How many redirect hops to follow before bailing. */
const MAX_REDIRECTS = 5;

/** Generic message surfaced to end users in place of an internal-IP-revealing one. */
const GENERIC_PRIVATE_TARGET_MSG =
  'Endpoint resolves to a non-public address. Generic API can only reach public HTTPS endpoints.';

/**
 * SSRF guard rejection.
 *
 * `message` is the safe, generic version: surfaced to end users without
 * revealing whether a hostname resolved, what it resolved to, or what kind
 * of private range was hit. `internalDetails` carries the verbose form
 * (resolved IP, exact block reason) and MUST only be logged server-side via
 * WSLogger or similar — never returned in an API response or error body.
 */
export class SsrfError extends Error {
  /** Verbose detail for server-side logs. Never expose to end users. */
  readonly internalDetails: string;

  constructor(opts: { publicMessage: string; internalDetails?: string } | string) {
    if (typeof opts === 'string') {
      super(opts);
      this.internalDetails = opts;
    } else {
      super(opts.publicMessage);
      this.internalDetails = opts.internalDetails ?? opts.publicMessage;
    }
    this.name = 'SsrfError';
  }
}

/** One validated address — both the parsed URL and the pre-vetted IP to pin. */
interface ValidatedTarget {
  url: URL;
  /** The IP `globalThis.fetch` should connect to. Same as url.hostname for literal IPs. */
  pinnedIp: string;
  /** 4 or 6 — passed to undici's lookup callback. */
  pinnedFamily: 4 | 6;
}

/**
 * Parse `url` and assert it's safe to fetch. Throws `SsrfError` on any failed
 * check. Returns the parsed URL plus a vetted IP we'll later pin the TCP
 * connection to (closes the DNS-rebinding TOCTOU window between this lookup
 * and the actual socket connect).
 *
 * Performs a real DNS lookup, which costs a few ms per unique hostname. Native
 * fetch caches its own DNS, but ours is independent and pinned — we want to
 * connect to the IP we just decided was safe, not whatever DNS returns later.
 */
export async function assertSafeUrl(input: string | URL): Promise<ValidatedTarget> {
  let url: URL;
  try {
    url = typeof input === 'string' ? new URL(input) : input;
  } catch {
    throw new SsrfError({
      publicMessage: 'Endpoint URL is not parseable.',
      internalDetails: `URL is not parseable: ${String(input)}`,
    });
  }

  if (url.protocol !== 'https:') {
    throw new SsrfError({
      publicMessage:
        'Endpoint URL must use HTTPS. Generic API refuses plaintext to avoid SSRF and credential exposure.',
      internalDetails: `URL must use HTTPS (got "${url.protocol}").`,
    });
  }

  // If the hostname is a literal IP, check it directly. Otherwise resolve.
  // `URL.hostname` wraps IPv6 literals in brackets (e.g. "[::1]") but `net.isIP`
  // wants them unwrapped. Strip if present.
  const rawHostname = url.hostname;
  const hostname = rawHostname.startsWith('[') && rawHostname.endsWith(']') ? rawHostname.slice(1, -1) : rawHostname;
  const literalIpVersion = isIP(hostname);

  let candidates: { address: string; family: 4 | 6 }[];
  if (literalIpVersion !== 0) {
    candidates = [{ address: hostname, family: literalIpVersion as 4 | 6 }];
  } else {
    let resolved: { address: string; family: number }[];
    try {
      resolved = await dns.lookup(hostname, { all: true });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new SsrfError({
        publicMessage: GENERIC_PRIVATE_TARGET_MSG,
        internalDetails: `Could not resolve hostname "${hostname}": ${msg}`,
      });
    }
    if (resolved.length === 0) {
      throw new SsrfError({
        publicMessage: GENERIC_PRIVATE_TARGET_MSG,
        internalDetails: `Hostname "${hostname}" did not resolve to any address.`,
      });
    }
    candidates = resolved
      .filter((r) => r.family === 4 || r.family === 6)
      .map((r) => ({ address: r.address, family: r.family as 4 | 6 }));
  }

  // Every resolved IP must be safe. This is strict on purpose: an attacker who
  // controls DNS can return mixed answers (public + private) hoping the connect
  // races onto the private one. Refusing the whole hostname when any returned
  // IP is private kills that vector.
  for (const candidate of candidates) {
    const reason = blockReasonForIp(candidate.address);
    if (reason !== null) {
      throw new SsrfError({
        publicMessage: GENERIC_PRIVATE_TARGET_MSG,
        internalDetails: `Refusing to connect to "${hostname}" (${candidate.address}): ${reason}.`,
      });
    }
  }

  // Pin the connection to the first vetted IP. Subsequent resolves (by undici
  // or anything else) cannot redirect us onto a different — possibly private —
  // address. The SNI / Host header stays as the original hostname so TLS cert
  // validation still works against the original name.
  const pinned = candidates[0];
  return { url, pinnedIp: pinned.address, pinnedFamily: pinned.family };
}

/**
 * SSRF-safe fetch transport. Drop-in replacement for the previous default
 * transport in apiget/fetch.ts and the rate-limited fetch in the connector.
 *
 * Performs the SSRF check, then sends the request via undici with a per-request
 * `Agent` whose `connect.lookup` is pinned to the IP we just vetted. We use
 * `redirect: 'manual'` so we can re-validate any 3xx Location target. Reads
 * the body as a stream to enforce the size cap before fully buffering.
 */
export async function ssrfSafeFetch(request: FetchRequest): Promise<FetchResponse> {
  let currentUrl: string = request.url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const target = await assertSafeUrl(currentUrl);
    // Pinned lookup: every TCP connect within this Agent goes to the IP we
    // already vetted, never re-resolves. Closes the DNS-rebinding TOCTOU.
    //
    // `dns.lookup` (and therefore Node's net/tls connect logic that calls into
    // it) supports TWO callback shapes depending on `options.all`:
    //   - all: false (default) → cb(err, address, family)
    //   - all: true             → cb(err, [{ address, family }, …])
    // Undici's connect builder always passes `all: true`, so we MUST honor that
    // shape or the connect layer interprets our string address as the array,
    // tries to index into it, and fails with
    // `TypeError: fetch failed ← Invalid IP address: undefined`. We support
    // both shapes anyway in case the upstream caller changes.
    const pinnedLookup = ((hostname: string, options: unknown, cb: unknown): void => {
      const opts = (options ?? {}) as { all?: boolean };
      if (opts.all === true) {
        (cb as (e: Error | null, a: { address: string; family: number }[]) => void)(null, [
          { address: target.pinnedIp, family: target.pinnedFamily },
        ]);
      } else {
        (cb as (e: Error | null, a: string, f: number) => void)(null, target.pinnedIp, target.pinnedFamily);
      }
    }) as unknown;

    const agent = new Agent({
      connect: {
        lookup: pinnedLookup as never,
      },
    });
    let response: Response;
    try {
      response = (await undiciFetch(target.url, {
        method: request.method,
        headers: request.headers,
        body: request.body,
        signal: request.signal,
        redirect: 'manual',
        dispatcher: agent,
      })) as unknown as Response;
    } finally {
      // Best-effort: close the per-request agent so its sockets/pool are GCed
      // promptly. close() awaits in-flight; we already consumed the response
      // above (or threw).
      void agent.close();
    }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) {
        // 3xx without Location — treat as the response itself.
        return await toFetchResponseWithCap(response);
      }
      // Resolve relative redirects against the URL we just fetched.
      const next = new URL(location, target.url).toString();
      currentUrl = next;
      continue;
    }

    return await toFetchResponseWithCap(response);
  }
  throw new SsrfError({
    publicMessage: 'Endpoint exceeded the redirect limit.',
    internalDetails: `Too many redirects (>${MAX_REDIRECTS}). Last URL: ${currentUrl}`,
  });
}

/**
 * True if the IP is in any block we refuse to connect to. Returns a
 * human-readable reason for the SsrfError message, or null when allowed.
 *
 * Exported for tests; the body of `assertSafeUrl` is the only production caller.
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
  // Link-local fe80::/10 — first 10 bits = 1111 1110 10
  if ((first & 0xffc0) === 0xfe80) return 'IPv6 link-local (fe80::/10)';
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
  if (lastSource.length > 0 && lastSource[lastSource.length - 1].includes('.')) {
    const v4 = lastSource.pop()!;
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

/**
 * Read the response body as text with a size cap. We stream the body so a
 * pathological upstream sending gigabytes can't OOM the server before we
 * notice. Per impl plan: 10MB cap is "runaway-protection, not a usage cap"
 * — bump it if a legitimate endpoint legitimately needs more.
 */
async function toFetchResponseWithCap(response: Response): Promise<FetchResponse> {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    headers[key.toLowerCase()] = value;
  });

  // Fail fast on a clearly oversized advertised Content-Length.
  const contentLength = headers['content-length'];
  if (contentLength) {
    const declared = Number(contentLength);
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
      throw new SsrfError({
        publicMessage: 'Endpoint response is too large.',
        internalDetails: `Response body too large (${declared} bytes > ${MAX_BODY_BYTES} cap).`,
      });
    }
  }

  if (!response.body) {
    return { status: response.status, headers, body: '' };
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > MAX_BODY_BYTES) {
        await reader.cancel();
        throw new SsrfError({
          publicMessage: 'Endpoint response is too large.',
          internalDetails: `Response body exceeded ${MAX_BODY_BYTES}-byte cap (streamed > cap before EOF).`,
        });
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const merged = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    merged.set(c, offset);
    offset += c.length;
  }
  const body = new TextDecoder('utf-8').decode(merged);
  return { status: response.status, headers, body };
}
