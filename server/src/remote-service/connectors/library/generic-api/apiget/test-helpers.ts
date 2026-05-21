/**
 * Test helpers for apiget fixture tests.
 *
 * Lets fixture tests route their scripted fetches through the same URL
 * validation + redirect re-validation as production `ssrfSafeFetch`, so
 * regressions in `assertSafeUrl`, the IP blocklist, or the redirect loop
 * break apiget tests too — not just the SSRF-specific spec.
 *
 * This does NOT exercise the body-size cap or the pinned-connect undici
 * Agent. Those require real streams and a real TCP connect respectively,
 * neither of which is meaningful when the underlying fetch is scripted.
 * For real-network coverage of the dispatcher, an integration test would be
 * needed — out of scope for unit-level fixture coverage.
 *
 * Callers MUST mock `dns.lookup` (via `jest.spyOn(dns, 'lookup')` in a
 * `beforeEach`) since `assertSafeUrl` resolves any non-IP hostname. The
 * `setupSsrfTestEnv()` helper below does this in one line.
 */

import { promises as dns } from 'dns';
import { assertSafeUrl, SsrfError } from './ssrf-fetch';
import { FetchFn, FetchRequest, FetchResponse } from './types';

const MAX_REDIRECTS = 5;

/**
 * Wrap a scripted fetch with production's URL validation + redirect
 * re-validation. The returned FetchFn:
 *
 *   1. Calls `assertSafeUrl` on the request URL (HTTPS-only, DNS lookup,
 *      private-IP blocklist, multi-A guard).
 *   2. Calls the scripted fetch.
 *   3. If the response is a 3xx with Location, re-validates the next URL
 *      and recurses (up to MAX_REDIRECTS hops).
 *
 * If `assertSafeUrl` rejects the URL, the wrapper throws `SsrfError`
 * synchronously — apiget tests that pass a private-IP URL will see the
 * same rejection production does.
 */
export function wrapWithSsrfGuard(scripted: FetchFn): FetchFn {
  return async (request: FetchRequest): Promise<FetchResponse> => {
    let currentUrl = request.url;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const target = await assertSafeUrl(currentUrl);
      // Hand the scripted fetch the request as-is. The target URL is the
      // same as request.url for the first hop; on subsequent hops we
      // override with the redirect target. Tests script responses by URL
      // pattern, so the URL we pass through is what they assert on.
      const response = await scripted({ ...request, url: target.url.toString() });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers['location'];
        if (!location) return response;
        currentUrl = new URL(location, target.url).toString();
        continue;
      }
      return response;
    }
    throw new SsrfError({
      publicMessage: 'Endpoint exceeded the redirect limit.',
      internalDetails: `Too many redirects (>${MAX_REDIRECTS}). Last URL: ${currentUrl}`,
    });
  };
}

/**
 * Set up the test environment so SSRF-guard-wrapped fetches can run. Stubs
 * `dns.lookup` to return a public IP for any hostname. Returns the spy so
 * tests can override per-case if they want to drive a specific IP through
 * the guard (e.g. to test that the guard rejects a host that resolves to
 * 169.254.169.254).
 *
 * Typical use:
 *
 *   let dnsSpy: jest.SpyInstance;
 *   beforeEach(() => { dnsSpy = setupSsrfTestEnv(); });
 *   afterEach(() => { dnsSpy.mockRestore(); });
 */
export function setupSsrfTestEnv(): jest.SpyInstance {
  return jest.spyOn(dns, 'lookup').mockResolvedValue([{ address: '8.8.8.8', family: 4 }] as never);
}
