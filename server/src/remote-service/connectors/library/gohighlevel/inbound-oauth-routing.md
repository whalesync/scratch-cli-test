# Inbound (Marketplace-Initiated) OAuth Routing — How It Works

> **Status: as-built.** This describes the routing that actually ships on the `gohighlevel-oauth`
> branch — not a proposal. The design rationale and the deferred phases (desktop handoff, hardening)
> live in [`inbound-oauth-plan.md`](./inbound-oauth-plan.md); this doc is the concise "where does the
> request go, and why" reference, plus how the shape was **borrowed from Whalesync's Webflow flow**.
>
> A rendered, diagram-first version of this same content is in
> [`inbound-oauth-routing.html`](./inbound-oauth-routing.html) — open it in a browser.

## The one-paragraph version

A connector's marketplace (GoHighLevel) starts the OAuth and redirects the browser to a **public web
page on the Scratch web app** — `app.scratch.md/oauth/install/:slug?code=…` — **not** the API host.
That page immediately POSTs the one-time `code` to a **public API endpoint** (`POST /oauth/install/:slug`),
which redeems it for tokens **right away** (the code expires in minutes), encrypts them, and stashes
them in a short-lived `PendingOAuthInstall` row keyed by an unguessable, single-use **`installId`**.
The page then forwards to an **auth-gated claim page** (`/connect/:slug?install=<installId>`); Clerk
makes the visitor sign up / sign in if needed (the `installId` survives the detour in the URL), and a
deliberate **Connect** click moves the tokens out of the pending row into a real `ConnectorAccount`
inside a freshly-created workbook.

## Why "inbound" needs its own routing

Every other OAuth connector is **app-initiated**: the user is already inside Scratch, logged in, in a
workbook, and clicks "Connect". We mint a `state` payload up front carrying `userId` + `workbookId`,
so the callback knows exactly where the tokens belong.

