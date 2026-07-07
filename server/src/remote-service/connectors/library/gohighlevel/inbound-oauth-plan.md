# Inbound (Marketplace-Initiated) OAuth for HighLevel — Design & Implementation Plan

> Status: **Phase 1 implemented** (connector-agnostic core + web claim page). Desktop (Phase 2) and
> hardening (Phase 3) deferred. Scope: add OAuth to the HighLevel (GoHighLevel) connector and support
> the **marketplace-initiated** install flow the GHL App Marketplace review requires.
>
> ### As-built (differs from the original proposal in a few naming/structure details)
>
> - **Connector-agnostic, keyed by `:service`** — nothing below is GHL-specific except the provider.
> - **Model** `PendingOAuthInstall` (`schema.prisma`): `id` = the unguessable `installId` (bearer
>   secret), `service`, `encryptedCredentials` (same envelope as `ConnectorAccount`), `workspaceId`
>   (GHL locationId), `displayName`, `expiresAt` (1h TTL, `@@index`), `claimedAt`/`claimedByUserId`.
>   Migration `20260622140309_pending_oauth_install`.
> - **Own module** `OAuthInstallModule` (`server/src/oauth-install/`) — NOT folded into `OAuthModule`,
>   because creating a workbook on claim needs `WorkbookModule`, and `OAuthModule` is already in the
>   `workbook → connectors → oauth` cycle. The new module imports both and nothing imports it back.
>   `OAuthService` exposes just two generic primitives it reuses:
>   `exchangeInboundCodeForTokens(service, code, redirectUri?)` and
>   `createConnectorAccountFromOAuthTokens(service, workbookId, actor, tokenResponse)`.
> - **Routes** (`OAuthInstallController`, `@Controller('oauth')`): `GET /oauth/install/:service`
>   (PUBLIC redeem → 302 `/connect/:service?install=<id>` or `?error=`), `GET /oauth/pending-install/:installId`
>   (AUTH metadata, no tokens), `POST /oauth/pending-install/:installId/claim` (AUTH; auto-creates a
>   workbook, then the connection; atomic single-use reserve guards double-claim; rolls back on failure).
> - **Claim is always auto-create a new workbook** (no picker), with **read+write** scopes.
> - **Web**: generic `client/src/app/connect/[service]/page.tsx` (+ `use-oauth-install.ts`, `keys.ts`,
>   `oauth` api-client methods). NOT in `publicRoutePatterns`, so Clerk gates it and the `?install=`
>   param survives sign-up/sign-in via `returnBackUrl`. `serviceDisplayName` is resolved server-side so
>   the page stays connector-agnostic.
> - **Redirect lands on the WEB host** (like Scratch's app-initiated OAuth, and like Whalesync's
>   Webflow flow): the marketplace redirects to the public web page
>   **`https://app.scratch.md/oauth/install/:service`** — NOT the API host (`api.scratch.md`) and NOT
>   `app.scratch.md/api/...` (app and api are separate Cloud Run services + LBs with no `/api` path
>   bridge). That public page (`client/src/app/oauth/install/[service]/page.tsx`,
>   in `publicRoutePatterns`) reads `?code=` and POSTs it to the public **`POST /oauth/install/:service`**
>   endpoint, which redeems + stashes and returns `{ installId }`; the page then forwards to the
>   auth-gated `/connect/:service?install=…` claim page. The token exchange's `redirect_uri` derives
>   from `REDIRECT_URI`'s origin (`app.scratch.md`) + `/oauth/install/:service` — no env var, no
>   `x-forwarded` reconstruction. **#1 live-test item**: the GHL listing's redirect URL must EXACTLY
>   equal this web URL (§5.6).

## 1. Why this exists

Our GHL marketplace listing was rejected for two reasons:

1. The app uses a `localhost` redirect URL, so the reviewer can't complete the install.
2. No test credentials were provided.

