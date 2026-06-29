# DEV-10535 — Trial subscriptions: review, auto-trial on signup, admin grant-trial dev tool

- **Status:** Resolved
- **Created:** 2026-06-25
- **Author:** Chris Hoefgen
- **Linear:** [DEV-10535 — Verify trial system still works](https://linear.app/whalesync/issue/DEV-10535/verify-trial-system-still-works) (parent: DEV-10520)

## Context

DEV-10535 ("Verify the trial system still works") asks whether Scratch's old trial-subscription
code is still usable with the current Stripe integration, and to build on it. This plan covers three
things:

1. **Code review** of the existing trial code paths — is the old trial code still applicable?
2. **Auto-trial on signup** — automatically start a 14-day **Pro** trial for a new user when they
   sign up, gated behind a feature flag.
3. **Admin dev tool** — let an admin grant a free trial to a user who has *never* had a subscription.

The product currently has full, **active** Stripe billing (checkout, customer portal, webhooks,
`Subscription` persistence, Free/Pro/Max plans) but **no live trial path** — the trial code exists and
is unit-tested yet is never called outside tests. We will revive that code (it is sound), make its
duration flag-driven (defaulting to 14 days), and wire it into two new entry points.

### Confirmed decisions (from the user)

- Both new entry points use the **real Stripe trial** (`StripePaymentService.createTrialSubscription`):
  no card collected, Stripe auto-cancels at day 14 if no payment method is added. This also satisfies
  DEV-10535's "verify Stripe still works" goal.
- The admin dev tool **is allowed in production** (admins can grant a real trial to any prod user who
  never had a subscription) — unlike the existing *fake* subscription dev endpoints, which are
  non-prod only.
- New server-only **system-scoped** PostHog flag named **`AUTO_TRIAL_SUBSCRIPTION_ON_SIGNUP`** (key
  `AUTO_TRIAL_SUBSCRIPTION_ON_SIGNUP`), default **OFF** (fail-closed), not exposed to the client.
  Evaluated per-organization via `getBooleanFlagForOrg`.
- **Trial duration is a constant** — `TRIAL_PERIOD_DAYS = 14` in `stripe-payment.service.ts`. (An
  earlier revision made the duration a `TRIAL_SUBSCRIPTION_DURATION_DAYS` PostHog flag; that was
  removed on review — a flag for the trial length added needless surface area for no real benefit.)
- Auto-trial applies to **native (Clerk) signups only**, never Whalesync shadow users.

---

## Part 1 — Code review of the existing trial paths

**Verdict: the trial code is intact, current, and reusable. It is dead only because nothing calls it.**

Key file: `server/src/payment/stripe-payment.service.ts`

- `createTrialSubscription(user, planType)` (lines 106–158) creates a real Stripe subscription with
  `trial_period_days: TRIAL_PERIOD_DAYS` and `trial_settings.end_behavior.missing_payment_method:
  'cancel'`, then persists it via `upsertSubscription(...)` and fires `postHogService.trackTrialStarted`.
  It uses the current pinned API version (`STRIPE_API_VERSION = '2025-08-27.basil'`) and current
  Stripe params. **It works; it is just never invoked outside `stripe-payment.service.spec.ts`.**
- `generateCheckoutUrl(..., createTrialSubscription = false, ...)` (lines 241–342) also has a trial
  branch, but the production controller always passes `false` (`payment.controller.ts`), so the
  checkout-with-trial path is likewise exercised only in tests.
- The downstream machinery already handles trials end-to-end:
  - Webhooks `customer.subscription.created/updated/deleted` → `upsertSubscription`, which treats
    `status === 'trialing'` as active (line 755) and records `stripeStatus`, `expiration`, `cancelAt`.
  - `server/src/users/entities/user.entity.ts` surfaces `isTrial: latestSubscription.stripeStatus ===
    'trialing'` and `daysRemaining` to the client (`SubscriptionInfo`, `packages/shared-types/src/subscription.ts`).
  - `resolveUserForStripeCustomer` reconciles webhooks back to the user (direct `stripeCustomerId`,
    falling back to email).

**Gaps the implementation must close:**

- **Trial length is hardcoded to 7 days** — `TRIAL_PERIOD_DAYS = 7` (line 41). Must become 14.
- **No "already had a subscription" guard** in `createTrialSubscription` — it will blindly create a
  second subscription. We add this guard (the product rule in `plans.ts` is that once a user has *any*
  subscription, active or expired, they never return to Free).
- **No audit log on trial start** — only a PostHog event today. Server `CLAUDE.md` requires audit
  logging for subscription changes; we add an audit-log entry (especially important for the admin tool).

No other changes are needed to the existing billing/webhook code — it already understands trials.

---

## Shared change — `createTrialSubscription`: 14-day constant, guarded, and audited

File: `server/src/payment/stripe-payment.service.ts`

1. **Trial duration is a constant.** Set `const TRIAL_PERIOD_DAYS = 14;` and pass it directly as
   `trial_period_days` (this also fixes the dead checkout-trial branch for consistency). No flag, no
   `ExperimentsService` dependency in the payment module.
2. Add a guard at the **top** of `createTrialSubscription`, before any Stripe call
   (`getDefaultPriceId` / `upsertStripeCustomerId`):
   - Reject if the user's organization already has **any** subscription row. Reuse the loaded
     `user.organization?.subscriptions ?? []` (the `UserCluster._validator.include` already loads
     them). Return `badRequestError('User already has a subscription; cannot start a trial')`. This
     centralizes the "never had a subscription" rule for **both** new callers.
3. After a successful `upsertSubscription`, in addition to `trackTrialStarted`, write an audit-log
   entry via `auditLogService.logEvent({ actor: userToActor(user), eventType: 'create', message:
   'Started {n}-day {plan} trial', entityId: <subscriptionId> })`. `AuditLogService` is already injected
   into `StripePaymentService`.

This keeps all trial logic in the one operation that owns it (per the "composable, independent
systems" product principle); both new entry points just call it.

---

## Part 2 — Auto-start a 14-day Pro trial on signup (flag-gated)

### Feature flag

File: `server/src/experiments/flags.ts`

- Add one entry to `SystemFeatureFlag` (system-scoped, evaluated per-organization):
  - `AUTO_TRIAL_SUBSCRIPTION_ON_SIGNUP = 'AUTO_TRIAL_SUBSCRIPTION_ON_SIGNUP'` — boolean gate for the
    signup behavior (default false).
- System flags are not part of `ClientUserFlags`, so it is never sent to the client.
- Document, in the enum's doc comment, that the PostHog release condition must be a simple
  boolean/percentage rollout keyed on the **organization id** — **not** person-property targeting —
  because the org has no PostHog person at signup. Default false = fail-closed.

### Insertion point

File: `server/src/users/users.service.ts`, in `getOrCreateUserFromClerk` (the native Clerk signup
branch only), right after `this.postHogService.identifyNewUser(newUser)` (≈ line 125) and before/around
the Slack notification. Add a new private best-effort method, e.g.
`maybeStartProTrialForNewUser(newUser)`:

```
0. if (!newUser.organizationId) return;   // org-scoped flag needs an org id (always set at signup)
1. const enabled = await this.experimentsService.getBooleanFlagForOrg(
     SystemFeatureFlag.AUTO_TRIAL_SUBSCRIPTION_ON_SIGNUP, false, newUser.organizationId);
   if (!enabled) return;
2. const result = await this.stripePaymentService.createTrialSubscription(newUser, ScratchPlanType.PRO_PLAN);
3. if (isErr(result)) { WSLogger.error(...); }   // never throw — mirror workbook-provisioning's swallow pattern
```

- **Wrap in try/catch and swallow errors** so a Stripe/PostHog hiccup can never block signup — exactly
  how `createUserWithOrgAndDefaultWorkbook` already treats workbook provisioning (lines 190–199).
- Place the hook in `getOrCreateUserFromClerk`, **not** in the shared
  `createUserWithOrgAndDefaultWorkbook`, so the Whalesync shadow-user path
  (`getOrCreateShadowUserFromWhalesync`, which also calls the shared method) is naturally excluded.
- The `createTrialSubscription` guard makes this idempotent: a re-run for an existing user is a no-op
  (they'll already have the subscription).

### DI / module wiring — no cycle risk

`UserModule` (`server/src/users/users.module.ts`) **already imports** both `PaymentModule` (exports
`StripePaymentService`) and `ExperimentsModule` (exports `ExperimentsService`). So we only add the two
constructor injections to `UsersService`; no new module imports, no `forwardRef`. (`StripePaymentService`
deliberately re-implements user lookups locally to avoid the reverse dependency, so the
Users→Payment direction is the supported one.)

---

## Part 3 — Admin dev tool: grant a trial to a user who never had a subscription

Mirror the existing `changeUserOrganization` dev tool exactly (it operates on a target `userId`).

### Server

- **Controller** — `server/src/dev-tools/dev-tools.controller.ts`: add
  `POST /dev-tools/users/:id/start-trial`.
  - Guard with `hasAdminToolsPermission(req.user)` (throw `UnauthorizedException` otherwise) — per
    `dev-tools/CLAUDE.md`, every endpoint must be admin-gated.
  - **No `isProductionEnvironment()` block** (intentionally different from the fake-subscription
    endpoints) — this tool creates a *real* Stripe trial and is allowed in prod.
  - Body: `StartUserTrialDto` with optional `planType` (default `PRO_PLAN`).
- **Service** — `server/src/dev-tools/dev-tools.service.ts`: add `startTrialForUser(userId, planType)`.
  `DevToolsService` already injects `usersService` and `stripePaymentService`.
  1. `const user = await this.usersService.findOne(userId)` → `NotFoundException` if missing (loads
     org + subscriptions via `UserCluster._validator.include`).
  2. Call `stripePaymentService.createTrialSubscription(user, planType)` — the centralized guard
     enforces "never had a subscription" and returns an error Result if they have one. Duration is the
     flag-driven value resolved inside `createTrialSubscription`.
  3. On `isErr(result)`, throw `BadRequestException(result.cause?.message ?? 'Failed to start trial')`
     so the admin sees the reason (e.g. "User already has a subscription").
- **DTO**: add `start-user-trial.dto.ts` shared schema +
  `server/src/dev-tools/dto/dev-tools.dto.ts` bridge class (`createZodDto`).

### Shared types (`@spinner/shared-types`)

- Add `packages/shared-types/src/dto/dev-tools/start-user-trial.dto.ts`:
  `startUserTrialSchema = z.object({ userId: z.string().min(1), planType: z.nativeEnum(ScratchPlanType).optional() })`
  + inferred `StartUserTrialDto` (+ `ValidatedStartUserTrialDto` like
  `change-user-organization.dto.ts`). Re-export from the dev-tools barrel.
- Add a client API method to `packages/shared-types/src/api-client/resources/dev-tools.ts`:
  `startUserTrial: async (userId, planType?) => http.post(\`/dev-tools/users/${userId}/start-trial\`, { planType }, {...})`
  (mirror `changeUserOrganization`, lines 57–61).

### Client dev UI

- `client/src/app/settings/dev/users/components/UserDetails.tsx` — add a "Start free trial" action
  next to the existing "Change Organization" control. Use `useConfirmDialog` + `ScratchpadNotifications`
  and call `scratchApiClient.devTools.startUserTrial(details.user.id)`, then `onRefreshUser(...)` (copy
  the `handleChangeOrganization` pattern, lines 77–111). Gated by the existing dev-tools visibility
  (`DEV_TOOLBOX` / admin).
- Optional: also surface it in `client/src/app/settings/billing/components/BillingDevTools.tsx` for
  self-service testing, but the user-details page is the primary "operate on another user" surface.

---

## Critical files

| Area | File | Change |
| --- | --- | --- |
| Trial core | `server/src/payment/stripe-payment.service.ts` | `TRIAL_PERIOD_DAYS = 14` constant; add no-existing-subscription guard; add audit log on trial start |
| Flag | `server/src/experiments/flags.ts` | add server-only system-scoped `AUTO_TRIAL_SUBSCRIPTION_ON_SIGNUP` |
| Auto-trial | `server/src/users/users.service.ts` | inject `StripePaymentService` + `ExperimentsService`; add `maybeStartProTrialForNewUser`, call from `getOrCreateUserFromClerk` |
| Dev tool (server) | `server/src/dev-tools/dev-tools.controller.ts`, `dev-tools.service.ts`, `dto/dev-tools.dto.ts` | `POST /dev-tools/users/:id/start-trial` (admin-gated, prod-allowed) |
| Shared types | `packages/shared-types/src/dto/dev-tools/start-user-trial.dto.ts` (+ barrel), `.../api-client/resources/dev-tools.ts` | new DTO + client method |
| Dev UI | `client/src/app/settings/dev/users/components/UserDetails.tsx` | "Start free trial" button |

## Reused existing code (do not reinvent)

- `StripePaymentService.createTrialSubscription` / `upsertSubscription` / `upsertStripeCustomerId` —
  the whole real-Stripe trial mechanism already exists.
- `ExperimentsService.getBooleanFlagForOrg(...)` — server system-flag check pattern (for the signup gate).
- `hasAdminToolsPermission(req.user)` (`server/src/auth/permissions.ts`) — admin gate.
- `getActiveSubscriptions` / `getLastestExpiringSubscription` (`server/src/payment/helpers.ts`) — for
  the "any existing subscription" guard.
- `postHogService.trackTrialStarted` + `auditLogService.logEvent` — analytics + audit channels.
- `changeUserOrganization` end-to-end (controller → service → shared DTO → api-client → `UserDetails.tsx`)
  is the exact template for the new dev tool.

## Verification

1. **Build/lint/types** (repo root): `yarn build`, `yarn lint`, `yarn typecheck`. Run
   `yarn prettier:check` in touched packages before committing.
2. **Unit tests**: extend `server/src/payment/stripe-payment.service.spec.ts` to cover (a)
   `trial_period_days === 14`, (b) the new guard rejecting a user who already has a subscription, (c)
   the trial-started audit-log entry. Add a `DevToolsService.startTrialForUser` spec. Run the single
   suites, not the whole tree.
3. **Auto-trial flow (test env)**: enable `AUTO_TRIAL_SUBSCRIPTION_ON_SIGNUP` in the Scratch-Test
   PostHog project (release condition keyed on the org id, or 100%); sign up a brand-new Clerk user;
   confirm a `trialing` Pro
   subscription appears in the DB and in the Stripe test dashboard, that `/users/current` returns
   `subscription.isTrial = true` with `daysRemaining ≈ 14`, and that flipping the flag off makes a new
   signup get no subscription (Free). Confirm a Whalesync shadow user gets **no** trial.
4. **Dev tool**: as an ADMIN user, `POST /dev-tools/users/:id/start-trial` (or the UserDetails button)
   for a test user with no subscription → expect a real Stripe trialing Pro subscription; call it again
   → expect `400 User already has a subscription`.
5. **Idempotency**: re-trigger signup for the same user → no duplicate subscription (guard holds).
6. Read `client/src/app/components/UI_SYSTEM.md` before writing the UI control; use `useConfirmDialog`
   (never native `confirm`).
