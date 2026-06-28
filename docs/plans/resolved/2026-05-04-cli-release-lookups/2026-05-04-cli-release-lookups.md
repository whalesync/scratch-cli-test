# Scratch CLI Release Lookups

**Date**: 2026-05-04
**Status**: Resolved (2026-05-04)
**Scope**: [server/src/desktop-release/](server/src/desktop-release/) + [packages/shared-types/src/dto/desktop-release/](packages/shared-types/src/dto/desktop-release/) + [client/src/lib/api/desktop-release.ts](client/src/lib/api/desktop-release.ts)

> **Resolved 2026-05-04**
>
> Implemented as planned. Notable deviation: the `useCliRelease` hook + `SWR_KEYS.cliRelease.latest` entry were no longer deferred — [client/src/app/downloads/page.tsx](client/src/app/downloads/page.tsx) became the consumer in the same change, with a `<CliSection>` rendered below the existing desktop section.
>
> Files touched:
>
> - [server/src/desktop-release/desktop-release.service.ts](server/src/desktop-release/desktop-release.service.ts) — kind-aware refactor, cache key bumped to `:v3:`.
> - [server/src/desktop-release/desktop-release.controller.ts](server/src/desktop-release/desktop-release.controller.ts) — new `GET /desktop-release/cli/latest`.
> - [server/src/desktop-release/\_\_tests\_\_/desktop-release.service.spec.ts](server/src/desktop-release/__tests__/desktop-release.service.spec.ts) — new spec, 9 cases.
> - [client/src/lib/api/desktop-release.ts](client/src/lib/api/desktop-release.ts), [client/src/lib/api/keys.ts](client/src/lib/api/keys.ts), [client/src/hooks/use-cli-release.ts](client/src/hooks/use-cli-release.ts), [client/src/app/downloads/page.tsx](client/src/app/downloads/page.tsx).

## Goal

Expose Scratch CLI (`scratchmd`) release metadata through the same server module that already serves Scratch Desktop release metadata, so the web client can render a CLI download/install page (and hint at the latest CLI version inside the desktop app) without any caller talking to GitHub directly.

## Context

[desktop-release.service.ts](server/src/desktop-release/desktop-release.service.ts) currently fetches releases from `whalesync/scratch-cli` and filters by tag suffix to find the latest **desktop** build. The same GitHub repo also hosts CLI releases — they were built by the same release pipeline (`scratch-git-2/scripts/release_public.sh`, `release_test.sh`) and are co-located by design — so there is no new GitHub coupling to introduce, only a different tag filter.

### Tag conventions in `whalesync/scratch-cli`

Confirmed from `scratch-desktop/scripts/bootstrap_release.sh` and `scratch-git-2/scripts/release_{public,test}.sh`:

| Build              | Tag pattern           | Example               |
| ------------------ | --------------------- | --------------------- |
| Desktop production | `vX.Y.Z-desktop`      | `v0.4.1-desktop`      |
| Desktop test       | `vX.Y.Z-desktop-test` | `v0.4.1-desktop-test` |
| CLI production     | `vX.Y.Z` (no suffix)  | `v0.3.7`              |
| CLI test           | `vX.Y.Z-test`         | `v0.3.7-test`         |

The CLI **production** tag has no suffix, which means the existing `endsWith(suffix)` filter is unsafe for it — `-test`, `-desktop`, and `-desktop-test` tags all also "end with empty string". The CLI lookup needs a regex-based predicate, not suffix matching.

### CLI asset shape

`release_public.sh` uploads per-platform archives:

- `scratchmd_darwin_arm64.tar.gz`
- `scratchmd_darwin_amd64.tar.gz`
- `scratchmd_linux_amd64.tar.gz`
- `scratchmd_linux_arm64.tar.gz`
- `scratchmd_windows_amd64.zip`

Same `{ name, browser_download_url, size }` shape as desktop assets, so `DesktopReleaseAsset` is reusable as-is — the DTO doesn't need a new type.

## Design Decisions

### D1. One service, multiple release "kinds"

Refactor `DesktopReleaseService` to lookup releases by a `kind` discriminator (`'desktop' | 'cli'`) rather than only desktop. The fetch/cache/redis machinery is identical between kinds; only the tag predicate and cache key differ. A separate `CliReleaseService` would duplicate ~80% of the code.