(2) is a process fix (ship a username/password test account + numbered steps). (1) is the real
engineering work, and it exposes a deeper gap: **every OAuth connector we have today is
_app-initiated_** — the user is already inside Scratch, already logged in, has already picked a
workbook, and clicks "Connect". The GHL marketplace reviewer does the opposite: they start on
GHL's side, click **Install**, and get redirected to us **with no Scratch session, no workbook,
and possibly no Scratch account at all.** Nothing in the codebase handles that direction.

This doc designs the marketplace-initiated ("inbound") flow and the three user states it must
handle, plus the desktop-app handoff.

## 2. How OAuth works today (app-initiated) — the baseline we're extending

The current flow, for reference (all file paths relative to repo root):

- **Initiate** — `POST /oauth/:service/initiate` (`server/src/oauth/oauth.controller.ts`),
  auth-gated by `ScratchAuthGuard`. `OAuthService.initiateOAuth` (`server/src/oauth/oauth.service.ts`)
  builds a **base64-JSON `state`** payload and returns `{ authUrl }`. The client redirects the
  browser to `authUrl`.
- **State** — `OAuthStatePayload` (`packages/shared-types/src/dto/oauth/oauth-state-payload.ts`,
  mirrored in `server/src/oauth/types.ts`) encodes **`userId`, `organizationId`, `workbookId`,
  `service`, `connectionMethod`, `returnPage`, …**. This is the mechanism that ties the eventual
  callback back to a Scratch workspace: *we told ourselves, in advance, where the tokens belong.*
- **Provider abstraction** — `OAuthProvider` (`server/src/oauth/oauth-provider.interface.ts`):
  `generateAuthUrl`, `exchangeCodeForTokens`, `refreshTokens`, `getRedirectUri`. Examples:
  `providers/notion-oauth.provider.ts`, `providers/zoho-oauth.provider.ts` (multi-region),
  `providers/airtable-oauth.provider.ts` (PKCE).
  All read a single shared `REDIRECT_URI` env var.
- **Callback (web)** — the provider redirects to `https://<host>/oauth/callback`
  (`client/src/app/oauth/callback/page.tsx`, a **public** route). It decodes `state.returnPage`:
  - `scratch://…` → bounce to the **desktop app** deep link (see §6).
  - otherwise → forward to `/oauth/callback-step-2` (`client/src/app/oauth/callback-step-2/page.tsx`),
    which **is auth-gated**, and calls `POST /oauth/:service/callback`.
- **Callback (server)** — `OAuthService.handleOAuthCallback`:
  - decodes `state`, then **enforces `state.userId === actor.userId` and
    `state.organizationId === actor.organizationId`** (`oauth.service.ts` ~L192). This is the crux:
    the app-initiated flow assumes the caller is the same logged-in user who started it.
  - `provider.exchangeCodeForTokens(code)` → `createOAuthAccount(...)` (`oauth.service.ts` ~L346)
    writes a `ConnectorAccount` row: `workbookId` from state, `authType: OAUTH`,
    `encryptedCredentials` = `{ oauthAccessToken, oauthRefreshToken, oauthExpiresAt, oauthWorkspaceId }`
    (AES-256-GCM via `server/src/utils/encryption.ts`), and `initRepo(repoPath)`.
- **ConnectorAccount** — `server/prisma/schema.prisma` (~L141): FK `workbookId → Workbook`
  (`onDelete: Cascade`), `userId` (`onDelete: SetNull`), encrypted creds, unencrypted `extras`.
  **A workbook must already exist; the connection is created inside it.**

**Two facts that make inbound hard:**

1. The whole model is keyed on a `state` we minted **before** the redirect, carrying `userId` +
   `workbookId`. In a marketplace-initiated install **we were never there to mint it** — GHL starts
   the flow and has no concept of a Scratch user or workbook.
2. The auth code GHL hands back is **single-use and short-lived** (minutes). We cannot safely thread
   it through a sign-up / email-verification / desktop-launch detour and still redeem it at the end.

## 3. The inbound flow in the abstract

When GHL initiates, the sequence is:

```
GHL marketplace  ──Install──▶  GHL consent (chooselocation)  ──user approves──▶
  redirect to  https://app.scratch.md/api/oauth/install/gohighlevel?code=<one-time>
```