The marketplace reviewer (and any real marketplace install) does the opposite — they start on the
**connector's** side, click **Install**, and arrive at Scratch with **no session, no workbook, and
maybe no account**. There is no `state` we could have minted. That is the whole reason for a separate
set of routes. (Original rejection reasons for the GHL listing: a `localhost` redirect URL the
reviewer couldn't reach, and no test credentials — see `inbound-oauth-plan.md §1`.)

## The two `/oauth/install/:slug` halves (don't confuse them)

The same path string exists on **two different hosts**, doing two different things:

|                                              | Host                       | What it is                                                                              | Auth                           |
| -------------------------------------------- | -------------------------- | --------------------------------------------------------------------------------------- | ------------------------------ |
| **Web page** `GET /oauth/install/:slug`      | `app.scratch.md` (Next.js) | The page the marketplace redirect lands on. Reads `?code=`, relays it, forwards on.     | Public (`publicRoutePatterns`) |
| **API endpoint** `POST /oauth/install/:slug` | `api.scratch.md` (NestJS)  | Redeems the code → tokens, stashes them, returns `{ installId }` (JSON, **not** a 302). | Public                         |

The marketplace redirect target is the **web page**. The web page calls the **API endpoint**. Landing
on the web host (rather than the API host) is deliberate and is the part borrowed from Whalesync — see
below. It also keeps the token exchange's `redirect_uri` trivially derivable: it's just
`<REDIRECT_URI origin>/oauth/install/:slug`, no API-host knowledge or `x-forwarded` reconstruction.

> **Brand-free slug.** GHL's redirect-URL validator rejects any URL containing its brand
> (`highlevel` / `gohighlevel` / `ghl`), so the GHL listing uses the slug **`hl`**, mapped back to the
> `GOHIGHLEVEL` service key by `INSTALL_SLUG_TO_SERVICE_KEY` in `oauth-install.service.ts`. Every other
> connector's slug is just its lowercased service key.

## The route-by-route flow

```
GoHighLevel marketplace  ──Install──▶  chooselocation consent  ──approve──▶
  ① 302 to  https://app.scratch.md/oauth/install/hl?code=<one-time>
```

| #   | Where                 | Route / function                                                                                                          | What happens                                                                                                                                                                                                                                                                                                          |
| --- | --------------------- | ------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ①   | Marketplace → **web** | `client/src/app/oauth/install/[service]/page.tsx`                                                                         | Public Next.js page; reads `?code=` (or `?error=`). Strict-Mode-guarded so the single-use code is redeemed once.                                                                                                                                                                                                      |
| ②   | web → **API**         | `POST /oauth/install/:slug` → `OAuthInstallController.redeemInboundInstall` → `OAuthInstallService.redeemAndStashInstall` | Resolves slug→service, calls `OAuthService.exchangeInboundCodeForTokens` (provider exchanges the code **now**), encrypts the tokens, INSERTs `PendingOAuthInstall { id: pin_…, encryptedCredentials, workspaceId, expiresAt: now+1h }`, returns `{ installId }`.                                                      |
| ③   | web (redirect)        | `router.replace('/connect/hl?install=<installId>')`                                                                       | The page forwards to the claim page carrying only the `installId`. The GHL code is already spent.                                                                                                                                                                                                                     |
| ④   | **web** claim page    | `client/src/app/connect/[service]/page.tsx` (**not** public)                                                              | Clerk middleware gates it. States A/B/C resolved here (below). Once authenticated, `GET /oauth/pending-install/:installId` fetches display metadata (**never tokens**).                                                                                                                                               |
| ⑤   | claim → **API**       | `POST /oauth/pending-install/:installId/claim` → `OAuthInstallService.claimInstall`                                       | Atomic single-use reserve (`updateMany` flips `claimedAt` null→now), auto-creates a workbook, `createConnectorAccountFromOAuthTokens` (connection method `OAUTH_SYSTEM`) moves the tokens into a real `ConnectorAccount`, deletes the pending row. Rolls back the workbook + releases the reservation on any failure. |
| ⑥   | web                   | `router.replace(workbookPageUrl)`                                                                                         | User lands in the new workbook, HighLevel connected.                                                                                                                                                                                                                                                                  |

## The three auth states (resolved at step ④)

Because the claim page is **not** in `publicRoutePatterns`, Clerk's middleware does the work — no
per-state code in the page:

- **(C) logged in** — page renders, user clicks **Connect**, claim runs. Done.
- **(B) registered, not logged in** — Clerk bounces to `/sign-in?redirect_url=/connect/hl?install=…`;
  after login, back to the claim page → case (C).
- **(A) no account** — same, via the "Sign up" cross-link; after sign-up + email verification, back to
  the claim page → case (C).

The **`installId` is the only thing threaded through** sign-up/sign-in (it rides in the URL via
Clerk's `returnBackUrl`). The fragile one-time GHL `code` was already consumed at step ②, so none of
the login detours can break it. The 1-hour TTL bounds how long a brand-new user has to finish signing
up before the link dies.

## Why redeem up front (and accept orphan tokens)

GHL auth codes are single-use and expire in minutes. A brand-new user in case (A) might take ten
minutes to sign up and verify email — redeeming lazily at claim time would routinely fail. So we
redeem the instant we land and stash the result. The cost is that we briefly hold **orphan tokens not
yet attached to any user**. Mitigations: encrypted at rest (same AES-256-GCM envelope as
`ConnectorAccount`), 1-hour TTL, single-use (`installId` deleted on claim), and the `@@index([expiresAt])`
supports a future cleanup sweep.

## Security: the `installId` is a bearer secret

Anyone holding a valid `installId` can claim its (anonymous) tokens. So: high-entropy random id
(`pin_` + 32 random bytes, base64url), **single-use** (deleted on claim), **short TTL** (1h), the claim
endpoint requires an authenticated Scratch user, the claim is an **atomic reserve** (a double-submit
can't spawn two connections), and the id only ever travels over HTTPS to our own domains. The
app-initiated path keeps its own `state.userId === actor.userId` check intact — inbound gets separate
endpoints precisely so it can't weaken that.

---

## Borrowed from Whalesync's Webflow flow

Whalesync (our sister project, `../../whalesync` relative to the repos root) solved the same problem
for the **Webflow App Marketplace**. Scratch's inbound flow borrows its **shape**; the key files in
Whalesync are:

- `dusky/pages/oauth-callback/connector-app-store/[connectorType].tsx` — the marketplace landing
  **web page** (not an API route).
- `api/bottlenose/src/temporary-external-connections/temporary-external-connections.service.ts` —
  `createTemporaryExternalConnection` + `claimTemporaryExternalConnections`.
- `api/bottlenose/prisma/schema.prisma` — the `TemporaryExternalConnection` model.

### What we took (the same in both)

1. **Land on a public web page, not the API host.** Whalesync's marketplace redirect targets a Next.js
   page; so does ours. (This is the specific precedent called out in `inbound-oauth-plan.md`.)
2. **Redeem the code immediately, server-side, on landing.** Whalesync's page calls
   `oAuthAuthorizeCallback` right away; ours POSTs to `/oauth/install/:slug` right away. Neither defers
   the fragile one-time code through the login detour.
3. **Stash the tokens in a short-lived, encrypted "pending" record.** Whalesync →
   `TemporaryExternalConnection`; Scratch → `PendingOAuthInstall`. **Both encrypt the tokens and both
   use a 1-hour TTL.**
4. **Convert the pending record into a real connection only after the user authenticates.** Whalesync
   → `ExternalConnection`; Scratch → `ConnectorAccount`. Both use **Clerk** for auth.

### What we changed (and why)

| Aspect                | Whalesync (Webflow)                                                                                           | Scratch (HighLevel)                                                                | Why we diverged                                                                                                                                                                                                                                                                                                                                                      |
| --------------------- | ------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Correlation token** | the installer's **email** (read from the connector's user profile), matched to the authenticated user's email | an unguessable, single-use **`installId`** carried in the URL                      | Email-matching assumes the marketplace identity's email equals the Scratch sign-up email, silently mis-attaches if a different same-email person claims, and needs the connector to expose an email. A GHL Location token identifies a **Location**, not a person — there's no reliable user email. The `installId` needs none of that and is explicitly single-use. |
| **Claim trigger**     | **automatic** — the sync-flow screen claims _all_ of the email's pending rows from the last hour              | **explicit** — the user clicks **Connect** on a per-install claim page             | One install = one deliberate claim of one specific token; no "sweep everything for this email" ambiguity.                                                                                                                                                                                                                                                            |
| **Auth detour**       | redirect to `/sign-in`, claim later from the app                                                              | non-public claim page; Clerk bounces through sign-up/in with `?install=` preserved | Keeps the whole flow on one URL that carries the correlation token, so A/B/C fall out of Clerk middleware for free.                                                                                                                                                                                                                                                  |
| **Final entity**      | `ExternalConnection` attached to the user                                                                     | `ConnectorAccount` inside a **newly-created workbook**                             | Scratch connections live in a workbook; "installing an app" spins up a fresh one.                                                                                                                                                                                                                                                                                    |
| **Landing path**      | `/oauth-callback/connector-app-store/:connectorType`                                                          | `/oauth/install/:slug` (+ separate `/connect/:slug` claim page)                    | Cosmetic; keeps redeem and claim on distinct routes.                                                                                                                                                                                                                                                                                                                 |

**Net:** identical skeleton (web landing → immediate server-side redeem → encrypted 1h pending record
→ post-auth claim into a real connection), with a more robust correlation mechanism (an unguessable
single-use URL token instead of email-matching) and an explicit claim step that also provisions the
workbook.

### Reference

- Scratch design + phases: [`inbound-oauth-plan.md`](./inbound-oauth-plan.md)
- Scratch code: `server/src/oauth-install/` (controller + service + module),
  `server/src/oauth/providers/gohighlevel-oauth.provider.ts`,
  `client/src/app/oauth/install/[service]/page.tsx`, `client/src/app/connect/[service]/page.tsx`
- Whalesync code: paths listed above under `/Users/ijd/repos/whalesync`
