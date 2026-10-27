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
 *   2. DNS-resolves the target hostname and rejects every non-public address,
 *      with the shared checks in `connectors/utils/ssrf-address-guard.ts`
 *      (also used by the database connectors' socket).
 *   3. Pins the TCP connect to the IP we just vetted via an undici dispatcher
 *      with a custom `lookup`. This closes the DNS-rebinding TOCTOU between
 *      `dns.lookup` and the eventual socket connect, which is the standard
 *      SSRF-guard bypass.
 *   4. Re-validates the Location target on every redirect — `redirect: 'follow'`
 *      is unsafe because native fetch follows without re-checking.
 *   5. Caps response body size so one upstream cannot OOM the server.
 *
 * Error surface: `SsrfError` (see `ssrf-address-guard.ts`) carries a generic
 * `message` that is safe to surface to end users and a verbose
 * `internalDetails` that MUST only be logged server-side.
 *
 * The connector's makeRateLimitedFetch and apiget's defaultFetch both route
 * through `ssrfSafeFetch` so every outbound HTTP call from GENERIC_API is
 * guarded uniformly. Tests can inject their own FetchFn to bypass — the guard
 * lives only on the default transport.
 */

import { Agent, fetch as undiciFetch } from 'undici';
import { assertSafeHost, SsrfError } from '../../../utils/ssrf-address-guard';
import { FetchRequest, FetchResponse } from './types';

export { blockReasonForIp, SsrfError } from '../../../utils/ssrf-address-guard';

/** Hard cap on response body bytes — runaway-protection, not a usage cap. */
const MAX_BODY_BYTES = 10 * 1024 * 1024;

/** How many redirect hops to follow before bailing. */
const MAX_REDIRECTS = 5;

/** Generic message surfaced to end users in place of an internal-IP-revealing one. */
const GENERIC_PRIVATE_TARGET_MSG =
  'Endpoint resolves to a non-public address. Generic API can only reach public HTTPS endpoints.';

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
      code: 'invalid_url',
      publicMessage: 'Endpoint URL is not parseable.',
      internalDetails: `URL is not parseable: ${String(input)}`,
    });
  }

  if (url.protocol !== 'https:') {
    throw new SsrfError({
      code: 'not_https',
      publicMessage:
        'Endpoint URL must use HTTPS. Generic API refuses plaintext to avoid SSRF and credential exposure.',
      internalDetails: `URL must use HTTPS (got "${url.protocol}").`,
    });
  }

  // `URL.hostname` wraps IPv6 literals in brackets (e.g. "[::1]") but `net.isIP`
  // wants them unwrapped. Strip if present.
  const rawHostname = url.hostname;
  const hostname = rawHostname.startsWith('[') && rawHostname.endsWith(']') ? rawHostname.slice(1, -1) : rawHostname;
  const candidates = await assertSafeHost(hostname, GENERIC_PRIVATE_TARGET_MSG);

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
    code: 'too_many_redirects',
    publicMessage: 'Endpoint exceeded the redirect limit.',
    internalDetails: `Too many redirects (>${MAX_REDIRECTS}). Last URL: ${currentUrl}`,
  });
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
        code: 'response_too_large',
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
          code: 'response_too_large',
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
