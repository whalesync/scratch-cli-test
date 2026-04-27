# Desktop `electron-updater` Integration

**Date**: 2026-04-24
**Status**: Proposed
**Scope**: `scratch-desktop/` + `scratch-desktop/.gitlab-ci-release.yml` + release scripts

## Goal

Ship in-app auto-updates for Scratch Desktop so that users running an installed build pick up new releases from the existing GitLab CI → GitHub release pipeline without re-downloading the app manually (or waiting for the Homebrew cask to refresh).

Two release channels must keep working independently:

- **stable** — `v<semver>-desktop` tags on [whalesync/scratch-cli](https://github.com/whalesync/scratch-cli), `VITE_SCRATCH_API_URL=https://api.scratch.md`
- **test** — `v<semver>-desktop-test` tags, prerelease, `VITE_SCRATCH_API_URL=https://test-api.scratch.md`

A stable-channel install must never receive a test build, and vice-versa.

## Current State (what already works)

- `electron-builder.yml` already declares `publish.provider: github` with `owner: whalesync`, `repo: scratch-cli`.
- `package.sh` runs `electron-builder … --publish never`, so builds generate `latest-mac.yml` / `latest-linux.yml` / `latest.yml` **and** `.blockmap` files in [scratch-desktop/dist/](scratch-desktop/dist/) (verified — `dist/latest-mac.yml` exists with `sha512` entries for both `.dmg` and `.zip`). The blockmap enables delta downloads on macOS and Windows.
- The mac target already emits the required `.zip` alongside the `.dmg` (electron-updater reads the `.zip` — DMGs are install-only).
- Tag scheme, draft-first release flow, and idempotent upload (`upload_assets.sh`) are all in place and suitable for auto-update metadata.

## Gaps (what's missing)

1. **`electron-updater` is not installed** — no dependency, no check logic in [scratch-desktop/src/main/index.ts](scratch-desktop/src/main/index.ts).
2. **CI drops the update metadata.** [scratch-desktop/scripts/package.sh:71-76](scratch-desktop/scripts/package.sh#L71-L76) only copies `*.{dmg,zip,AppImage,deb,exe}` into `dist-release/`. The `latest*.yml` and `*.blockmap` files stay in `dist/` and never reach the GitHub release. Same filter in [scratch-desktop/scripts/upload_assets.sh:95](scratch-desktop/scripts/upload_assets.sh#L95).
3. **Tag scheme is unsafe for electron-updater's default GitHub provider.** The provider calls `GET /releases/latest`, which returns whatever GitHub considers "latest" across *all* releases on the repo — the scratch-cli repo also hosts CLI releases under different tag suffixes. A desktop install would happily "update" itself to a CLI release that has no `latest-mac.yml` attached and blow up.
4. **No channel wiring.** Test builds (prerelease) and stable builds share one repo; without a channel split the stable updater would eventually pull a test build (or vice versa depending on `allowPrerelease`).
5. **macOS code signing is ad-hoc only.** `scripts/fix_macos_app_signatures.sh` strips and re-signs with `codesign --sign -` (ad-hoc). electron-updater on macOS **refuses** to apply an update whose signing identity doesn't match the installed app's Developer ID Application identity (Squirrel.Mac enforces this). Auto-update on macOS is blocked until a real Developer ID cert is provisioned.
6. **Windows installer is unsigned.** electron-updater will still apply the update, but the user sees a SmartScreen warning each time. Acceptable interim, should be tracked.
7. **No UI surface** for "update available / restart to install".

## Design Decisions

### D1. Dedicated release channel via `channel` field, same repo

Stay on `whalesync/scratch-cli` but have electron-builder write channel-specific metadata filenames so the updater never confuses CLI releases with desktop releases, and never crosses the stable/test boundary.

- Stable builds: `channel: desktop` → emits `desktop-mac.yml`, `desktop-linux.yml`, `desktop.yml` (Windows).
- Test builds: `channel: desktop-test` → emits `desktop-test-mac.yml`, etc.
- The installed app reads its own channel from the baked-in config and pulls **only** the matching file. It resolves the "latest tag" by walking the releases list and picking the newest tag whose channel metadata file exists — which is what `GenericProvider` and `GithubProvider` both support when `channel` is set.

Alternative considered: **separate `whalesync/scratch-desktop-releases` repo.** Cleaner mental model, but requires a new repo + token + Homebrew cask re-pointing. Defer unless channel-based split proves leaky.

Alternative considered: **`generic` provider pointing at `https://releases.scratch.md/…`.** Best long-term if we want to drop the GitHub coupling, but requires infra (bucket, CDN, cache invalidation). Out of scope for this plan.

### D2. Stable = `desktop` channel, Test = `desktop-test` channel, no `allowPrerelease`

The test builds are already flagged `prerelease: true` by `bootstrap_release.sh`. We **don't** rely on that flag for the updater — we rely on the `channel` field — because `allowPrerelease` is a per-install user preference and we want the split to be deterministic.

### D3. App build bakes its channel in at packaging time

`package.sh` already sets `SEMVER` and `VITE_*` from CI. Add `UPDATE_CHANNEL` (`desktop` or `desktop-test`) and pass it to electron-builder so the resulting `app-update.yml` (the per-build manifest electron-updater reads at runtime) points at the right channel.

### D4. Update check cadence

- On app launch (5s after `ready-to-show` to avoid contending with cold-start IPC).
- Every 4 hours while the app is running.
- Manual "Check for updates" menu item in the app menu.

Download is automatic once an update is found; install requires user confirmation (notification → "Restart & install"). Don't force-install silently — workspace state lives in unsaved IPC sessions and data loss is worse than a stale version.

### D5. macOS signing is a blocker for mac auto-update

Document it as such. Ship auto-update on Linux AppImage + Windows first; gate mac auto-update behind a follow-up that provisions a Developer ID Application certificate + notarization. The check/download/install IPC is platform-agnostic, so the code paths are the same — we just skip wiring `autoUpdater` on darwin until the cert lands.

## Implementation Plan

### Phase 1 — CI: publish the update metadata

**Files**: [scratch-desktop/scripts/package.sh](scratch-desktop/scripts/package.sh), [scratch-desktop/scripts/upload_assets.sh](scratch-desktop/scripts/upload_assets.sh), [scratch-desktop/electron-builder.yml](scratch-desktop/electron-builder.yml)

1. In `electron-builder.yml`, move the `publish:` block into a channel-aware form:
   ```yaml
   publish:
     provider: github
     owner: whalesync
     repo: scratch-cli
     channel: ${env.UPDATE_CHANNEL}
   ```
   The `${env.UPDATE_CHANNEL}` substitution is documented in electron-builder config.
2. In `package.sh`, require `UPDATE_CHANNEL` and extend the copy loop to also pull `dist/*.yml` (the channel manifest) and `dist/*.blockmap` into `dist-release/`.
3. In `upload_assets.sh`, extend the glob to include `*.yml` and `*.blockmap`. The existing delete-then-POST logic handles re-uploads safely.
4. In `.gitlab-ci-release.yml`, add `UPDATE_CHANNEL: desktop` to all prod `Package …` / `Upload …` jobs and `UPDATE_CHANNEL: desktop-test` to the test variants. Pipe `UPDATE_CHANNEL` through the package-job env (it's read by electron-builder, not the script).
5. In `finalize_release.sh`, exclude `*.yml` and `*.blockmap` from the checksums.txt loop (they're electron-updater's integrity layer, not user downloads).

**Validation**: after a test-channel release, verify the release page lists `desktop-test-mac.yml`, `desktop-test-linux.yml`, `desktop-test.yml`, and `.blockmap` siblings for every dmg/zip/AppImage/exe.

### Phase 2 — App: wire `electron-updater`

**Files**: [scratch-desktop/src/main/index.ts](scratch-desktop/src/main/index.ts), new [scratch-desktop/src/main/updater.ts](scratch-desktop/src/main/updater.ts), [scratch-desktop/src/preload/index.ts](scratch-desktop/src/preload/index.ts), [scratch-desktop/src/preload/index.d.ts](scratch-desktop/src/preload/index.d.ts), [scratch-desktop/package.json](scratch-desktop/package.json)

1. `yarn add electron-updater electron-log` (main-process only — must be in `dependencies`, not `devDependencies`, or electron-builder won't bundle it into `app.asar`).
2. New `src/main/updater.ts`:
   - Exports `initAutoUpdater(mainWindow)` called once from `app.whenReady()` in `index.ts`.
   - Guards: skip on `!app.isPackaged` (use `dev-app-update.yml` for local testing instead — see Phase 4).
   - Guards: skip on `process.platform === 'darwin'` until Phase 5 lands; log a clear `[updater] mac auto-update disabled pending Developer ID signing`.
   - Sets `autoUpdater.logger = electronLog` and bumps `electronLog.transports.file.level = 'info'`.
   - Sets `autoUpdater.autoDownload = true`, `autoUpdater.autoInstallOnAppQuit = false` (so quit-without-restart doesn't surprise users mid-work).
   - Subscribes to `checking-for-update`, `update-available`, `update-not-available`, `download-progress`, `update-downloaded`, `error`. Each forwards a compact payload to the renderer via `mainWindow.webContents.send('updater:event', …)`.
   - Initial `autoUpdater.checkForUpdates()` after a 5s delay, then `setInterval(check, 4 * 60 * 60 * 1000)`.
3. IPC surface via preload:
   - `updater:checkNow()` → triggers an ad-hoc check (for the menu item).
   - `updater:quitAndInstall()` → calls `autoUpdater.quitAndInstall(false, true)` after the renderer confirms.
   - `updater:subscribe(callback)` → renderer receives updater events.
4. Expose these on `window.scratchDesktop` next to the existing `showNativeContextMenu` surface (not on `scratchAuth` — different concern).

### Phase 3 — Renderer: minimal update UI

**Files**: new `src/renderer/src/providers/UpdaterProvider.tsx`, wire into `App.tsx`

1. `UpdaterProvider` subscribes to `updater:event` at mount, keeps a small state machine (`idle | checking | downloading | ready | error`).
2. On `update-downloaded`, show a Mantine `notifications.show` toast with a "Restart & install" action that calls `updater:quitAndInstall()`. Persistent (`autoClose: false`) — the user can keep working.
3. On `error`, silent log unless triggered by a manual check (then show a dismissable toast).
4. Add a "Check for updates…" item to the native app menu (main process, not renderer Menu) that calls `updater:checkNow()` and surfaces the result via the same toast system.

Keep it boring: no progress bar in v1 (delta downloads over the blockmap are usually sub-10MB). Can add later if users complain.

### Phase 4 — Local testing

1. Add a `dev-app-update.yml` to `scratch-desktop/` (already gitignored via `electron-builder.yml` files filter). Content:
   ```yaml
   provider: github
   owner: whalesync
   repo: scratch-cli
   channel: desktop-test
   ```
2. Document in `scratch-desktop/CLAUDE.md`: to test the update flow against a staged test-channel release without signing/notarizing, run a dev build with a *lower* version than the latest `-desktop-test` tag and set `process.env.ELECTRON_IS_DEV = '0'` in a one-off wrapper (or temporarily flip the `app.isPackaged` guard in `updater.ts`).
3. Vitest: unit-test the channel guard + event forwarding with a stubbed `autoUpdater`. Do not test against real GitHub in CI.

### Phase 5 — macOS signing (follow-up, separate MR)

Blocked on: Developer ID Application cert acquired + stored as CI secret (`CSC_LINK`, `CSC_KEY_PASSWORD`), plus notarization creds (`APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`).

Once provisioned:

1. Replace `scripts/fix_macos_app_signatures.sh` with electron-builder's built-in `mac.identity` / `afterSign` notarize hook.
2. Remove the `darwin` guard in `updater.ts`.
3. Verify: a stable-channel build installed from DMG, with an older version, picks up a newer release and installs after restart. Specifically confirm Squirrel.Mac's staging area at `~/Library/Caches/md.scratch.desktop.ShipIt/` shows the download.

## Risks & Open Questions

- **Tag collision between CLI and desktop releases.** The `channel` split defends against this for the updater, but a CLI release landing on top of a desktop release will still show up in the desktop release's changelog parser if we wire one. Don't parse changelogs from the repo for now — release notes go in the GitHub release body itself.
- **Rollback story.** If a bad stable release ships, how do we pull it? Options: (a) delete the GitHub release → updater 404s and reverts to "no update available"; (b) publish a higher-versioned "rollback" release that reverts the change. Prefer (b) — (a) leaves users on the bad version indefinitely. Worth documenting in the follow-up ops doc.
- **electron-updater + yarn resolutions.** The repo pins `axios@1.14.0`; electron-updater bundles its own HTTP client, but double-check the resolution doesn't force-downgrade a transitive dep. Run `yarn why electron-updater` after install.
- **Homebrew cask coexistence.** Users who installed via `brew install --cask scratch-desktop` will get both in-app updates AND cask updates. The cask install path is `/Applications/Scratch Desktop.app`, same as the DMG install path — should be safe, but worth a manual test on a brew-installed build to confirm the updater doesn't trip on brew's symlink or cask's version pinning.
- **First-launch update storm on CI test boxes.** If QA installs a build and the updater immediately fetches a newer test build, their "fresh install" test is against the wrong version. Mitigation: gate auto-update behind `SCRATCH_DESKTOP_DISABLE_AUTO_UPDATE=1` env var.

## Out of Scope

- Staged rollouts / percentage-based rollouts (electron-builder supports this via `stagingPercentage` — nice-to-have, not now).
- Delta update tuning (electron-builder's default blockmap behavior is fine).
- Migration from Homebrew cask → in-app updater as the primary channel (user-facing decision).
- Windows code signing (separate procurement + plan).

## Deliverables Checklist

- [ ] `electron-builder.yml` uses `${env.UPDATE_CHANNEL}` in `publish.channel`
- [ ] `package.sh` / `upload_assets.sh` ship `*.yml` + `*.blockmap`
- [ ] `.gitlab-ci-release.yml` passes `UPDATE_CHANNEL` to every package/upload job
- [ ] `finalize_release.sh` excludes metadata files from checksums.txt
- [ ] `electron-updater` + `electron-log` added to `dependencies`
- [ ] `src/main/updater.ts` with platform/packaged/dev guards
- [ ] Preload IPC surface for check/install/subscribe
- [ ] `UpdaterProvider` + toast UI + menu item
- [ ] `dev-app-update.yml` + docs
- [ ] Test test-channel release end-to-end on Linux AppImage and Windows
- [ ] (Follow-up MR) mac Developer ID signing + darwin guard removed