At that redirect we have: a valid `code`, and (after exchange) the GHL **locationId / companyId**.
We do **not** have: which Scratch user, which workbook, or whether the person even has an account.

The person in the browser at that moment is in one of **three states** (the cases you called out):

- **(A) Not registered** — no Scratch account at all.
- **(B) Registered but not logged in** — has an account, no active session in this browser/app.
- **(C) Registered and logged in** — we can attach the connection immediately.

And separately, they may want to land in **Scratch web** or the **Scratch desktop app**.

## 4. Proposed architecture

### 4.1 Core idea: a server-minted *pending install* token

Instead of threading GHL's fragile one-time `code` through login, we **redeem the code
immediately, server-side, the instant GHL redirects to us**, and stash the resulting tokens in a
short-lived `PendingOAuthInstall` row keyed by a **high-entropy, unguessable, single-use
`installId`**. That `installId` becomes the portable correlation token we carry through sign-up,
login, and the desktop handoff. It is safe to put in a URL, survives detours, and never exposes the
GHL tokens to the browser.

```
GHL ──code──▶  GET /api/oauth/install/gohighlevel        (PUBLIC, no Scratch auth)
                 │  exchange code → tokens  (do it NOW, before it expires)
                 │  resolve locationId/companyId from token response
                 │  INSERT PendingOAuthInstall { installId, service, encTokens,
                 │                                ghlLocationId, displayName,
                 │                                expiresAt = now+1h }
                 ▼
            302 → https://app.scratch.md/connect/gohighlevel?install=<installId>
                  (the "claim" page — content depends on the 3 auth states)
```

Why redeem up front rather than lazily at claim time:

- GHL auth codes expire in minutes and are single-use. A user in **case (A)** might take 10 minutes
  to sign up and verify email. Redeeming lazily would routinely fail.
- The token exchange is decoupled from *who* claims it — exactly the decoupling we need.

Trade-off we accept: we briefly hold **orphan tokens not yet attached to any user**. Mitigations:
short TTL (1h), a cleanup cron, encryption at rest (reuse `CredentialEncryptionService`), and
treating `installId` as a bearer secret (see §7).

### 4.2 The claim page resolves the three cases

`/connect/[service]?install=<installId>` is a **non-public** route (so Clerk's middleware,
`client/src/proxy.ts`, auto-handles A & B for us):

- **(C) logged in** — page loads, fetches the pending-install metadata
  (`GET /api/oauth/install/:installId` → `{ service, locationDisplayName, expiresAt }`), shows a
  **"Add HighLevel to which workspace?"** step (pick existing workbook **or** "Create new"), then
  `POST /api/oauth/install/:installId/claim { workbookId }`. Server moves tokens out of the pending
  row into a real `ConnectorAccount` (reusing the `createOAuthAccount` path) and deletes the
  pending row. Done — offer "Open in Desktop" / "Open workbook".
- **(B) registered, not logged in** — Clerk middleware sees no session on this non-public route and
  redirects to `/sign-in?redirect_url=/connect/gohighlevel?install=<installId>`
  (`RouteUrls.signInPageWithRedirect`, already supported in
  `client/src/app/sign-in/[[...slug]]/page.tsx`). After login, Clerk returns to the claim page → falls
  into case (C).
- **(A) not registered** — identical, but the user follows the "Sign up" cross-link
  (`RouteUrls.signUpPageWithRedirect`, `client/src/app/sign-up/[[...slug]]/page.tsx`), which preserves
  `redirect_url`. After sign-up + email verification, Clerk returns to the claim page → case (C).

The `installId` is the **only** thing threaded through sign-in/sign-up. The single-use GHL code was
already consumed in §4.1, so none of the login detours can break it. The TTL (1h) is what bounds how
long a brand-new user has to finish sign-up; if they blow past it, the claim page shows "this install
link expired, click Install again from HighLevel."

### 4.3 Sequence per case

