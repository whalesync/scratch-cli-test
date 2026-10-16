/**
 * What the OAuth `state` decodes to: base64-encoded JSON, readable with `JSON.parse(atob(state))`.
 *
 * It is PUBLIC and UNTRUSTED. The state round-trips through the browser, the provider and
 * Whalesync's redirect page, so it only carries what those hops need to route the result
 * (`resultForwardUrl`, `service`, `workbookId`, `returnPage`) plus the nonce of the server-side
 * record of the connect. Who started the flow, which connection it re-authorizes, and the PKCE
 * verifier all stay in that record (DEV-12155). The server accepts a state at most once, and only
 * exactly as it minted it — clients read it but must never edit it.
 */
export type OAuthStatePayload = {
  /**
   * Absolute URL the OAuth callback forwards the result to once the provider redirects back — the
   * "exit". Web: `${origin}/oauth/callback-step-2`. Desktop: `scratch://oauth-callback`. Whalesync
   * (Live Export): its own landing page. NEVER the OAuth redirect_uri / connector callback itself,
   * or the handler would forward to itself.
   *
   * Required on every state minted now, but typed optional because the callback decodes an
   * arbitrary base64 `state` off the URL: a malformed or pre-cutoff state can genuinely lack it,
   * and the callback must guard rather than trust the type.
   */
  resultForwardUrl?: string;
  service: string;
  /** The workspace the connect happens in. Read by desktop to navigate after connecting. */
  workbookId: string;
  /**
   * Web-only: in-app path to land on after the connection completes (read at
   * `/oauth/callback-step-2`). Never a forward target — that is `resultForwardUrl`.
   */
  returnPage?: string;
  /** Identifies the server-side record of this connect. Opaque to every client. */
  pendingAuthorizationNonce: string;
};
