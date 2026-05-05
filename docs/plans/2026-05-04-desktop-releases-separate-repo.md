# Move Scratch Desktop Releases to a Dedicated GitHub Repo

**Date**: 2026-05-04
**Status**: Proposed
**Scope**: [scratch-desktop/](../../scratch-desktop/) release pipeline + updater + server/client consumers + Homebrew tap

## Goal

Stop publishing Scratch Desktop builds to [whalesync/scratch-cli](https://github.com/whalesync/scratch-cli) and move them to a new dedicated repo (proposed: `whalesync/scratch-desktop`). One repo per product line — desktop releases never share an atom feed, release list, or changelog with CLI releases again.

Two release channels must keep working independently after the move:

- **stable** — prod desktop builds, used by Homebrew cask + DMG/AppImage/.exe direct installers
- **test** — prerelease desktop builds, used by QA against `https://test-api.scratch.md`

**No bridge / migration story required.** The auto-updater has never successfully shipped an in-app update to a real install — no client in the wild is polling `whalesync/scratch-cli` for desktop updates today. The Homebrew cask is updated by CI on every prod release, so flipping its `url` to the new repo on the next release is enough; existing brew installs pick up the change on `brew upgrade`. The cutover is just "start publishing to the new repo."

## Background — why this is worth doing

- `whalesync/scratch-cli` currently holds three product lines on one tag list: CLI prod (`vX.Y.Z`), CLI test (`vX.Y.Z-test`), Desktop prod (`vX.Y.Z-desktop`), Desktop test (`vX.Y.Z-desktop-test`). The `releases.atom` feed and `GET /releases` are first-come-first-served across all of them.
- electron-updater's default [GitHubProvider](https://github.com/electron-userland/electron-builder/tree/master/packages/electron-updater) walks the atom feed and picks the newest tag. When a CLI release is "newest", desktop installs 404 looking for `desktop-mac.yml` on a CLI release that doesn't have it. A custom `DesktopGitHubProvider` subclass that filtered the atom feed by tag suffix was tried and rolled back — it depended on `electron-updater/out/*` private paths and was a maintenance liability. With desktop releases on their own repo, the default provider Just Works because every entry in the atom feed IS a desktop release.
- The `DesktopReleaseService` ([server/src/desktop-release/desktop-release.service.ts:43-65](../../server/src/desktop-release/desktop-release.service.ts#L43-L65)) currently has to distinguish desktop vs CLI tags via suffix matching. With one repo per product line, that filter disappears.
- Release notes / changelog body parsing is unsafe today — a desktop release body can sit next to a CLI release body in the same list, and any "show recent releases" UI has to distinguish them by tag shape.

This was already flagged as the "durable fix" in [docs/plans/2026-04-24-desktop-electron-updater-integration.md](2026-04-24-desktop-electron-updater-integration.md) (search for "Alternative considered: separate `whalesync/scratch-desktop-releases` repo"). That plan deferred it; this plan picks it up.

## Inventory: every place `whalesync/scratch-cli` is referenced

| File | Role | What changes |
|---|---|---|
| [scratch-desktop/electron-builder.yml:92-96](../../scratch-desktop/electron-builder.yml#L92-L96) | `publish.owner/repo` baked into `app-update.yml` at packaging time | Repo → new repo |
| [scratch-desktop/dev-app-update.yml:1-4](../../scratch-desktop/dev-app-update.yml#L1-L4) | Local dev override file used to test updater without packaging | Repo → new repo |
| [scratch-desktop/scripts/bootstrap_release.sh:30](../../scratch-desktop/scripts/bootstrap_release.sh#L30) | Creates the draft release, picks the next semver | Repo constant → new repo |
| [scratch-desktop/scripts/upload_assets.sh:34](../../scratch-desktop/scripts/upload_assets.sh#L34) | Uploads dmg/zip/AppImage/yml/blockmap to the release | Repo constant → new repo |
| [scratch-desktop/scripts/finalize_release.sh:32](../../scratch-desktop/scripts/finalize_release.sh#L32) | Aggregates checksums.txt, flips draft→published | Repo constant → new repo |
| [scratch-desktop/scripts/cleanup_failed_release.sh:34](../../scratch-desktop/scripts/cleanup_failed_release.sh#L34) | Deletes leftover draft release on pipeline failure | Repo constant → new repo |
| [scratch-desktop/scripts/preview_desktop_release_version.sh:30](../../scratch-desktop/scripts/preview_desktop_release_version.sh#L30) | Local-dev helper to preview next version | Repo constant → new repo |
| [scratch-desktop/scripts/update_homebrew_cask.sh:27](../../scratch-desktop/scripts/update_homebrew_cask.sh#L27) | Cask `url` references release asset URLs on the GitHub repo | `BASE_URL` → new repo |
| [scratch-desktop/scripts/update_homebrew_cask.sh:37,66](../../scratch-desktop/scripts/update_homebrew_cask.sh#L37) | Clones `whalesync/homebrew-scratch-cli` to push cask updates | Clone target → new tap `whalesync/homebrew-scratch-desktop` (per D8) |
| [scratch-desktop/.gitlab-ci-release.yml:450](../../scratch-desktop/.gitlab-ci-release.yml#L450) | Slack notification body links to GitHub release URL | URL host → new repo |
| [scratch-desktop/CLAUDE.md:119](../../scratch-desktop/CLAUDE.md#L119) | Doc: "pulls updates from … on `whalesync/scratch-cli`" | Update reference |
| [server/src/desktop-release/desktop-release.service.ts:7](../../server/src/desktop-release/desktop-release.service.ts#L7) | `GITHUB_REPO` constant for the `/downloads` API | Repo + filter logic simplification |
| [server/src/desktop-release/__tests__/desktop-release.service.spec.ts:31](../../server/src/desktop-release/__tests__/desktop-release.service.spec.ts#L31) | Test fixture URLs | Update fixtures |
| [client/src/app/downloads/page.tsx:15](../../client/src/app/downloads/page.tsx#L15) | "Releases on GitHub" link | Repo → new repo |

The Homebrew **tap** repo also splits — see D8.

## Design Decisions

### D1. New repo name: `whalesync/scratch-desktop`

Short, parallel with `whalesync/scratch-cli`, no `-releases` suffix needed (GitHub's "releases" tab is the implicit container). The repo can be empty of source code — a single README pointing at the GitLab monorepo where the actual code lives — or it can host the release pipeline scripts as a thin facade. Recommend **empty source repo**: source-of-truth stays in `whalesync/spinner`, the new repo exists purely to host releases. Lower drift, no second checkout for CI.

### D2. Drop the `-desktop` / `-desktop-test` tag infix

Once the repo only carries desktop releases, the `-desktop` part of the tag is redundant. New tag scheme:

- prod → `vX.Y.Z` (published, `prerelease: false`)
- test → `vX.Y.Z-test` (prerelease, `prerelease: true`)

Why keep the `-test` suffix? It still distinguishes prod and test tags in `releases.atom` so a stable install can never accidentally update to a test build, even before the channel manifest filter kicks in. The test channel can stay `prerelease: true` so it's also visible in GitHub's UI as such.

The electron-builder `channel` field stays — that's the layer that actually keeps stable/test installs separated, via `desktop-mac.yml` vs `desktop-test-mac.yml` channel manifests.

Alternative considered: **drop the `-test` suffix too, rely solely on `prerelease: true`**. Risk — the default GitHubProvider's atom-feed scan doesn't filter by prerelease unless `allowPrerelease: false` is set on the install, and the channel split via `channel:` is what really enforces it. Keeping `-test` in the tag is one extra belt for the suspenders, costs nothing.

### D3. Default `GitHubProvider` works on the new repo

The custom-provider workaround was already rolled back; [updater.ts](../../scratch-desktop/src/main/updater.ts) now uses electron-updater's default `GitHubProvider` driven by the baked `app-update.yml`. Today that's risky on `scratch-cli` (default provider can land on a CLI release and 404 on `desktop-mac.yml`). On the new repo, every entry in `releases.atom` IS a desktop release, so the default behavior is correct — no provider override needed.

This is the load-bearing reason to do the move at all.

### D4. Cutover is a single MR — no bridge, no staged rollout

The auto-updater has never been validated end-to-end against a real install, so no client in the wild is depending on the old repo's channel manifests. That removes the entire bridge-release dance.

The code change is one MR:

1. Land the Phase 2 MR (repo-name swaps + custom-provider deletion + tag-suffix simplification).
2. Cut a test-channel release on the new repo. Verify QA installs work end-to-end.
3. Cut a prod-channel release on the new repo when ready. The Homebrew cask CI job rewrites the cask `url` to the new repo on the same release.

Old desktop tags on `scratch-cli` (`v*-desktop`, `v*-desktop-test`) stay where they are as historical artifacts and can be deleted whenever — nothing reads them.

### D5. Server `/downloads` page lookup simplifies

[server/src/desktop-release/desktop-release.service.ts:43-65](../../server/src/desktop-release/desktop-release.service.ts#L43-L65) currently has a `lookupFor(kind, channel)` helper that distinguishes desktop-vs-CLI tags using suffix matching. After the move:

- **CLI lookups** stay on `whalesync/scratch-cli` and simplify (no need to exclude `-desktop`/`-desktop-test` tags — those tags won't exist there going forward).
- **Desktop lookups** point at the new repo, drop suffix matching, just match `^v\d+\.\d+\.\d+(-test)?$` for the channel.

Add a feature flag (`DESKTOP_RELEASE_REPO`) so the server can be flipped between old and new repos at deploy time, decoupling the server change from the client/CI change. After the cutover, the env var becomes the new constant.

### D6. Split the Homebrew tap: new `whalesync/homebrew-scratch-desktop` for the cask

Today, [update_homebrew_cask.sh](../../scratch-desktop/scripts/update_homebrew_cask.sh) clones `whalesync/homebrew-scratch-cli` and writes `Casks/scratch-desktop.rb` (and versioned variants `scratch-desktop@X.rb`) into it, alongside the CLI's own formulas. That coupling is fine functionally but means a desktop release commit can — in principle — be reverted in a way that touches CLI cask state, or a CI bug in the desktop pipeline can push to the same repo CLI users depend on.

**Decision**: create a new tap repo `whalesync/homebrew-scratch-desktop`. The desktop pipeline writes to it exclusively; the CLI tap is untouched.

Users will install the desktop cask via:

```
brew tap whalesync/scratch-desktop
brew install --cask scratch-desktop
```

(Versus today's `brew tap whalesync/scratch-cli` + `brew install --cask scratch-desktop`.)

Why a separate tap rather than just a separate cask file in the same tap:
- The user explicitly asked for the CLI release to be untouched. Same-tap changes always carry some risk that a pipeline bug or merge conflict spills onto CLI formulas. A separate repo with its own CI token forecloses that.
- It mirrors the GitHub release split — one repo per product line, top to bottom.
- Tap repos are cheap. There's no operational cost to a second one.

### D7. Homebrew migration for existing desktop cask users

This is a real but small surface. Existing `brew install --cask scratch-desktop` users from the `whalesync/scratch-cli` tap have a Cask formula pinned to `homebrew-scratch-cli/Casks/scratch-desktop.rb`. If we stop updating that file, they're frozen on whatever version was last pushed there.

Plan:

1. **Last update on the old tap**: ship one final cask commit to `whalesync/homebrew-scratch-cli/Casks/scratch-desktop.rb` whose `caveats` block tells users to switch taps:

   ```ruby
   caveats <<~EOS
     This cask has moved to the whalesync/scratch-desktop tap.
     To get future updates:
       brew uninstall --cask scratch-desktop
       brew untap whalesync/scratch-cli  # only if you don't also use the CLI
       brew tap whalesync/scratch-desktop
       brew install --cask scratch-desktop
   EOS
   ```

   The `caveats` text shows on every `brew install` and `brew info`. Bump the version one patch above the last real release so anyone on `brew upgrade` picks up the message exactly once.

2. **Stop updating the old cask** after that commit. Future desktop releases only update the new tap.

3. **Don't delete the old `scratch-desktop*.rb` files** — leaving them in place means stale installs keep working (frozen at last version) and any tooling pinned to the old tap doesn't 404.

Out-of-scope alternative: a Homebrew "rename" rule (an alias formula in the new tap that points users from the old). Skipped because it requires both taps to coexist in the user's `brew tap` list, which complicates the simple migration message above.

### D8. Seed the new repo with a placeholder tag so versions don't reset to 0.0.1

[bootstrap_release.sh:67-79](../../scratch-desktop/scripts/bootstrap_release.sh#L67-L79) picks the next version by scanning GitHub's releases list (drafts included) for tags matching the channel suffix and bumping from the highest one. On an empty repo it falls back to `FALLBACK_TAG` (`v0.1.0-desktop` for prod, `v0.0.0-desktop-test` for test), which would land the first release at `v0.1.1` / `v0.0.1` — a version-number regression versus the current `scratch-cli` desktop tags.

To avoid that, **manually create one draft release per channel on `whalesync/scratch-desktop` before the code MR lands**, with tags one patch below where you want the first real release to start. The script's atom-feed scan picks them up and bumps from there.

Pre-seeding via a real (draft) release is preferred over editing `FALLBACK_TAG` constants because:
- It's durable — the version source-of-truth lives where the script reads from (GitHub), not in a constant that goes stale the moment a real release lands on top.
- It survives a re-bootstrap or a script revert.
- Anyone reading the new repo can see the version starting point at a glance.

## Implementation Plan

### Phase 1 — Provision the new repo

**Owner: human (one-time, before code MR lands)**

1. Create `whalesync/scratch-desktop` on GitHub (empty, private or public — match `scratch-cli`'s visibility).
2. Generate a `GITHUB_TOKEN` with `repo` scope on the new repo. Add to GitLab CI variables as `DESKTOP_RELEASES_GITHUB_TOKEN` (or reuse the existing `GITHUB_TOKEN` if its scope already covers the new repo).
3. **Pre-seed version numbers** (per D8). Run [preview_desktop_release_version.sh](../../scratch-desktop/scripts/preview_desktop_release_version.sh) against `scratch-cli` to find the latest desktop semver currently in use (e.g. `v1.4.7`). On the new `whalesync/scratch-desktop` repo, create two draft releases:
   - **prod placeholder**: tag `v1.4.7` (substitute the actual current desktop semver). Title and body can be empty — this release will never be published. Once the code MR lands, the next prod bootstrap (`patch`) will produce `v1.4.8` as the first real release.
   - **test placeholder**: tag `v0.5.0-test` (or whatever fits — matching the latest `scratch-cli` `*-desktop-test` semver minus the `-desktop` infix is a sensible default). Mark as prerelease.
   
   These drafts can be created via the GitHub UI (Releases → Draft a new release → enter tag → Save draft) or via `gh release create vX.Y.Z --draft --target main`. The tag does not need to point at a real commit — GitHub allows draft releases to reference tags that don't exist yet on the git side.
4. **Create the new Homebrew tap repo** `whalesync/homebrew-scratch-desktop` (per D6). Empty repo with a `Casks/` directory; the desktop pipeline will populate `Casks/scratch-desktop.rb` on the first prod release. Confirm the existing CI `GITHUB_TOKEN` (or `HOMEBREW_TAP_TOKEN`) has push access — the CI job in [update_homebrew_cask.sh:66](../../scratch-desktop/scripts/update_homebrew_cask.sh#L66) clones via `https://${GITHUB_TOKEN}@github.com/...`, so a token without write access on the new repo silently 403s on push.
5. Optional: seed the new repo with a `README.md` pointing at the source repo and the downloads page.

### Phase 2 — Code MR: parametrize repo, point everything at the new one

**Files**:
- [scratch-desktop/electron-builder.yml](../../scratch-desktop/electron-builder.yml) — `publish.repo: scratch-desktop` (and optionally `${env.PUBLISH_REPO}` if we want a kill-switch).
- [scratch-desktop/dev-app-update.yml](../../scratch-desktop/dev-app-update.yml) — `repo: scratch-desktop`. Keep `channel: desktop-test` — it still selects which channel manifest (`desktop-test-mac.yml`) the dev build reads.
- All 6 release scripts — replace the `GITHUB_REPO="whalesync/scratch-cli"` constant with `whalesync/scratch-desktop`. Keep the constant local to each script (no need to thread an env var — these are now hardcoded to one product line).
- [scratch-desktop/scripts/update_homebrew_cask.sh](../../scratch-desktop/scripts/update_homebrew_cask.sh) — change the clone URL ([line 66](../../scratch-desktop/scripts/update_homebrew_cask.sh#L66)), `TAP_DIR` ([line 37](../../scratch-desktop/scripts/update_homebrew_cask.sh#L37)), and the doc comments to point at `whalesync/homebrew-scratch-desktop`. The `BASE_URL` for asset URLs is already covered by the `GITHUB_REPO` swap above. **Do not** modify the cask file naming (`scratch-desktop.rb`, `scratch-desktop@*.rb`) — that's user-facing.
- [scratch-desktop/scripts/bootstrap_release.sh:32-44](../../scratch-desktop/scripts/bootstrap_release.sh#L32-L44) — drop `TAG_SUFFIX="-desktop"` for prod (becomes `""`), keep `-test` for test variant. Adjust `FALLBACK_TAG` accordingly. Adjust `LATEST_TAG` selection logic so prod scans for tags **without** `-test` suffix and **without** `-desktop`/`-desktop-test` legacy suffixes.
- [scratch-desktop/scripts/preview_desktop_release_version.sh](../../scratch-desktop/scripts/preview_desktop_release_version.sh) — same tag-suffix logic update.
- [scratch-desktop/.gitlab-ci-release.yml:450](../../scratch-desktop/.gitlab-ci-release.yml#L450) — Slack URL host swap.
- [server/src/desktop-release/desktop-release.service.ts:7](../../server/src/desktop-release/desktop-release.service.ts#L7) — make `GITHUB_REPO` come from `ScratchConfigService` (new env var `DESKTOP_RELEASE_GITHUB_REPO`, default `whalesync/scratch-desktop`). Simplify `lookupFor('desktop', channel)` to drop suffix-exclusion logic.
- [server/src/desktop-release/__tests__/desktop-release.service.spec.ts](../../server/src/desktop-release/__tests__/desktop-release.service.spec.ts) — update fixture URLs and tag shapes.
- [client/src/app/downloads/page.tsx:15-16](../../client/src/app/downloads/page.tsx#L15-L16) — update `GITHUB_REPO`/`RELEASES_URL`.

No updater code changes required — the custom provider was already rolled back, and the default `GitHubProvider` is what production uses.

### Phase 3 — Cutover

1. Land Phase 2 MR.
2. Cut a test-channel release on the new repo. Install the build on a QA box, manually trigger "Check for updates", verify no errors and that a subsequent test release is offered.
3. Cut a prod-channel release on the new repo when ready. The Homebrew cask CI job pushes to the **new** tap (`whalesync/homebrew-scratch-desktop`); verify `brew tap whalesync/scratch-desktop && brew install --cask scratch-desktop` works on a clean machine.
4. **Hand-write a final commit on the OLD tap** (`whalesync/homebrew-scratch-cli/Casks/scratch-desktop.rb`) per D7 — bump the version one patch above the last release pushed by CI, and add the `caveats` block telling users to switch taps. This is a one-off, not part of any CI pipeline. Push directly to the old tap. Versioned siblings (`scratch-desktop@*.rb`) can get the same caveats or be left alone — they're rarely used.
5. Stop modifying the old tap from this point on.

That's it. No T+30 / T+90 phases.

## Validation Checklist

- [ ] New repo `whalesync/scratch-desktop` exists and CI token has write access.
- [ ] First test-channel release on the new repo is downloadable and the channel manifest (`desktop-test-mac.yml`) is uploaded as an asset.
- [ ] A test-channel install built from the new code checks for updates against the new repo and a follow-up release is offered on next check.
- [ ] First prod-channel release on the new repo is downloadable.
- [ ] `client/src/app/downloads/page.tsx` "View releases on GitHub" link points at the new repo.
- [ ] `server` `/api/v1/desktop-release/latest` returns the new-repo release.
- [ ] CI's `update_homebrew_cask` job pushes the cask to `whalesync/homebrew-scratch-desktop` (NOT to `homebrew-scratch-cli`) on the first prod release.
- [ ] `brew tap whalesync/scratch-desktop && brew install --cask scratch-desktop` succeeds on a fresh machine and pulls from the new GitHub repo's release URLs.
- [ ] `whalesync/homebrew-scratch-cli/Casks/scratch-desktop.rb` carries the migration `caveats` block and is not further modified by CI after Phase 3 step 4.
- [ ] CLI Homebrew formulas in `whalesync/homebrew-scratch-cli` are unchanged by the desktop pipeline (diff before/after).

## Risks & Open Questions

- **Homebrew tap split is user-visible.** Existing `brew install --cask scratch-desktop` users from `whalesync/scratch-cli` will see the migration `caveats` block on next `brew info` / `brew install`, but `brew upgrade` won't auto-migrate them — they have to manually `brew untap` / `brew tap` / reinstall. Anyone who never reads the caveats sits on the frozen old version forever. Acceptable: the desktop user base is small and the migration message is unmissable on any active brew interaction.
- **`scratch-cli` repo's CLI releases.** This plan does NOT touch CLI releases. They keep living on `scratch-cli` with the same tag scheme. The repo just stops getting `*-desktop*` tags going forward.
- **Release notes / GitHub UI.** Today, opening `https://github.com/whalesync/scratch-cli/releases` shows a mix. After cutover, opening the new repo shows only desktop releases — cleaner for users browsing manually. The downloads page in `client/` already filters server-side, no UI change there.
- **Token scoping.** The existing CI `GITHUB_TOKEN` may be a personal access token tied to a specific repo. Verify scope covers the new repo before cutover, or provision a new token. A 401 on the bootstrap job during the cutover would be embarrassing.
- **Atom feed pagination.** Once the new repo only has desktop releases, the [bootstrap_release.sh](../../scratch-desktop/scripts/bootstrap_release.sh) and [preview_desktop_release_version.sh](../../scratch-desktop/scripts/preview_desktop_release_version.sh) "scan first 3/5 pages" logic becomes overkill — at ~10 desktop releases per quarter, page 1 will hold years of history. No change required, just a future cleanup opportunity.
- **Does the new repo need its own README / docs site?** If users are linked to `https://github.com/whalesync/scratch-desktop` from the in-app "About" dialog or from the cask description, an empty repo looks half-done. Recommend seeding a one-page README with download links + pointer back to the main product page.
- **Old `*-desktop*` tags on `scratch-cli`.** They're harmless to leave (nothing reads them after the MR lands) and harmless to delete. Default: leave them. Anyone who manually downloaded an installer from one of those releases keeps the same URL working.

## Deliverables Checklist

**Phase 1 (human, one-time)**
- [ ] `whalesync/scratch-desktop` repo created
- [ ] CI token verified
- [ ] Prod + test placeholder draft releases pre-seeded (per D8)
- [ ] `whalesync/homebrew-scratch-desktop` tap repo created with `Casks/` directory
- [ ] CI token for the new tap repo added (or scope of existing token verified)

**Phase 2 (code MR)**
- [ ] `electron-builder.yml`, `dev-app-update.yml` point at new repo
- [ ] All 6 release scripts updated (repo constant + tag-suffix logic)
- [ ] `update_homebrew_cask.sh` clone target switched to `whalesync/homebrew-scratch-desktop`
- [ ] `.gitlab-ci-release.yml` Slack URL updated
- [ ] Server `desktop-release.service.ts` reads repo from config; suffix-exclusion logic dropped for desktop lookups
- [ ] Server tests updated
- [ ] Client `downloads/page.tsx` link updated
- [ ] `scratch-desktop/CLAUDE.md` updated

**Phase 3 (cutover)**
- [ ] Test release cut on new repo, manual update check verified end-to-end
- [ ] Prod release cut on new repo
- [ ] Cask pushed to new Homebrew tap; `brew tap whalesync/scratch-desktop && brew install --cask scratch-desktop` verified on a fresh machine
- [ ] Hand-written migration commit on `whalesync/homebrew-scratch-cli/Casks/scratch-desktop.rb` with `caveats` block