```
(C) logged in:
  GHL → /api/oauth/install/ghl (exchange, stash) → /connect/ghl?install=ID
      → pick workspace → POST claim → ConnectorAccount created → "Open in Desktop?"

(B) not logged in:
  … → /connect/ghl?install=ID → Clerk middleware → /sign-in?redirect_url=/connect/ghl?install=ID
      → login → /connect/ghl?install=ID → (C)

(A) not registered:
  … → /connect/ghl?install=ID → /sign-in?redirect_url=… → "Sign up" → /sign-up?redirect_url=…
      → verify email → /connect/ghl?install=ID → (C)
```

### 4.4 Two entry points, one connector

We still want the **in-app** "Connect HighLevel → OAuth" button (app-initiated) — it's the smaller
lift and reuses everything in §2. So the GHL connector ends up supporting **both**:

- **App-initiated OAuth** — reuse the existing `initiate`/`callback` machinery; just add a GHL
  `OAuthProvider` and flip the connector's auth metadata. `state` carries `workbookId` as today.
- **Marketplace-initiated OAuth** — the new pending-install path in §4.1–4.3.

Both end at the same place: a `ConnectorAccount` with `authType: OAUTH`, GHL tokens encrypted, and
`locationId` stored in `extras`.

## 5. Detailed component changes

### 5.1 Database (`server/prisma/`)

- **New model `PendingOAuthInstall`** + migration:
  ```prisma
  model PendingOAuthInstall {
    id                   String   @id           // the unguessable installId (treat as secret)
    createdAt            DateTime @default(now())
    expiresAt            DateTime               // now + 1h; cleaned up by cron
    service              String                 // "GOHIGHLEVEL"
    encryptedTokens      Json                   // same envelope as ConnectorAccount.encryptedCredentials
    locationId           String?                // GHL Location resolved from token exchange
    locationDisplayName  String?                // for the claim page UI
    claimedByUserId      String?                // set on claim; row then deleted (audit only if kept)
    @@index([expiresAt])
  }
  ```
  Add cleanup to a scheduled job (and to `WorkbookService.delete`? No — not workbook-scoped; it's a
  standalone short-lived row, so a cron sweep on `expiresAt` is enough).

### 5.2 Server OAuth (`server/src/oauth/`)

- **New `providers/gohighlevel-oauth.provider.ts`** implementing `OAuthProvider`:
  - `generateAuthUrl` → `https://marketplace.gohighlevel.com/oauth/chooselocation` with
    `response_type=code`, `client_id`, `redirect_uri`, `scope` (see §8). `chooselocation` forces a
    **Location-level** install (single location token) — what we want for v1.
  - `exchangeCodeForTokens` → `POST https://services.leadconnectorhq.com/oauth/token`
    (`grant_type=authorization_code`). GHL's response includes `access_token`, `refresh_token`,
    `expires_in`, **`locationId`**, **`companyId`**, `userType`. Map `locationId` into
    `OAuthTokenResponse.workspace_id`.
  - `refreshTokens` → same endpoint, `grant_type=refresh_token`. GHL access tokens are ~24h, so
    refresh matters; the existing `oauthExpiresAt`/`POST /oauth/refresh` machinery already covers it
    once the provider implements `refreshTokens`.
  - Read `GOHIGHLEVEL_CLIENT_ID` / `GOHIGHLEVEL_CLIENT_SECRET` from config. Register the provider in
    the provider factory/map alongside the others.
- **New `oauth-install.controller.ts`** (generic, not GHL-specific so future marketplaces reuse it):
  - `GET /oauth/install/:service` — **public**. Calls
    `OAuthService.redeemAndStashInboundInstall(service, code, query)`; 302-redirects to
    `/connect/:service?install=<installId>`. On error (bad/expired code) redirect to a friendly error.
  - `GET /oauth/install/:installId` — **auth-gated**. Returns pending-install metadata for the claim
    page (never returns tokens).
  - `POST /oauth/install/:installId/claim` — **auth-gated**. Body `{ workbookId?: string }`. Calls
    `OAuthService.claimInboundInstall(installId, actor, workbookId)`.
