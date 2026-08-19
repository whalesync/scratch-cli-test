# Runbook: Burn a Bad Desktop Release

Guide for "burning" (withdrawing) a corrupted or otherwise broken production release of the **Scratch Desktop** app so that:

1. The **auto-updater** (`electron-updater`) running in already-installed copies of the app stops offering it as an upgrade.
2. The bad version no longer appears on the **downloads page** of the web client at [https://app.scratch.md/downloads](https://app.scratch.md/downloads).
3. Users who have not yet updated stay on the previous good version, and users who have already updated have a path back.

This runbook only covers the **production** (`desktop`) channel on [`whalesync/scratch-desktop`](https://github.com/whalesync/scratch-desktop). The same mechanics apply to the `desktop-test` channel, but it lives in its **own** repo — [`whalesync/scratch-desktop-test`](https://github.com/whalesync/scratch-desktop-test) (DEV-11320) — so point the `gh --repo …` commands there; the urgency and blast radius are also different. Adapt as needed.

## Context

| Item                  | Value                                                                                                                                                                      |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Release artifacts     | GitHub Releases on [`whalesync/scratch-desktop`](https://github.com/whalesync/scratch-desktop/releases)                                                                    |
| Production tag format | `vX.Y.Z` (test channel uses `vX.Y.Z-test`) — see [desktop-release.service.ts:48-59](../../server/src/desktop-release/desktop-release.service.ts#L48)                       |
| Auto-updater          | `electron-updater` with GitHub provider, channel baked at package time via `UPDATE_CHANNEL` — see [updater.ts](../../scratch-desktop/src/main/updater.ts)                  |
| Downloads page        | [client/src/app/downloads/page.tsx](../../client/src/app/downloads/page.tsx) → `GET /desktop-release/latest` on the API                                                    |
| Server filter         | Excludes `draft: true` and (on prod) `prerelease: true` releases — [desktop-release.service.ts:192-194](../../server/src/desktop-release/desktop-release.service.ts#L192)  |
| Server cache          | Redis key `desktop-release:latest:v4:desktop:production`, TTL 5 min — [desktop-release.service.ts:18,137](../../server/src/desktop-release/desktop-release.service.ts#L18) |
| Homebrew cask         | Updated by `scratch-desktop/scripts/update_homebrew_cask.sh` on every prod release                                                                                         |

### How the auto-updater discovers releases (background)

`electron-updater` polls the GitHub Releases API for `whalesync/scratch-desktop` every 4 hours (and once on app start, after a 5 s delay — see [updater.ts:6](../../scratch-desktop/src/main/updater.ts#L6)). It filters by the channel that was baked into the build (`desktop` or `desktop-test`), reads the channel-specific manifest YAML attached to the release (e.g. `latest-mac.yml`), and offers an update to the user if the version is newer than the running one.

A release is **invisible to the production auto-updater** when any of the following is true:

- The GitHub release is marked **draft**.
- The GitHub release is marked **prerelease** (production channel only — the server also filters these out).
- The release is **deleted** entirely.
- The channel manifest YAML files are removed from the release assets.

The simplest, most reversible move is to flip the release to **prerelease**. Deleting is heavier-handed and irreversible without re-uploading.

## Prerequisites

- Maintainer access to the [`whalesync/scratch-desktop`](https://github.com/whalesync/scratch-desktop) GitHub repo (to edit/delete releases).
- Access to the GitHub Web UI with management permissions
- Access to the production server's Redis to invalidate the downloads-page cache:
  - GCP project `spv1eu-production`
  - Redis credentials / `redis-cli` access — TODO: link to existing Redis access doc once one exists
- Maintainer access to the Homebrew tap repo if rolling back the cask
  - [`whalesync/homebrew-scratch-desktop`](https://github.com/whalesync/homebrew-scratch-desktop)

## Decision: which "burn" level?

Pick the lightest option that solves the problem.

| Severity                                                                                                                                    | Recommended action                         | Reversible?                  |
| ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ | ---------------------------- |
| Bad release, but artifacts are fine to keep around for forensics                                                                            | Mark release as **prerelease**             | Yes — uncheck the box        |
| Release should be hidden from everyone, including non-prod debug tooling OR release contains secrets, malware, signed-with-wrong-cert, etc. | **Delete** the release **and the git tag** | No — would need to re-upload |

**Default to "prerelease"** unless there is a reason to go further. Once any debugging is complete, delete the release once a new version has taken over being the "latest" release

## Procedure

### 1. Confirm which release is bad

- Identify the exact tag (e.g. `vX.Y.Z`) and assert it matches the bad build.
- Note the previous good tag (the one that should "win" once the bad one is hidden).

### 2. Withdraw the release on GitHub

#### Option A — Mark as prerelease (preferred)

Via GitHub web UI: **Releases → edit the bad release → check "Set as a pre-release" → Update release**.

Via `gh` CLI:

```bash
gh release edit vX.Y.Z \
  --repo whalesync/scratch-desktop \
  --prerelease
```

#### Option B — Delete the release and tag

```bash
gh release delete vX.Y.Z \
  --repo whalesync/scratch-desktop \
  --cleanup-tag \
  --yes
```

> ⚠️ Deleting also removes all uploaded artifacts (DMG, AppImage, EXE, manifest YAMLs, checksums). Only do this if you intend never to ship these binaries again.

### 3. Invalidate the server's Redis cache (optional)

_Only necessary if there is a critical security issue._ The downloads endpoint caches the latest-release lookup for 5 minutes. Without invalidation, the downloads page can keep showing the bad release for up to 5 minutes after withdrawal.

Use the `connect_to_gcp_redis.sh` script to securely access redis and then utilize the CLI or a tool like Redis Insight to delete the `desktop-release:latest:v4:desktop:production` key

The next request to `GET /desktop-release/latest` will repopulate the cache from GitHub, now skipping the withdrawn release.

NOTE: The cache key prefix and channel name are defined in [desktop-release.service.ts](../../server/src/desktop-release/desktop-release.service.ts) — if those change, update the key here.

### 4. Roll back the Homebrew cask (if production)

Every successful production release runs `scratch-desktop/scripts/update_homebrew_cask.sh`, which advances the cask in the tap to the new version. If the bad release has already shipped, the cask is currently pointing at the bad version.

TODO: document the exact procedure for the tap. At a minimum:

1. Open a PR against the tap repo reverting the cask to the previous good version (and its checksum).
2. Merge once CI passes.
3. Verify with `brew update && brew info --cask scratch` (or the actual cask name).

### 5. Confirm the release is gone

- [https://app.scratch.md/downloads](https://app.scratch.md/downloads) shows the previous good version (hard-refresh to bypass any browser caching).
- A newly installed copy of the app, pointed at the production channel, does **not** see an update beyond the previous good version. (Or, equivalently, the GitHub Releases page no longer lists the bad release as the latest non-prerelease.)

## What this runbook does NOT do

- **Recall already-installed copies of the bad version.** Users who already auto-updated are still on the bad build. To get them off it you must either:
  - Ship a new patch release (`vX.Y.Z+1`) that supersedes the bad one (auto-updater will pick it up at the next 4-hour check, or on user-triggered "Check for Updates").
  - Tell users to manually downgrade — TODO: document the manual downgrade procedure (download the old DMG/AppImage/EXE, force-install, deal with `electron-updater` re-offering the old release in some configurations).
- **Stop a release that is mid-publish.** If the GitLab release pipeline is still running, prefer cancelling the pipeline first — the finalize stage flips `draft: false`. See [scratch-desktop/.gitlab-ci-release.yml](../../scratch-desktop/.gitlab-ci-release.yml).

## Communication

Depending on the emergency level do the following:

- [ ] Post in `#on-call` with what was withdrawn, why, and ETA on a fixed release.
- [ ] If the bad release shipped publicly, add a note to the next release's GitHub notes explaining the burn.
- [ ] Open or update an [incident report](incidents/) using `/create-incident-report` if the failure mode warranted one.

## Related documentation

- [Scratch Desktop — Auto-Update](../../scratch-desktop/CLAUDE.md) — channel mechanics and `SCRATCH_DESKTOP_DISABLE_AUTO_UPDATE`
- [Release pipeline](../../scratch-desktop/.gitlab-ci-release.yml) — how releases are produced
- [Server downloads endpoint](../../server/src/desktop-release/desktop-release.service.ts)
- [Apple Developer ID certificate runbook](runbook-apple-developer-id-certificate.md) — relevant if the burn was triggered by a signing/notarization issue