Rename considered: `ReleaseService` (drop "Desktop"). **Rejected** for this iteration — the module path, controller path, and existing client SDK key all use `desktop-release`, and renaming touches deployments, the auto-update plan ([2026-04-24-desktop-electron-updater-integration.md](../2026-04-24-desktop-electron-updater-integration/2026-04-24-desktop-electron-updater-integration.md)), and external consumers. Keep the `DesktopReleaseService` name; it's now a misnomer but the cost of churn outweighs the naming clarity.

### D2. Match predicate is a function, not a string suffix

Replace the current `tagSuffix: string` with `matchTag: (tag: string) => boolean` so CLI's "no suffix" prod case is expressible without special-casing. Concretely:

- Desktop prod: `tag.endsWith('-desktop')`
- Desktop test: `tag.endsWith('-desktop-test')`
- CLI prod: `/^v\d+\.\d+\.\d+$/.test(tag)` — strict, rejects any suffix
- CLI test: `tag.endsWith('-test') && !tag.endsWith('-desktop-test')` — exclude desktop-test

The CLI test predicate must explicitly exclude `-desktop-test` because suffix matching `-test` would otherwise pick up desktop test builds.

### D3. Channel selection mirrors existing behavior

The existing service picks `production` vs `test` from `ScratchConfigService.isProductionEnvironment()`. CLI lookups use the same rule — a server running in production env returns the CLI prod tag, test env returns the CLI test tag. This keeps a single mental model ("the server tells you about its own channel's releases") and avoids exposing test builds from prod to end users.

A future `?channel=test` query param could be added if internal tooling needs cross-channel visibility, but that's out of scope.

### D4. Cache key includes kind, version

Bump cache key prefix from `desktop-release:latest:v2:` to `desktop-release:latest:v3:` and include the kind segment: `desktop-release:latest:v3:{kind}:{channel}`. The `v3` bump invalidates v2 entries on deploy (5-minute TTL means the spike is small). Existing TTL (5 min) and timeouts (5s) carry over unchanged.

### D5. Endpoints

Add one new endpoint, leave the existing one untouched:

- `GET /desktop-release/latest` → unchanged, returns the latest desktop release (back-compat for existing client + download page).
- `GET /desktop-release/cli/latest` → returns the latest CLI release for the server's channel.

Path nests `cli/` under the existing controller rather than introducing a new `/cli-release` controller, because the controller is a thin shim and a new controller would duplicate the unauthenticated-by-design comment + module wiring for no semantic gain. If we later rename the module to `release` we'll move both endpoints together.

The existing endpoint stays unauthenticated for the same reason as today (download page is reachable pre-auth). The CLI endpoint follows the same rule — `scratchmd` install instructions need to be reachable from any docs page.

### D6. No new DTO types

Reuse `DesktopReleaseAsset` and `DesktopReleaseResponse`. The `channel` field semantics stay the same (`'production' | 'test'`). No `kind` field on the response — callers know which endpoint they hit; round-tripping the kind back adds no information.

If a future caller wants to render a "downloads index" page that mixes both kinds in one list, we can introduce a `kind` field then. Speculative now.

## Implementation Plan

### Phase 1 — Refactor the service to a kind-aware shape

**File**: [server/src/desktop-release/desktop-release.service.ts](server/src/desktop-release/desktop-release.service.ts)

1. Introduce a `ReleaseKind = 'desktop' | 'cli'` type and a small lookup table:

   ```ts
   type ReleaseKind = 'desktop' | 'cli';

   interface ReleaseLookup {
     kind: ReleaseKind;
     channel: Channel;
     matchTag: (tag: string) => boolean;
     notFoundMessage: string;
   }

   function lookupFor(kind: ReleaseKind, channel: Channel): ReleaseLookup {
     if (kind === 'desktop') {
       const suffix = channel === 'production' ? '-desktop' : '-desktop-test';
       return { kind, channel, matchTag: (t) => t.endsWith(suffix), notFoundMessage: ... };
     }
     // kind === 'cli'
     const matchTag = channel === 'production'
       ? (t: string) => /^v\d+\.\d+\.\d+$/.test(t)
       : (t: string) => t.endsWith('-test') && !t.endsWith('-desktop-test');
     return { kind, channel, matchTag, notFoundMessage: ... };
   }
   ```

2. Replace `fetchLatestRelease(tagSuffix: string)` with `fetchLatestRelease(matchTag: (tag: string) => boolean)`. The page-walking, timeout, and 30/page logic stays the same. Tighten `MAX_RELEASE_PAGES` if needed once we see how dense CLI tags are; default 5 (= 150 releases) is still plenty.