- **`oauth.service.ts`** — two new methods:
  - `redeemAndStashInboundInstall(service, code)` — `provider.exchangeCodeForTokens(code)`,
    encrypt tokens, INSERT `PendingOAuthInstall`, return `installId`.
  - `claimInboundInstall(installId, actor, workbookId?)` — load + TTL-check the pending row; if
    `workbookId` omitted, create a fresh workbook (`WorkbookService.create`, named e.g. "HighLevel");
    then **refactor `createOAuthAccount`** so the token-persisting tail can be called with an
    already-exchanged `OAuthTokenResponse` (today it's only reachable through `handleOAuthCallback`).
    Store `locationId` in `ConnectorAccount.extras`. Delete the pending row. Return
    `{ connectorAccountId, workbookId }`.
  - **Do not** route inbound through `handleOAuthCallback` — that path enforces
    `state.userId === actor.userId`, which by construction we can't satisfy. Keeping inbound separate
    preserves that security check for the app-initiated path.

### 5.3 GHL connector (`server/src/remote-service/connectors/library/gohighlevel/`)

- `gohighlevel-connector.ts` metadata: add `oauth: { label: 'OAuth' }`; change registration
  `supportedAuthMethods: ['oauth', 'user_provided_params']`.
- `createConnector(ctx)`: branch on `ctx.connectorAccount.authType === 'OAUTH'` →
  `accessToken = await ctx.getOAuthAccessToken(ctx.connectorAccount.id)` (this auto-refreshes via the
  provider) and read `locationId` from `ctx.connectorAccount.extras` (OAuth installs no longer get a
  user-typed Location ID — it comes from the token exchange). Keep the PIT branch unchanged.
- The API client (`gohighlevel-api-client.ts`) is already token-agnostic (`Authorization: Bearer …`),
  so no change beyond passing the OAuth access token instead of the PIT.
- Update the class-comment "OAuth … is deferred" note and `STATE.md` (auth row, coverage) per the
  repo rule about keeping connector docs current; update the OAuth/Visible cells in
  `docs/connector-build.md`.

### 5.4 Web client (`client/`)

- **New route `app/connect/[service]/page.tsx`** — the claim page (§4.2). **Must not** be in
  `RouteUrls.publicRoutePatterns` so the middleware auto-redirects A & B. Reuse the existing workspace
  picker / "create workbook" components.
- **`lib/api/oauth-install.ts`** + `hooks/use-oauth-install.ts` + cache key in `lib/api/keys.ts` +
  types in `types/server-entities/` (follow the client/server sync rule in CLAUDE.md).
- Confirm `RouteUrls.signInPageWithRedirect` / `signUpPageWithRedirect` round-trip the
  `/connect/...?install=...` URL intact (there's a known Clerk `forceRedirectUrl` quirk noted in the
  sign-in page — verify it carries the query string).

### 5.5 Desktop app (`scratch-desktop/`) — the "return to / download the app" requirement

The marketplace install happens in a browser (GHL web), so the user starts outside the desktop app.
The claim page should offer **"Open in Scratch Desktop"** (and a download fallback) so desktop users
end up in the app. The portable `installId` makes this clean — the desktop app can do the claim
itself:

- The claim page's "Open in Desktop" builds `scratch://oauth-install?install=<installId>`
  (mirror `client/src/utils/route-urls.ts` deep-link builders), with the existing 2-second
  `/open/[...path]` intermediary fallback → **download page** if the protocol doesn't resolve (i.e.
  desktop not installed). This satisfies "get the user to download the desktop app or return to it."
- Desktop changes:
  - Add `oauth-install` to the deep-link **whitelist** in `scratch-desktop/src/main/index.ts` (~L129,
    next to `oauth-callback`).
  - Map it in `scratch-desktop/src/renderer/src/lib/deep-link-routes.ts` to a new
    `/oauth-install?install=…` route.
  - New `pages/OAuthInstallPage.tsx`: reads `install`, calls
    `scratchApiClient.oauthInstall.claim(installId, { workbookId })`, navigates to the new workbook.
  - **The three cases come for free on desktop**: `DeepLinkBridge.tsx` already **stashes a pending
    deep link in `sessionStorage` when unauthenticated and replays it after login**, and desktop login
    is the device-code flow in `AuthProvider.tsx`. So an unauthenticated desktop user who clicks "Open
    in Desktop" logs in (device code), then the claim auto-resumes — same A/B/C resolution as web.

