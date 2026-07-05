# Client-Credentials OAuth (2-legged / server-to-server) + Wix migration

This document covers the `client_credentials` OAuth strategy added to the OAuth
provider framework, the Wix Blog migration that motivated it, and — importantly —
a **reusable upgrade playbook** for the next service that deprecates its 3-legged
"custom auth" in favor of client-credentials (the Whalesync app upgrade is next).

## Why this exists — the upgrade issue

Wix deprecated its **"Custom Authentication"** flow (the classic 3-legged OAuth:
redirect for consent → `?code` → exchange for a **refresh token** → refresh the
access token). Per Wix's own docs, _"Custom authentication is no longer available
for new apps,"_ so **new client installs could no longer complete the redirect**,
which is the bug this fixes ("the final redirect doesn't work anymore").

The replacement is the **OAuth Client Credentials** grant — genuinely 2-legged /
server-to-server:

- **No authorization code. No refresh token.**
- The one long-lived credential is a per-site **install identifier** (Wix calls it
  the app **`instanceId`**).
- A fresh access token is **minted on demand** from `client_id` + `client_secret`
  + the install identifier. "Refresh" is just a **re-mint** with the same id.

This same shape (a service moving 3-legged custom-auth → client-credentials) is
expected to recur, so the abstraction below is deliberately service-agnostic.

## The abstraction: `OAuthStrategyKind`

`server/src/oauth/oauth-provider.interface.ts` adds:

```ts
export type OAuthStrategyKind = 'authorization_code' | 'client_credentials';

export interface OAuthProvider {
  // ...existing methods (all now take a versioned OAuthAppCredentials)...
  strategyKind?(): OAuthStrategyKind;                                   // default: 'authorization_code'
  mintTokenFromInstall?(installIdentifier: string, credentials: OAuthAppCredentials): Promise<OAuthTokenResponse>;
}
```

- A provider that **omits** `strategyKind()` is treated as `'authorization_code'`,
  so every pre-existing provider is untouched (invisible, backward-compatible).
- A `'client_credentials'` provider implements **`mintTokenFromInstall()`** and
  leaves `exchangeCodeForTokens`/`refreshTokens` throwing (never called for it).
- Like every other provider method, `mintTokenFromInstall` receives the **versioned**
  `OAuthAppCredentials` (client_id/secret) resolved by `OAuthAppCredentialResolver` — a
  token can only be minted for an install with the **same app** that created it, so the
  credentials MUST be the generation the connection was created under (see
  `oauth-app-version.ts`). The provider never reads `*_CLIENT_ID` from the environment.
- `mintTokenFromInstall` MUST return a concrete `expires_in` — vendors typically
  omit it from the token response, and an undefined expiry would make the token
  look valid forever and never get re-minted (silent auth failure after it lapses).

### Where the orchestrator branches (all in `oauth.service.ts`)

The token lifecycle stays owned by `OAuthService`; only three spots learn the
strategy, keyed off `provider.strategyKind?.()`:

1. **`handleOAuthCallback`** — for a client-credentials provider, mint from
   `callbackData.instanceId` instead of exchanging a `code`.
2. **`refreshOAuthTokens`** — re-mint from the stored install identifier
   (`oauthWorkspaceId`) instead of requiring a refresh token.
3. **`mintClientCredentialsToken(service, provider, installIdentifier, credentials)`** —
   the shared helper both call (it forwards the resolved app-generation credentials).

`getValidAccessToken` / `isTokenExpired` are **unchanged** — they already delegate
freshness to `refreshOAuthTokens`, which now re-mints transparently.

### Storage