3. Replace `getLatestDesktopRelease()` with a private `getLatest(kind: ReleaseKind)` that does the cache-read → fetch → cache-write flow, plus two thin public methods:

   ```ts
   getLatestDesktopRelease(): Promise<DesktopReleaseResponse> { return this.getLatest('desktop'); }
   getLatestCliRelease(): Promise<DesktopReleaseResponse>     { return this.getLatest('cli'); }
   ```

4. Update `cacheKey` to take `(kind, channel)` and emit `desktop-release:latest:v3:{kind}:{channel}`. Bump `CACHE_KEY_PREFIX` to `:v3:`.

5. Keep `extractVersion` as-is — it already strips by regex, so it works for both `v0.3.7-desktop` and `v0.3.7`.

### Phase 2 — Controller endpoint

**File**: [server/src/desktop-release/desktop-release.controller.ts](server/src/desktop-release/desktop-release.controller.ts)

Add:

```ts
@Get('cli/latest')
async getLatestCliRelease(): Promise<DesktopReleaseResponse> {
  return this.desktopReleaseService.getLatestCliRelease();
}
```

Update the file-level comment to mention "Scratch Desktop and Scratch CLI releases."

### Phase 3 — Client SDK

**File**: [client/src/lib/api/desktop-release.ts](client/src/lib/api/desktop-release.ts)

Add a sibling fetcher:

```ts
getLatestCli: async (): Promise<DesktopReleaseResponse> => {
  try {
    const axios = API_CONFIG.getAxiosInstance();
    const res = await axios.get<DesktopReleaseResponse>('/desktop-release/cli/latest');
    return res.data;
  } catch (error) {
    handleAxiosError(error, 'Failed to fetch latest CLI release');
  }
},
```

If a caller needs SWR caching, add a `SWR_KEYS.cliRelease.latest` entry in [client/src/lib/api/keys.ts](client/src/lib/api/keys.ts) and a `useCliRelease` hook in `client/src/hooks/` following the pattern in `use-data-folders.ts`. Defer creating the hook until there's a consumer page — speculative now.

### Phase 4 — Tests

**File**: `server/src/desktop-release/__tests__/desktop-release.service.spec.ts` (new)

Cases worth covering — all can be done by mocking `fetch` and `IORedis`:

1. `getLatestCliRelease()` in production env returns the latest tag matching `^v\d+\.\d+\.\d+$`, **skipping** intervening `-desktop`, `-desktop-test`, and `-test` tags on the same page.
2. `getLatestCliRelease()` in test env picks up `-test` but **never** picks up `-desktop-test` (the regression-prone case).
3. `getLatestDesktopRelease()` still works (no behavior change for the existing endpoint).
4. Cache hit → no fetch call.
5. Cache miss + fetch failure → `NotFoundException`.

The existing service has no tests today, so this is net-new. Stick to focused unit tests — no integration test needed since there's no DB or queue interaction.

### Phase 5 — Verification

Run from repo root after each phase:

```bash
yarn build
yarn lint
yarn test --filter=server
```

Manual smoke (with the server running and a real GH token if rate limits bite):

```bash
curl -s http://localhost:3010/desktop-release/latest | jq .tagName
curl -s http://localhost:3010/desktop-release/cli/latest | jq .tagName
```

Expect tagNames matching the patterns in the table above for the running server's channel.

## Out of Scope

- Renaming the module to `release` (D1).
- Adding `?channel=` query support (D3).
- A dedicated `/cli-release` controller (D5).
- Auto-update wiring for the CLI itself — `scratchmd` is installed via Homebrew/Scoop today and self-update is a separate problem (touches the CLI binary, not this service).
- A `useCliRelease` SWR hook — wait for an actual consumer (D7 / Phase 3 note).

## Open Questions

1. Do we want to expose the prerelease/draft state on the response? The existing service silently skips drafts; CLI prod releases are non-prerelease, CLI test releases are prerelease. Callers that want to badge "test" can already read `channel`, so leaning **no**.

- NO - only full releases should be included

2. Should the CLI test channel be reachable from a prod-env server (e.g. for QA tooling)? Currently no — D3 keeps channel selection env-bound. If yes, we'd add `?channel=` and gate it behind an admin role. Defer until asked.

- NO