So there are **two viable claim surfaces**, both keyed on `installId`:
- **Claim in web** (user authenticates with Clerk in the browser), then optionally open desktop to the
  workbook.
- **Claim in desktop** (user authenticates via device code), web only hands off the `installId`.

Recommend the claim page present an early **"Continue in browser" vs "Open desktop app"** choice and
let `installId` flow to whichever surface the user picks.

### 5.6 GHL marketplace portal (out of repo — document for whoever owns the listing)

- Set the app's **redirect URL** to the live install page on the **web host**, i.e.
  `https://app.scratch.md/oauth/install/hl` (prod) / `https://test.scratch.md/oauth/install/hl` (test)
  — **not** localhost, and **not** the API host. The slug is **`hl`, not `gohighlevel`**: GHL's redirect-URL
  validator rejects any URL containing its brand ("highlevel", "gohighlevel", and even "ghl"), so the inbound
  install uses the brand-free slug `hl`, which the server maps back to the `GOHIGHLEVEL` provider
  (`INSTALL_SLUG_TO_SERVICE_KEY` in `oauth-install.service.ts`). This URL must match the chooselocation
  install link's `redirect_uri` and the redirect_uri our server derives — all `app.scratch.md/oauth/install/hl`.
  GHL bakes the install link's `redirect_uri` from the **first** configured redirect URL, so list the
  inbound prod URL first; remove `http://localhost:3000/...` from a public listing (the original
  rejection cause — localhost is unreachable for the reviewer). Keep the `/oauth/callback` URLs (app/test/local;
  they serve the app-initiated flow) and keep localhost only in a separate dev app.
- Configure the **scopes** in §8.
- Provide the reviewer: the test account (username/password) + numbered steps (Install → choose
  Location → land on claim page → pick/create workspace → see data).

## 6. GHL-specific OAuth details

- **Consent host:** `https://marketplace.gohighlevel.com/oauth/chooselocation` (Location-level) —
  already noted in `gohighlevel-api-client.ts`'s header comment.
- **Token host:** `https://services.leadconnectorhq.com/oauth/token` (same base as all v2 REST). The
  mandatory `Version: 2021-07-28` header applies to API calls, not the token endpoint.
- **Location vs agency:** a Location install returns a location-scoped token directly (simple, v1
  target). An **agency/company** install returns a company token that must be exchanged for a
  per-location token (`oauth/locationToken`) — this is the "agency → location exchange" flagged as
  deferred in the api-client comment. **Defer multi-location/agency to v2**; for v1 force
  `chooselocation` so we always get a single location token.
- **Token lifetime:** access ~24h, refresh token rotates. Implement `refreshTokens`; rely on the
  existing `oauthExpiresAt` + refresh path.
- **Scopes** (§8) must match the marketplace listing exactly or the install errors.

## 7. Security considerations

- **`installId` is a bearer secret.** Anyone holding it can claim the (anonymous) tokens. Therefore:
  high-entropy random id, **single-use** (deleted on claim), **short TTL** (1h), claim requires an
  authenticated Scratch user, and it's only ever transmitted over HTTPS to our own domains + the
  `scratch://` deep link.
- **Orphan tokens** (consented but never claimed) live at most 1h, encrypted at rest, swept by cron.
- **Don't weaken the app-initiated check.** Inbound gets its own endpoints; the
  `state.userId === actor.userId` assertion in `handleOAuthCallback` stays intact for app-initiated.
- **Open-redirect hygiene** on the `redirect_url` carried through sign-in/sign-up — reuse the
  `isSafeInternalPath`-style validation already used by the settings return-path utility.
- **Deep-link whitelist** stays strict (`scratch-desktop/src/main/index.ts` already rejects `..` and
  unlisted routes); add only `oauth-install`.

## 8. Open decisions (need a call before building)