Nothing new persisted. The install identifier is stored in the existing
`DecryptedCredentials.oauthWorkspaceId` (it flows there via
`OAuthTokenResponse.workspace_id` in `createOAuthAccount`, exactly like Zoho's data
center and Shopify's shop domain). `authType` stays `AuthType.OAUTH`; there is **no
Prisma migration** and **no new UI-facing `AuthMethod`** — the Connect UX is byte
-identical to `'oauth'` (a single Connect button), so the connector keeps
`supportedAuthMethods: ['oauth']`. The reuse lives entirely in the provider layer.

## The Wix Connect flow (kept close to the old app-initiated UX)

We reuse the **app-initiated callback path** (not the marketplace/inbound-install
infra) because Wix's external-install redirect round-trips our own OAuth `state`:

```
Connect click → POST /oauth/WIX_BLOG/initiate                (unchanged route/guard)
  WixOAuthProvider.generateAuthUrl() returns Wix's app-installer URL:
    https://www.wix.com/app-installer
      ?appId=<WIX_CLIENT_ID>
      &postInstallationUrl=<REDIRECT_URI>?state=<our base64 state>
      [&shareUrlId=<WIX_SHARE_URL_ID> for unlisted apps]
→ Wix install/consent (once) → redirect back to <REDIRECT_URI>
      ?state=<ours>&appId=&tenantId=&instanceId=            ← NO code
→ client callback page POSTs { instanceId, state } to POST /oauth/WIX_BLOG/callback
→ handleOAuthCallback: mint from instanceId, create ConnectorAccount in the CURRENT
  workbook, storing instanceId in oauthWorkspaceId.
```

### Exact Wix token call (verified against the live docs)

```
POST https://www.wixapis.com/oauth2/token
Content-Type: application/json
{ "grant_type": "client_credentials",
  "client_id": "<APP_ID>", "client_secret": "<APP_SECRET_KEY>",
  "instance_id": "<APP_INSTANCE_ID>" }
→ { "access_token": "..." }    // valid 4 hours; no expires_in; no refresh token
```

(Docs: [About OAuth](https://dev.wix.com/docs/build-apps/develop-your-app/access/authentication/about-oauth),
[Authenticate Using OAuth](https://dev.wix.com/docs/build-apps/develop-your-app/access/authentication/authenticate-using-oauth),
[External Install Flow](https://dev.wix.com/docs/build-apps/launch-your-app/app-distribution/install-your-app/set-up-the-external-install-flow).)

### Config & dashboard

- Env: `WIX_CLIENT_ID` (App ID), `WIX_CLIENT_SECRET` (App secret), optional
  `WIX_SHARE_URL_ID` (only for an **unlisted** app), and the existing `REDIRECT_URI`
  (origin of the post-install callback; **must be HTTPS** — localhost dev won't work).
- Wix app dashboard: confirm App ID/secret on the **OAuth** page; configure the Blog
  draft-posts + members permission scopes.
- **Clear the custom-auth "App URL" and "Redirect URL" on the OAuth page** (or use a
  brand-new app, which has no such fields). This is essential — see the gotcha below.

### The "tiny popup with a `?token=`" gotcha (custom-auth App URL)

Symptom during install: a full-screen Wix site picker, then a separate small window
opens at your App URL with a `?token=<...>` query param (e.g.
`https://test.scratch.md/...?token=...`), plus a Wix page saying "Go to the other tab
to complete installation."

Cause: that is the **deprecated custom-authentication handshake**, driven entirely by
the Wix dashboard's **"App URL"** field. Per Wix's custom-auth doc: *"Enter an App URL.
Wix redirects your new users to this URL when they install your app … Wix redirects the
user to your app URL with the authorization token."* The `token` is the legacy custom-auth
authorization token, and the separate window (Wix closes it via `installer/close-window`,
which is why the OAuth page's COOP had to be `unsafe-none`) is inherent to that flow. It
fires as long as the **App URL is set**, independent of the external-install flow.

Fix (dashboard only — no Scratch code change): **remove the custom-auth App URL / Redirect
URL** (or register a fresh OAuth-only app — new apps can't use custom auth, so the fields
don't exist). Installs then run purely through the external-install `postInstallationUrl`
our provider builds, which returns `instanceId` (no `token`, no popup). Scratch's client
already navigates the same tab (`window.location.href`), so with custom auth off the flow
is a single-window redirect.

**For the Whalesync upgrade:** check the service's dashboard for the equivalent legacy
"App URL / redirect" field and clear it — a leftover legacy redirect target is the most
likely cause of a stray install popup.

## Status

Built end-to-end on one branch (`wix-auth-fix`): server + web client + desktop.

- **Server — DONE:** `OAuthStrategyKind` + `mintTokenFromInstall` on the provider
  interface; `WixOAuthProvider` rewritten for client-credentials + the app-installer
  URL; `handleOAuthCallback` / `refreshOAuthTokens` branches +
  `mintClientCredentialsToken`; `OAuthCallbackRequest.instanceId` (server-local + the
  shared-types wire type); connector token TTL hint fixed 5m → 4h; `.env.example` Wix
  block; provider unit test.
- **Web client — DONE:** both OAuth callback hops (`/oauth/callback` →
  `/oauth/callback-step-2`) accept `instanceId` as the alternative to `code` (Wix
  returns no code) and forward it into the callback POST; success check is now
  "code **or** instanceId present". The connect UI is unchanged
  (`supportedAuthMethods` stays `['oauth']`, single Connect button).
- **Desktop — DONE:** the `scratch://oauth-callback` deep-link handler now passes
  `instanceId` through its query allowlist, and `OAuthCallbackPage` accepts it — so
  the app-initiated desktop connect works the same as web (system browser → web
  callback → `scratch://` deep link → POST).
- **Dashboard + live QA — TODO (not code):** point the Wix app at OAuth, set the
  Blog/members scopes, and run the install link end-to-end on test, confirming a real
  Blog pull/publish round-trip with a minted token. One thing to validate there: that
  the connector's `@wix/sdk` `OAuthStrategy` accepts an app (client-credentials) token
  — if it doesn't, switch the connector's client to
  `AppStrategy({ appId, appSecret, instanceId })` (the `instanceId` is available on
  the account as `oauthWorkspaceId`).

## Existing connections

Legacy Wix accounts were custom-auth (refresh-token based) with an **empty**
`oauthWorkspaceId` — no `instanceId` was ever captured, and there is no Wix API to
enumerate installs, so they **cannot be auto-migrated**. `refreshOAuthTokens` now
throws a typed "must be reconnected" error for a client-credentials account with no
install identifier. Spinner has effectively no Wix users, so the plan is simply
**forced reconnect** (no backfill). Going forward, `instanceId` is captured on the
install redirect; subscribing to Wix's **App Instance Installed webhook** would make
capture robust if we ever need it.

---

## Reusable upgrade playbook — doing this for the next service (e.g. Whalesync)

When another service deprecates 3-legged custom-auth in favor of client-credentials,
the migration is now small and mechanical:

1. **Rewrite (or add) the provider** under `server/src/oauth/providers/`:
   - `strategyKind() => 'client_credentials'`.
   - `mintTokenFromInstall(installIdentifier, credentials)` → POST the service's
     client-credentials token endpoint using `credentials.clientId`/`clientSecret`;
     return `{ access_token, expires_in: <hardcode the documented TTL>,
     workspace_id: installIdentifier }`.
   - `generateAuthUrl(state, credentials)` → build the service's **external install
     link** from `credentials.clientId`/`redirectUri`, baking our `state` into the
     return/callback URL so it round-trips.
   - `exchangeCodeForTokens`/`refreshTokens` → `Promise.reject(...)` (unused).
2. **Register** it in `oauth.module.ts` + the `providers` map in `oauth.service.ts`
   under the uppercased service key. **No other orchestrator changes** — the
   `strategyKind` branches added here are generic.
3. **Connector**: keep `supportedAuthMethods: ['oauth']` (same Connect UX). If the
   runtime SDK needs the install id, read it from `oauthWorkspaceId`.
4. **Client (MR-2 equivalent)**: ensure the callback page reads the service's
   install identifier from the redirect and POSTs it as `instanceId`.
5. **Env/dashboard**: add `<SERVICE>_CLIENT_ID` / `_SECRET`, configure scopes, ensure
   the callback URL is HTTPS.

### How to test it (fast path)

- **Provider unit test** (see `providers/__tests__/wix-oauth.provider.spec.ts` as the
  template): assert `strategyKind`, that `generateAuthUrl` builds the install link
  with `state` round-tripped, that `mintTokenFromInstall` POSTs the right body to the
  right endpoint and returns a hardcoded `expires_in`, and that
  `exchangeCodeForTokens`/`refreshTokens` reject.
- **Re-mint path**: because "refresh" is just a re-mint, you can exercise the whole
  token lifecycle without waiting for expiry — force `isTokenExpired` true (or null
  the stored `oauthExpiresAt`) and confirm `getValidAccessToken` re-mints from
  `oauthWorkspaceId`.
- **End-to-end**: run the install link on test, confirm the redirect carries the
  install identifier, confirm a real read/write round-trip through the connector.

The key gotcha, worth repeating: **always return a concrete `expires_in` from
`mintTokenFromInstall`.** These token endpoints usually omit it, and an unset expiry
silently disables re-minting.
