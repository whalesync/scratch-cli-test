# Whalesync → Scratch direct API access: Scratch server backend

**Status**: Resolved — Scratch server backend implemented; all workstreams + tests complete; integration suite passed against a live server (2026-06-05)
**Author**: Chris Hoefgen
**Created**: 2026-06-04
**Linear**: [DEV-10325 — WS→Scratch Auth system](https://linear.app/whalesync/issue/DEV-10325/ws-scratch-auth-system)
**Design doc**: [whalesync-scratch-api-access.md](../../../whalesync-scratch-api-access.md)

## Implementation status

All six Scratch-server workstreams and the test layer are **implemented and green** (full server `yarn lint` clean; `yarn test` — 189 suites / 3385 tests pass; integration suite compiles and skips cleanly without a live server).

| Workstream | Status | Key files |
| --- | --- | --- |
| 1. Schema + token type | ✅ Done (migration applied by author) | `prisma/schema.prisma`, `packages/shared-types/src/enums/enums.ts` |
| 2. Provisioning + minting | ✅ Done | `users/users.service.ts`, `users/tokens.ts`, `posthog/posthog.service.ts` |
| 3. Admin channel | ✅ Done | `auth/scratch-admin.guard.ts`, `internal/*`, `config/scratch-config.service.ts` |
| 4. Rate-limiter bypass | ✅ Done | `rate-limiter/api-rate-limit.guard.ts` |
| 5. Cron cleanup | ✅ Done (scoped to `WHALESYNC_SESSION` for now) | `cron/expired-api-token-cleanup.service.ts` |
| 6. CORS | ✅ Done | `config/scratch-config.service.ts` |
| Unit tests (37 cases) | ✅ Pass | guard, users service, posthog, rate-limiter, cron specs |
| Integration suite (9 cases) | ✅ Passed against a live server (2026-06-05) | `test/integration/whalesync-shadow-user.spec.ts` |

**Resolved:** the integration suite passed against a live server (`RUN_WHALESYNC_INTEGRATION=true SCRATCH_ADMIN_API_KEY=<same> yarn test:integration`) on 2026-06-05. The Bottlenose/Dusky work (separate repo) and the follow-ups in "Out of scope" below remain, tracked separately. DTOs were placed in `shared-types` (`dto/internal/whalesync-internal.dto.ts`) to match the existing controller convention. Two DTO-doc sections below describe the server class implementing the shared interface.

## Scope

This plan covers **only the Scratch server (`spinner/server`)** changes from the design doc. The Bottlenose (`whalesync/api/bottlenose`) and Dusky (`whalesync/dusky`) changes live in the Whalesync repo and are out of scope here.

Everything below is **additive** — no existing auth path changes behavior. The existing `API_TOKEN_STRATEGY` + `ScratchAuthGuard` already resolve `Authorization: API-Token <token>` to a `req.user`; a shadow user is just a `User` row that happens to be reached that way. The work is: let Bottlenose provision shadow users and mint short-lived session tokens over a privileged admin channel, exempt those tokens from rate limiting, and garbage-collect them.

### Workstreams

1. **Schema + token type** — `whalesyncUserId` on `User`; a `WHALESYNC_SESSION` token type.
2. **Provisioning + minting service** — shadow-user create-if-missing and short-lived session-token mint/revoke in `UsersService`.
3. **Admin channel** — `ScratchAdminGuard`, `SCRATCH_ADMIN_API_KEY` in `ScratchConfigService`, and the `internal/whalesync` controller/module.
4. **Rate limiter bypass** — `WHALESYNC_SESSION` tokens skip `ApiRateLimitGuard`.
5. **Cron cleanup** — periodic deletion of expired `ApiToken` rows.
6. **CORS** — allow the Whalesync app origins to call Scratch directly from the browser.

These are presented in dependency order. Workstreams 1–2 are the foundation; 3 depends on them; 4–6 are independent of each other and can land in parallel once the token type exists. Reasonable PR cut: **PR1 = 1+2+5** (schema, service, cron — self-contained), **PR2 = 3+4+6** (the user-facing admin surface). Either way, nothing is wired into a live route until the controller in workstream 3 ships.

---

## 1. Schema + token type

### `whalesyncUserId` on `User`

Add to the `User` model in [schema.prisma](../../server/prisma/schema.prisma#L65-L93):

```prisma
model User {
  // ... existing fields ...
  clerkId         String? @unique   // real Clerk ID (user_…) for native users; synthetic "ws_<whalesyncUserId>" for shadow users
  whalesyncUserId String? @unique   // UUID of the linked Whalesync user; null for native Scratch users
}
```

- `@unique` makes provisioning idempotent (find-or-create keyed on this field) and keeps shadow users distinct from native signups.
- `clerkId` stays `@unique` and is still **required-in-practice** by the creation routine, so shadow users get a synthetic `ws_<whalesyncUserId>` value (see §2). The `ws_` prefix is a discriminator: any code that calls Clerk for a user can skip `ws_`-prefixed users since they don't exist in Scratch's Clerk app. (No such call site is touched in this plan, but the prefix is the agreed convention.)

**Migration.** Create one migration directory under [server/prisma/migrations/](../../server/prisma/migrations/) following the existing `<YYYYMMDDHHMMSS>_<name>/migration.sql` convention, e.g. `add_user_whalesync_user_id`. The SQL is a nullable column add plus a unique index:

```sql
ALTER TABLE "User" ADD COLUMN "whalesyncUserId" TEXT;
CREATE UNIQUE INDEX "User_whalesyncUserId_key" ON "User"("whalesyncUserId");
```

> ⚠️ **Do not run `prisma migrate dev`** against the local database (per project convention). Hand-author the migration SQL (or use `migrate dev --create-only` and inspect), then apply with `yarn migrate` from the repo root. Confirm the generated SQL matches the hand-authored expectation before applying.

### `WHALESYNC_SESSION` token type

`ApiToken.type` is already a plain `String @default("USER")` column ([schema.prisma:95-108](../../server/prisma/schema.prisma#L95-L108)) — it is **not** a Prisma enum, so **no DB migration is needed** to introduce a new value. The only change is the shared TypeScript enum used across the codebase:

[`packages/shared-types/src/enums/enums.ts:28-32`](../../packages/shared-types/src/enums/enums.ts#L28-L32)

```typescript
export enum TokenType {
  WEBSOCKET = 'WEBSOCKET',
  USER = 'USER',
  MCP = 'MCP',
  WHALESYNC_SESSION = 'WHALESYNC_SESSION', // short-lived browser session tokens brokered via Bottlenose
}
```

Rebuild `shared-types` so the server/client pick it up (`yarn build` from root handles ordering).

---

## 2. Provisioning + minting (`UsersService`)

All in [`server/src/users/users.service.ts`](../../server/src/users/users.service.ts) and [`server/src/users/tokens.ts`](../../server/src/users/tokens.ts).

### Factor out the shared user-creation core

`getOrCreateUserFromClerk` ([users.service.ts:55-181](../../server/src/users/users.service.ts#L55-L181)) does the canonical first-login provisioning: create `User` (with `role: USER`, a `WEBSOCKET` token, an auto-created `Organization`) + a default `'My Scratch workspace'` Workbook, then PostHog `identifyNewUser`, a Slack notification, and pending-invite redemption.

The design says provisioning **reuses the same path**. Rather than branch the Clerk method on a `whalesyncUserId`, **extract the create side into a private helper** that both entry points call:

```typescript
private async createUserWithOrgAndDefaultWorkbook(args: {
  clerkId: string;            // real "user_…" or synthetic "ws_<uuid>"
  whalesyncUserId?: string;   // set only for shadow users
  name?: string;
  email?: string;
}): Promise<UserCluster.User> { /* the existing lines 117-177 creation body, parameterized */ }
```

`getOrCreateUserFromClerk` keeps its existing find-by-`clerkId` branch and calls the helper for the create branch (behavior unchanged). Then add the shadow-user entry point:

```typescript
public async getOrCreateShadowUserFromWhalesync(
  whalesyncUserId: string,
  email: string,
  name?: string,
): Promise<UserCluster.User> {
  const existing = await this.db.client.user.findUnique({
    where: { whalesyncUserId },
    include: UserCluster._validator.include,
  });
  if (existing) {
    // keep email/name fresh, mirroring the existing-user branch of getOrCreateUserFromClerk
    return existing;
  }
  return this.createUserWithOrgAndDefaultWorkbook({
    clerkId: `ws_${whalesyncUserId}`,
    whalesyncUserId,
    name,
    email,
  });
}
```

**Email uniqueness — `ws:`-prefixed shadow emails (v1 decision).** `User.email` is `@unique`. A native Scratch user and a Whalesync user with the same email must stay separate, and the `@unique` constraint means a raw shadow email that already belongs to a native user would make provisioning **throw**. For v1 we **sidestep the collision entirely** by storing the shadow user's email **prefixed with `ws:`** (e.g. `ws:user@example.com`), so a shadow row never competes with a native row for the same email value. This is enough to stand up the feature and run initial tests.

- Apply the prefix inside `getOrCreateShadowUserFromWhalesync` / the creation helper — store `ws:${email}`. The raw email arrives in the request body; only the stored value is namespaced.
- **DB email-normalization trigger.** `User.email` has a Postgres trigger that lowercases and trims on INSERT/UPDATE (validated by [`user-email-normalize.spec.ts`](../../server/test/integration/user-email-normalize.spec.ts)). It fires on the prefixed value, so `ws:Foo@Example.com` persists as `ws:foo@example.com` — harmless, but the prefix string must be lowercase (`ws:`) so it round-trips cleanly, and tests should assert the normalized-and-prefixed value.
- Nothing in this design keys on `email`, so the prefix has no behavioral cost in v1.
- **Longer term ([DEV-10331](https://linear.app/whalesync/issue/DEV-10331), out of scope here):** reconcile the incoming Whalesync email against the existing Scratch user base and **only create a shadow user when no existing Scratch user owns that email** — otherwise link/adopt the existing user. That reconciliation replaces the `ws:` prefix; until it lands, the prefix keeps native and shadow identities cleanly disjoint.

**Other decision to confirm during implementation** (flag in the PR, don't silently choose):
- **Slack / invite side effects** — the extracted helper currently fires a Slack "new user" ping and redeems pending invites. Decide whether shadow users should trigger these. Leaning: gate the Slack ping behind "not a `ws_` user" to avoid noise, and skip invite redemption (shadow users aren't invited teammates). Whatever is chosen, do it inside the helper via a flag so the Clerk path is untouched. (PostHog identify is kept for all users — see below.)

### PostHog: mark shadow users so they can be excluded from growth metrics

We want to **identify** shadow users in PostHog with the linked Whalesync user ID and a flag marking them as Whalesync shadow users, so Scratch-growth dashboards and funnels can filter them out. The flag must be a **person property** (set via `$set` on `identify`), not just an event property — person-level filtering is what lets a dashboard/funnel exclude *all* of a shadow user's events at once.

Make the change in [`identifyNewUser`](../../server/src/posthog/posthog.service.ts#L84-L120) and derive everything from the `User` row (which now carries `whalesyncUserId`), so the call site in the creation helper stays unchanged and native vs. shadow is decided in one place:

```typescript
public identifyNewUser(user: User): void {
  if (!this.postHog) return;
  const signedUpAt = user.createdAt.toISOString().slice(0, 10);
  const isWhalesyncShadowUser = !!user.whalesyncUserId;

  const personProperties = {
    email: user.email,
    name: user.name,
    // Person properties so dashboards/funnels can exclude shadow users product-wide.
    is_whalesync_shadow_user: isWhalesyncShadowUser,
    whalesync_user_id: user.whalesyncUserId ?? null,
    $set_once: { signed_up_at: signedUpAt },
  };

  this.postHog.identify({ distinctId: user.id, properties: personProperties });

  this.captureEvent(PostHogEventName.ACCOUNT_USER_CREATED, user, {
    name: user.name,
    email: user.email,
    role: user.role,
    is_whalesync_shadow_user: isWhalesyncShadowUser,
    whalesync_user_id: user.whalesyncUserId ?? null,
    $set_once: { signed_up_at: signedUpAt },
  });
}
```

- **`is_whalesync_shadow_user` is set for every new user — `true` for shadow, `false` for native.** Setting it explicitly `false` on native signups (rather than leaving it unset) makes the exclusion filter unambiguous: `is_whalesync_shadow_user is not true` works either way, but an explicit boolean reads cleanly in the PostHog UI and avoids "unset vs false" confusion in funnels. Use plain top-level props (PostHog `identify` treats `properties` as `$set`); don't use `$set_once` for this flag, so it stays correct if a user is ever reconciled from shadow → native later (per [DEV-10331](https://linear.app/whalesync/issue/DEV-10331)).
- **`whalesync_user_id`** lets you cross-reference a Scratch person back to the Whalesync user for debugging and cohort building.
- **Existing shadow users** (created before this lands) won't have the person property until they're next identified. If a backfill matters for clean historical dashboards, set the property on the existing shadow rows via a one-off — note it as a follow-up rather than blocking v1; the `ws_` `clerkId` / `whalesyncUserId` columns make those rows easy to find.
- The PostHog values (`whalesync_user_id`, the `email`) are the **raw** Whalesync identifiers — note the stored Scratch `User.email` is `ws:`-prefixed (§ above), so if you want the un-prefixed email in PostHog, pass the raw email through rather than the stored value.

### Session-token mint (10-minute TTL, non-destructive)

`generateUserApiToken` ([users.service.ts:206-224](../../server/src/users/users.service.ts#L206-L224)) is the wrong tool — it **deletes all existing `USER` tokens** and mints a 6-month one. Session tokens must be additive (each session is a fresh row; cleanup is the cron's job) and short-lived.

Add a TTL helper in [tokens.ts](../../server/src/users/tokens.ts) next to `generateTokenExpirationDate`:

```typescript
export function generateWhalesyncSessionTokenExpirationDate(): Date {
  return new Date(Date.now() + 1000 * 60 * 10); // 10 minutes
}
```

Add to `UsersService`:

```typescript
public async mintWhalesyncSessionToken(
  userId: string,
): Promise<{ token: string; expiresAt: Date }> {
  const created = await this.db.client.apiToken.create({
    data: {
      id: createApiTokenId(),
      userId,
      token: generateApiToken(),
      expiresAt: generateWhalesyncSessionTokenExpirationDate(),
      type: TokenType.WHALESYNC_SESSION,
    },
  });
  return { token: created.token, expiresAt: created.expiresAt };
}

public async revokeWhalesyncSessionTokens(userId: string): Promise<number> {
  const { count } = await this.db.client.apiToken.deleteMany({
    where: { userId, type: TokenType.WHALESYNC_SESSION },
  });
  return count;
}
```

`mint` does **not** delete prior session tokens (overlapping refresh windows are expected). `revoke` is the bulk-revocation primitive used by the deprovision and explicit logout endpoints — it only touches `WHALESYNC_SESSION` rows, so a user's CLI/desktop (`USER`/`WEBSOCKET`) tokens are never affected.

### Deprovision

Add a method that tears a shadow user down through the proper cleanup path (per the CLAUDE.md deletion rule — repos/jobs/tables must be cleaned up via `WorkbookService.delete`):

```typescript
public async deprovisionShadowUser(whalesyncUserId: string): Promise<void> {
  // find shadow user by whalesyncUserId; for each owned Workbook call workbookService.delete;
  // then delete the auto-created Organization and the User (ApiToken rows cascade on user delete).
}
```

> 🔎 **Verify before writing**: there is an existing user/workbook teardown path (the `WorkbookService.delete` referenced in CLAUDE.md, and whatever `WorkbookService.delete` already does for repos/jobs/tables). Reuse it rather than reimplementing deletion. If a `UsersService`/`OrganizationService` delete already exists, route through it. Confirm `ApiToken` cascades on `User` delete — schema shows `onDelete: Cascade` on the `ApiToken.user` relation ([schema.prisma:96](../../server/prisma/schema.prisma#L96)), so tokens are handled automatically; org and workbooks are not and must be explicit.

---

## 3. Admin channel (guard, config, controller)

### `SCRATCH_ADMIN_API_KEY` in `ScratchConfigService`

[`server/src/config/scratch-config.service.ts`](../../server/src/config/scratch-config.service.ts) — follow the existing `getEnvVariable` / `getOptionalEnvVariable` accessor pattern (lines 256-279). Support rotation (current + previous) by reading two vars and returning the non-empty set:

```typescript
/** Admin secrets accepted by ScratchAdminGuard. Supports rotation: current + (optional) previous. */
getScratchAdminApiKeys(): string[] {
  return [
    this.getOptionalEnvVariable<string>('SCRATCH_ADMIN_API_KEY'),
    this.getOptionalEnvVariable<string>('SCRATCH_ADMIN_API_KEY_PREVIOUS'),
  ].filter((key): key is string => !!key);
}
```

Optional (not `getEnvVariable`) so the server still boots in environments that don't run the internal channel; the guard denies **all** requests when the set is empty (fail closed). Add `SCRATCH_ADMIN_API_KEY` to `server/.env.example` with a comment. In cloud, source it from GCP Secret Manager (matches the Clerk secret-key pattern already used by `getClerkSecretKey`).

### `ScratchAdminGuard`

New file `server/src/auth/scratch-admin.guard.ts`. A plain `CanActivate` (not a Passport strategy — there is no user to resolve; it's a shared-secret gate). It reads `X-Scratch-Admin-Token`, constant-time compares against each configured key, throws `401` on miss.

```typescript
@Injectable()
export class ScratchAdminGuard implements CanActivate {
  constructor(private readonly configService: ScratchConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const presented = request.header('X-Scratch-Admin-Token');
    const acceptedKeys = this.configService.getScratchAdminApiKeys();
    if (!presented || acceptedKeys.length === 0) {
      throw new UnauthorizedException('Invalid admin token');
    }
    const presentedBuffer = Buffer.from(presented);
    const matches = acceptedKeys.some(
      (key) =>
        key.length === presented.length &&
        crypto.timingSafeEqual(presentedBuffer, Buffer.from(key)),
    );
    if (!matches) {
      throw new UnauthorizedException('Invalid admin token');
    }
    return true;
  }
}
```

- **Constant-time**: `crypto.timingSafeEqual` requires equal-length buffers, hence the `length ===` pre-check (the length check itself is not secret-dependent — token length isn't sensitive).
- This guard sets **no `req.user`**. The internal endpoints operate on the user named in the request body, not an authenticated session.
- Register `ScratchAdminGuard` as a provider in the new module (below); it depends only on `ScratchConfigService`.

> **Hardening (design §Admin-token hardening)**: in addition to the secret, the `/internal/*` prefix should be network/IP-restricted at the ingress/load-balancer layer so a leaked secret alone is insufficient. That is infra (Terraform/Cloud Run), tracked separately — note it in the PR but it's not a code change here.

### `internal/whalesync` controller + module

New `server/src/internal/` module following the standard NestJS module layout. The controller is guarded by `ScratchAdminGuard` **only** — deliberately **not** `ScratchAuthGuard` (no user session) and **not** `ApiRateLimitGuard` (server-to-server, and the rate limiter no-ops on non-`api-token` requests anyway).

`server/src/internal/whalesync.controller.ts`:

```typescript
@Controller('internal/whalesync')
@UseGuards(ScratchAdminGuard)
@UseInterceptors(ClassSerializerInterceptor)
export class WhalesyncInternalController {
  constructor(private readonly usersService: UsersService) {}

  // Ensure-shadow-user-then-mint; idempotent on whalesyncUserId. One round-trip.
  @Post('sessions')
  async createSession(@Body() body: CreateWhalesyncSessionDto):
    Promise<{ scratchUserId: string; apiToken: string; expiresAt: string }> {
    const user = await this.usersService.getOrCreateShadowUserFromWhalesync(
      body.whalesyncUserId, body.email, body.name,
    );
    const { token, expiresAt } = await this.usersService.mintWhalesyncSessionToken(user.id);
    return { scratchUserId: user.id, apiToken: token, expiresAt: expiresAt.toISOString() };
  }

  // Ensure (create-if-missing) a shadow user. For eager provisioning / lifecycle hooks.
  @Post('users')
  async ensureUser(@Body() body: EnsureWhalesyncUserDto): Promise<{ scratchUserId: string }> {
    const user = await this.usersService.getOrCreateShadowUserFromWhalesync(
      body.whalesyncUserId, body.email, body.name,
    );
    return { scratchUserId: user.id };
  }

  // Bulk-revoke a user's session tokens (logout) without deprovisioning.
  @Delete('users/:whalesyncUserId/sessions')
  async revokeSessions(@Param('whalesyncUserId') whalesyncUserId: string):
    Promise<{ revoked: number }> { /* find user, revokeWhalesyncSessionTokens */ }

  // Deprovision a shadow user — routes through WorkbookService.delete (CLAUDE.md cleanup rule).
  @Delete('users/:whalesyncUserId')
  @HttpCode(204)
  async deprovisionUser(@Param('whalesyncUserId') whalesyncUserId: string): Promise<void> {
    await this.usersService.deprovisionShadowUser(whalesyncUserId);
  }
}
```

**Unknown-`whalesyncUserId` behavior** (decide and document — the integration test asserts it): the `DELETE` and `DELETE …/sessions` endpoints should be **idempotent** — deprovisioning or revoking a user that doesn't exist returns success (`204` / `{ revoked: 0 }`) rather than `404`, so Bottlenose lifecycle hooks (e.g. a delete that's retried, or fired for a user that was never provisioned) don't have to special-case "already gone." Leaning idempotent; confirm.

DTOs in `server/src/internal/dto/` follow the project's "all-optional + class-validator, `Required<Pick<…>>` for validated shape" convention (CLAUDE.md NestJS DTO pattern):

```typescript
class CreateWhalesyncSessionDto {
  @IsString() @IsOptional() whalesyncUserId?: string;
  @IsString() @IsOptional() email?: string;
  @IsString() @IsOptional() name?: string;
}
type ValidatedCreateWhalesyncSessionDto = Required<Pick<CreateWhalesyncSessionDto, 'whalesyncUserId' | 'email'>>;
```

`server/src/internal/internal.module.ts` imports `UsersModule` (for `UsersService`) and `ScratchConfigModule` (for the guard), declares the controller, and provides `ScratchAdminGuard`.

**Registration**: add `InternalModule` to [`app.module.ts`](../../server/src/app.module.ts) imports. Gate it on `ScratchConfigService.isAPIService()` alongside the other API-only modules (app.module.ts:75-77) so it only mounts on instances that serve HTTP.

**Endpoint summary** (matches design §New Scratch internal endpoints):

| Method & path | Body / param | Returns | Behavior |
| --- | --- | --- | --- |
| `POST /internal/whalesync/sessions` | `{ whalesyncUserId, email, name? }` | `{ scratchUserId, apiToken, expiresAt }` | ensure shadow user → mint 10-min session token; idempotent on `whalesyncUserId` |
| `POST /internal/whalesync/users` | `{ whalesyncUserId, email, name? }` | `{ scratchUserId }` | ensure shadow user only (eager provisioning) |
| `DELETE /internal/whalesync/users/:whalesyncUserId/sessions` | path param | `{ revoked }` | bulk-revoke session tokens (logout) |
| `DELETE /internal/whalesync/users/:whalesyncUserId` | path param | `204` | deprovision via `WorkbookService.delete` |

**Audit logging**: per `server/CLAUDE.md`, creating/deleting core entities should write audit logs. Shadow-user create and deprovision are entity lifecycle events — emit audit-log + PostHog events for them (the deprovision especially deletes workbooks). The actor here is the admin channel, not an interactive user; record it as a system/admin actor. Confirm the `Actor` shape that `AuditLogService`/`PostHogService` expect for a non-interactive caller.

---

## 4. Rate limiter bypass

[`server/src/rate-limiter/api-rate-limit.guard.ts`](../../server/src/rate-limiter/api-rate-limit.guard.ts), in `canActivate`. The guard already early-returns for non-`api-token` requests (line 70) and for the kill-switch / unlimited scope (line 77). Add a `WHALESYNC_SESSION` bypass right alongside the scope check:

```typescript
const scopes = user.apiToken?.scopes ?? [];

// WHALESYNC_SESSION tokens drive browser job-status polling and are intentionally
// uncapped (short 10-min TTL is the abuse control). Bypass before consuming points.
if (user.apiToken?.type === TokenType.WHALESYNC_SESSION) {
  return true;
}

if (this.configService.isApiRateLimitDisabled() || scopes.includes('rate-limit:unlimited')) {
  return true;
}
```

`user.apiToken` is populated by `API_TOKEN_STRATEGY`, which returns the matched `apiToken` on the `AuthenticatedUser` ([api-token.strategy.ts:24-50](../../server/src/auth/api-token.strategy.ts#L24-L50); type at [auth/types.ts:11-16](../../server/src/auth/types.ts#L11-L16)). Import `TokenType` from `@whalesync/shared-types`. Revisit if polling abuse becomes a concern (design note).

---

## 5. Cron cleanup of expired tokens

10-minute session tokens minted on every page-load refresh would grow the `APIToken` table unbounded. Add a scheduled cleanup mirroring the existing cron pattern.

New `server/src/cron/expired-api-token-cleanup.service.ts`, modeled on [`old-job-cleanup.service.ts`](../../server/src/cron/old-job-cleanup.service.ts):

```typescript
@Injectable()
export class ExpiredApiTokenCleanupService {
  constructor(private readonly dbService: DbService) {}

  @Cron(CronExpression.EVERY_HOUR)
  async cleanupExpiredApiTokens(): Promise<void> {
    // Delete in bounded batches to avoid a long-held lock on a hot table.
    // where: { expiresAt: { lt: new Date() } }
    // Log total deleted via WSLogger when > 0.
  }
}
```

**Scope decision**: delete **all** expired `ApiToken` rows (`expiresAt < now()`), not just `WHALESYNC_SESSION`. Expired rows are already inert — `getUserFromAPIToken` filters `expiresAt > now()` ([users.service.ts:46-53](../../server/src/users/users.service.ts#L46-L53)) — so this also cleans up long-dead `WEBSOCKET` (1-day) and `USER` (6-month) rows with no behavioral change. If a more conservative first cut is preferred, scope the `where` to `type: TokenType.WHALESYNC_SESSION` and widen later. Recommend the broad cleanup; note the choice in the PR.

Batch the delete (e.g. select up to `BATCH_SIZE` ids, `deleteMany` by id, loop until empty) like the old-job cleanup, so a large backlog doesn't lock the table.

**Registration**: add to [`cron.module.ts`](../../server/src/cron/cron.module.ts) `providers` and `exports` (needs `DbModule`, already imported). `CronModule` is conditionally loaded only on cron-type instances ([app.module.ts:77](../../server/src/app.module.ts#L77)), so this runs once cluster-wide, not per API replica. Hourly is ample for a 10-minute TTL; `EVERY_30_MINUTES` is also fine.

---

## 6. CORS

Dusky calls Scratch **directly from the browser** (`app.whalesync.com` → Scratch's domain), a cross-origin request carrying `Authorization`. Today CORS reflects only the Scratch web-client origin.

- The `Authorization` header is **already allowed** on preflight ([main.ts:51-60](../../server/src/main.ts#L51-L60) `allowedHeaders`), so no header change is needed.
- The **origin allowlist** must gain the Whalesync app origins per environment. Extend [`getCorsAllowedOrigins`](../../server/src/config/scratch-config.service.ts#L324-L342) so the `allowedOrigins` set includes the Whalesync origin(s) for the current environment:

```typescript
const allowedOrigins = new Set<string>([ScratchConfigService.getClientBaseUrl()]);
// Whalesync app origins (Dusky) call Scratch directly, browser → Scratch.
for (const origin of ScratchConfigService.getWhalesyncAppOrigins()) {
  allowedOrigins.add(origin);
}
```

Add a small static/env-driven `getWhalesyncAppOrigins()` returning the right origin(s) for `development` / `staging` / `production` (e.g. `https://app.whalesync.com` in prod, the test/staging equivalents otherwise). Source from config/env rather than hardcoding so test/staging are covered. `credentials: true` is already set, which is required if the cookie-hardening variant is ever pursued; the v1 in-memory bearer doesn't need it but it's harmless.

---

## Testing

- **`ScratchAdminGuard`** (unit): valid current key passes; valid previous key passes (rotation); wrong key → 401; missing header → 401; empty configured key set → 401 (fail closed); timing-safe path exercised with equal/unequal lengths.
- **`UsersService`** (unit): `getOrCreateShadowUserFromWhalesync` creates on first call with `clerkId = ws_<uuid>` + `whalesyncUserId` set, and is idempotent on the second call (same user id, no duplicate org/workbook); `mintWhalesyncSessionToken` creates a `WHALESYNC_SESSION` row ~10 min out and does **not** delete sibling tokens; `revokeWhalesyncSessionTokens` deletes only `WHALESYNC_SESSION` rows; `deprovisionShadowUser` removes workbooks/org/user and cascades tokens. Cover the email-collision branch decided in §2.
- **`PostHogService.identifyNewUser`** (unit): a shadow user (`whalesyncUserId` set) identifies with `is_whalesync_shadow_user: true` and `whalesync_user_id` = the linked id, on both the `identify` `$set` and the `ACCOUNT_USER_CREATED` event; a native user identifies with `is_whalesync_shadow_user: false` and `whalesync_user_id: null`.
- **`ApiRateLimitGuard`** (unit): a `WHALESYNC_SESSION`-typed `req.user.apiToken` bypasses; a `USER` token still consumes points.
- **`ExpiredApiTokenCleanupService`** (unit): deletes rows with `expiresAt < now`, leaves live rows, batches.
- Run `yarn build`, `yarn lint`, and the relevant `prettier:check` from the repo root before pushing (CI runs `prettier:check`; no pre-commit hook).

### Integration tests for shadow-user + session-management endpoints

New spec at **`server/test/integration/whalesync-shadow-user.spec.ts`**, run by `yarn test:integration` (config `test/integration/jest-integration.json`: `testRegex: .spec.ts$`, `maxWorkers: 1`, real local Postgres). Follow the harness conventions of the existing suite:

- **DB access**: instantiate `new PrismaClient()` in `beforeAll`, `$disconnect()` in `afterAll`, exactly as [`user-email-normalize.spec.ts`](../../server/test/integration/user-email-normalize.spec.ts) and [`fetch-edit-publish.spec.ts`](../../server/test/integration/fetch-edit-publish.spec.ts#L166-L186) do.
- **Service wiring**: for service-level cases, construct `UsersService` with its real dependencies against the live DB (mirror the `makeDbService(prisma)` pattern in `fetch-edit-publish.spec.ts:126`). `PostHogService` and Slack should be stubbed/no-op so tests don't emit external events (the SDK already no-ops when unconfigured — assert via a spy instead of hitting PostHog).
- **HTTP access**: for endpoint-level cases, drive the **running server** over HTTP via `axios` against `getApiUrl()` from [`common.ts`](../../server/test/integration/common.ts) (the `INTEGRATION_TEST_API_DOMAIN`, default `localhost:3010`) — same approach as `health-check.spec.ts`. The admin endpoints need **no Clerk session**; they authenticate purely with the `X-Scratch-Admin-Token` header, so these tests are self-contained (unlike connector tests, they don't call `getAuthToken`). Only the "minted token authenticates a real request" leg uses `Authorization: API-Token <token>`.

**Env (`.env.integration`)** — add and document in [`.env.integration.example`](../../server/.env.integration.example):
- `SCRATCH_ADMIN_API_KEY` — the admin secret the test presents; required for every endpoint case.
- `SCRATCH_ADMIN_API_KEY_PREVIOUS` — set in the rotation test to assert the previous key is still accepted.
- HTTP-level cases require the server running on `INTEGRATION_TEST_API_DOMAIN` with the **same** `SCRATCH_ADMIN_API_KEY` in its environment (note this precondition at the top of the spec, like the connector specs note their API keys).

**Isolation & cleanup** (critical — shadow-user creation makes an Org + default Workbook + a git repo, not just a `User` row):
- Generate a **fresh random `whalesyncUserId`** (`crypto.randomUUID()`) per test so reruns never collide on the `@unique` columns in the shared local DB.
- Track created `scratchUserId`s and tear them down in `afterEach`/`afterAll` **through `deprovisionShadowUser`** (the same `WorkbookService.delete` path the `DELETE` endpoint uses), so workbook repos/rows are cleaned up — not just `prisma.user.deleteMany`, which would orphan git repos and leave the local checkout dirty. Fall back to direct row deletes only if deprovision itself is the unit under test.

**Required cases:**

1. **`POST /internal/whalesync/sessions` — provision + mint (first call).** Creates the shadow user: assert the DB row has `whalesyncUserId` = the sent id, `clerkId = ws_<whalesyncUserId>`, `role = USER`, an auto-created Organization, and a default Workbook. Assert the response is `{ scratchUserId, apiToken, expiresAt }` with `expiresAt` ≈ 10 minutes out (tolerance), and that the persisted `ApiToken` row has `type = WHALESYNC_SESSION`.
2. **`ws:` email prefix + normalization trigger.** Send a mixed-case email (e.g. `Foo@Example.com`); assert the stored `User.email` is `ws:foo@example.com` — i.e. the `ws:` prefix is applied **and** the existing DB lowercase/trim trigger (validated in `user-email-normalize.spec.ts`) still fires on the prefixed value. Assert a **native** user with the un-prefixed `foo@example.com` can coexist without tripping the `@unique` constraint (the whole point of the prefix).
3. **Idempotency of `sessions`.** Call twice with the same `whalesyncUserId`: same `scratchUserId` both times, **no** second User/Org/Workbook created, but the `ApiToken` count for that user **increments by one** (mint is additive, per §2).
4. **Minted token authenticates as the shadow user (end-to-end).** Take the `apiToken` from case 1 and call a real authenticated endpoint over HTTP with `Authorization: API-Token <token>` — e.g. `POST /workbook` then `GET /jobs` — and assert it succeeds and the created workbook is owned by `scratchUserId`. This proves `API_TOKEN_STRATEGY` resolves the shadow user with zero auth-path changes.
5. **`POST /internal/whalesync/users` — ensure-only.** Returns `{ scratchUserId }`, creates the user when missing, and mints **no** token (assert zero `WHALESYNC_SESSION` rows for that user). Idempotent on repeat.
6. **`DELETE /internal/whalesync/users/:id/sessions` — bulk revoke.** Mint N session tokens, call the endpoint, assert `{ revoked: N }` and that **all** `WHALESYNC_SESSION` rows for the user are gone. If the user also holds a `USER`/`WEBSOCKET` token, assert those are **untouched**. Then assert a previously-minted session token now returns **401** on a real `GET /jobs`.
7. **`DELETE /internal/whalesync/users/:id` — deprovision.** Returns `204`; assert the User, its Organization, and its Workbook(s) are gone (repos cleaned via `WorkbookService.delete`), and `ApiToken` rows cascade-deleted. Confirm the documented behavior for an **unknown `whalesyncUserId`** (idempotent `204` vs `404` — pick in §3 and assert it here).
8. **`ScratchAdminGuard` over HTTP.** Missing `X-Scratch-Admin-Token` → 401; wrong token → 401; valid **current** key → 2xx; valid **previous** key (with `SCRATCH_ADMIN_API_KEY_PREVIOUS` set) → 2xx. (The fail-closed-on-empty-config case is covered by the unit test, since a running server in this suite always has a key configured.)
9. **Rate-limit bypass over HTTP.** Mint a session token, then fire **more than `DEFAULT_SPEC.points` (60)** requests inside the 60s window at a rate-limited endpoint and assert **no `429`**. Contrast with a `USER` token (e.g. via `generateUserApiToken`) that **does** get throttled, to prove the bypass is specific to `WHALESYNC_SESSION`. ⚠️ This requires rate limiting to actually be **on** in the test environment — `isApiRateLimitDisabled()` defaults to **true** in `development` ([scratch-config.service.ts:141-143](../../server/src/config/scratch-config.service.ts#L141-L143)), so the test must run against a server with `API_RATE_LIMIT_DISABLED=false`, or skip with a clear log if the kill-switch is on (don't silently pass).

The `ExpiredApiTokenCleanupService` cron is covered by its unit test above; optionally add a service-level integration case that seeds expired + live `ApiToken` rows against the real DB and asserts `cleanupExpiredApiTokens()` removes only the expired ones.

---

## Out of scope / follow-ups

- **Bottlenose & Dusky** changes (`ScratchApiClient`, `GET /rest/scratch/session`, Redis token cache, `scratchAxios`, hooks) — separate repo, separate plan.
- **Infra**: provisioning `SCRATCH_ADMIN_API_KEY` in GCP Secret Manager and IP/network-restricting the `/internal/*` prefix at ingress (Terraform). Required for the hardening story but not a `spinner/server` code change.
- **`ws_`-prefix Clerk-skip enforcement**: this plan establishes the synthetic `clerkId` convention; no current call site is changed to skip Clerk for `ws_` users. Add guards there if/when a shadow user hits a Clerk-calling code path.
- **Email reconciliation** ([DEV-10331](https://linear.app/whalesync/issue/DEV-10331), child of DEV-10324): replace the v1 `ws:` email prefix by reconciling against the existing Scratch user base (adopt/link an existing user rather than creating a duplicate). Includes a possible backfill of `ws:`-prefixed shadow users already created in v1.

## Open questions (carried from the design doc)

- **Admin-token transport & rotation** — `X-Scratch-Admin-Token` header is assumed here; confirm, and confirm the two-key rotation window (`SCRATCH_ADMIN_API_KEY` + `_PREVIOUS`) is the desired mechanism.
- **Eager vs lazy provisioning** — both `POST /sessions` (lazy, mints) and `POST /users` (eager, ensure-only) are provided; confirm whether Whalesync signup should pre-provision via the latter.
- **Token storage in the browser** (in-memory bearer vs httpOnly cookie) — affects Dusky/Bottlenose, not this server work, except that the cookie variant would later require a `/session/establish` cookie endpoint + CSRF on Scratch. v1 server work assumes in-memory bearer (zero extra auth surface).

## Resolved decisions

- **Email collision handling** (§2) → **`ws:`-prefixed shadow emails** for v1, to sidestep the `User.email @unique` constraint and stand the feature up for initial testing. Longer term, reconcile against the existing Scratch user base and only create a shadow user when no existing Scratch user owns that email (adopt/link otherwise); that reconciliation replaces the prefix and is tracked as [DEV-10331](https://linear.app/whalesync/issue/DEV-10331) (child of DEV-10324).