1. **Scopes for the listing.** Minimum for current connector coverage:
   `contacts.readonly`, `opportunities.readonly`, `locations/customFields.readonly`, plus the write
   scopes for push (`contacts.write`, `opportunities.write`, `objects.write`/records,
   `locations/customFields.write`). Confirm the exact write-scope names against GHL's current scope
   list and whether we want read-only-first for faster approval.
2. **Workspace on claim:** auto-create a fresh "HighLevel" workbook by default, or always show a
   picker? (Recommend: default to create-new with an "add to existing" option — matches the mental
   model that "installing an app" spins up a new integration.)
3. **Primary claim surface:** push marketplace users to **web** claim (lower friction, no download) and
   treat desktop as opt-in, or detect/prefer desktop? (Recommend web-first for the reviewer; desktop
   handoff as the "Open in app" affordance.)
4. **Agency installs:** confirm v1 is Location-only (`chooselocation`) and agency→location is v2.

## 9. Phased implementation

- **Phase 0 — unblock the listing fast:** stand up the live redirect endpoint + app-initiated GHL
  OAuth (provider + connector metadata + `createConnector` branch). Even before the full inbound UX,
  a live (non-localhost) redirect that completes *some* working install lets the reviewer test, and
  ships the test account + steps for rejection reason (2).
- **Phase 1 — inbound core:** `PendingOAuthInstall` model + migration, `oauth-install.controller.ts`,
  `redeemAndStashInboundInstall` / `claimInboundInstall`, web `/connect/[service]` claim page handling
  cases A/B/C. This is what actually passes the marketplace install test.
- **Phase 2 — desktop handoff:** `scratch://oauth-install` whitelist + route + `OAuthInstallPage`,
  "Open in Desktop" affordance + download fallback on the claim page.
- **Phase 3 — hardening:** TTL cleanup cron, audit logging on claim, agency/multi-location (v2),
  error/expiry UX polish.

## 10. Testing

- **Unit:** GHL provider (auth-url shape, token + refresh parsing incl. `locationId`); service
  redeem/claim incl. TTL expiry and double-claim rejection.
- **Integration:** end-to-end inbound against the GHL test Location, exercising all three auth states
  (new user, logged-out returning user, logged-in user), plus the desktop deep-link claim.
- **Manual / reviewer rehearsal:** run the exact numbered steps we'll hand the GHL reviewer, from a
  clean browser with no Scratch session, to confirm a brand-new user can go marketplace-Install →
  sign-up → land in a workbook with HighLevel data.

---

### Key file references (for implementation)

| Area | File |
| --- | --- |
| OAuth controller / service / provider iface | `server/src/oauth/oauth.controller.ts`, `oauth.service.ts`, `oauth-provider.interface.ts` |
| Provider examples | `server/src/oauth/providers/{notion,zoho,airtable}-oauth.provider.ts` |
| State payload | `packages/shared-types/src/dto/oauth/oauth-state-payload.ts`, `server/src/oauth/types.ts` |
| ConnectorAccount model | `server/prisma/schema.prisma` (~L141) |
| Credential encryption | `server/src/utils/encryption.ts` |
| GHL connector | `server/src/remote-service/connectors/library/gohighlevel/gohighlevel-connector.ts`, `gohighlevel-api-client.ts`, `STATE.md` |
| Web OAuth callback (public → step-2) | `client/src/app/oauth/callback/page.tsx`, `callback-step-2/page.tsx` |
| Web auth (Clerk) | `client/src/proxy.ts`, `client/src/app/sign-in/...`, `client/src/app/sign-up/...`, `client/src/utils/route-urls.ts` |
| Server auth guard / Clerk strategy | `server/src/auth/scratch-auth.guard.ts`, `clerk.strategy.ts` |
| Desktop deep link | `scratch-desktop/src/main/index.ts`, `src/renderer/src/components/DeepLinkBridge.tsx`, `src/renderer/src/lib/deep-link-routes.ts`, `src/renderer/src/pages/OAuthCallbackPage.tsx` |
| Desktop auth (device code) | `scratch-desktop/src/renderer/src/providers/AuthProvider.tsx` |
