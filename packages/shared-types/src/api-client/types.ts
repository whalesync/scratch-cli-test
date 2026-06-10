/**
 * Authentication scheme written into the `Authorization` header. The scheme is per **token type**,
 * NOT per app:
 * - `Bearer` carries a Clerk session JWT.
 * - `API-Token` carries a Scratch broker-minted token.
 *
 * The desktop app always uses `API-Token`. The web client uses `Bearer` for its Clerk-authenticated
 * calls, but may also use `API-Token` for calls that go out with a broker-minted Scratch token — so
 * a single app can construct clients with either scheme depending on which token it is sending.
 */
export type AuthScheme = 'Bearer' | 'API-Token';

export interface AuthConfig {
  scheme: AuthScheme;
  /**
   * Per-request token read. Cheap/cached — may return a token that's about to expire. Resolved
   * fresh on every request; returning `null` sends no `Authorization` header. The client closes
   * over this function, not a token value, so a user/identity change is picked up transparently on
   * the next request with no need to rebuild the client.
   */
  getToken: () => string | null | Promise<string | null>;
  /**
   * Optional. Invoked when a request gets a 401, to mint a fresh token out-of-band (bypassing any
   * `getToken` cache). Returning a token → the client retries the original request once with it.
   * Returning `null` (or throwing) → the client gives up, surfaces the 401, and calls
   * `onUnauthorized`. Concurrent 401s on the same dead token share a single invocation
   * (single-flight); the retry happens at most once per request (no loops). Reauthorize failures
   * are always terminal — the client does not retry or back off `reauthorize` itself.
   *
   * Before minting, the client re-reads `getToken` once: if the shared token cell was already
   * advanced (a sibling request or proactive timer refreshed it after this request went out), the
   * client retries with that newer token and skips `reauthorize` entirely.
   *
   * CELL INVARIANT: the client uses `reauthorize`'s return value only for the immediate retry — it
   * deliberately does NOT cache it (the client stays stateless beyond config + token-getter). The
   * fresh token's persistence is the APP's concern: `reauthorize` must write the same session cell
   * that `getToken` reads, so subsequent requests pick up the new token via `getToken` instead of
   * re-minting on every post-expiry request.
   */
  reauthorize?: () => string | null | Promise<string | null>;
}

/**
 * Emitted to `onRequestComplete` after every request (success and error). The shared lib
 * only produces this event; app-side policy (URL exclusion, workspace context, transport)
 * lives in the handler the app injects.
 *
 * Exactly one `RequestLog` is emitted per logical request. A 401 that `auth.reauthorize`
 * transparently recovers from is reported ONCE, for the final outcome — the intermediate 401 is
 * not emitted — so recovered requests count as successes, not errors, in any metrics wired off this.
 */
export interface RequestLog {
  method: string;
  url: string;
  status?: number;
  durationMs: number;
  errorSummary?: string;
}

export interface ScratchApiClientConfig {
  /** Base URL of the Scratch API server. Injected; the lib never reads env itself. */
  baseUrl: string;
  auth: AuthConfig;
  /**
   * Optional — called on a **terminal** 401: when `auth.reauthorize` is absent, returns null,
   * throws, or the retried request 401s again. (A 401 that `reauthorize` transparently recovers
   * from never reaches here.) Desktop wires this to logout + wipe creds.
   */
  onUnauthorized?: () => void;
  /** Optional — called after every request, success or error (desktop wires this to IPC logging). */
  onRequestComplete?: (log: RequestLog) => void;
}
