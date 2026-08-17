# Runbook: Scratch Desktop / CLI download links broken

Guide for the two Google Cloud Monitoring alerts that fire to Slack **`#feed-gcp-alerts`** when the Scratch **download links stop working** — either on our own downloads page or at the underlying GitHub release source. Created for **DEV-11324** after the `app.scratch.md/downloads` links broke (2026-08-17) with no automated signal.

## Context

| Item | Value |
| --- | --- |
| GCP project | `spv1eu-production` (region `europe-west1`) — checks run **prod only** |
| Downloads page | [`app.scratch.md/downloads`](https://app.scratch.md/downloads) (`client/src/app/downloads/page.tsx`) |
| Server endpoints | `GET https://api.scratch.md/desktop-release/latest` and `.../desktop-release/cli/latest` (unauthenticated), served by `server/src/desktop-release/desktop-release.service.ts` |
| GitHub source | `whalesync/scratch-desktop` (desktop app) and `whalesync/scratch-cli` (the `scratchmd` CLI) — separate repos, one release channel each for prod (bare-semver tag, non-prerelease) |
| Alert definitions | [`terraform/modules/env/monitoring.tf`](../../terraform/modules/env/monitoring.tf) — "Desktop / CLI download health (DEV-11324)" section (13 uptime checks — one per platform, since GCP allows only one content matcher per check — grouped into 5 per-surface alert policies) |
| Toggles | `enable_desktop_release_monitoring` (our endpoints) and `enable_github_release_monitoring` (GitHub source) — both `true` in `envs/eu-production`, `false` in `envs/eu-test` |
| Notification | Cloud Monitoring → Slack `#feed-gcp-alerts` + email. Severity **WARNING** (no PagerDuty page); renotifies every 30 min |

## Why an HTTP-200 check is not enough

The downloads page reads the server endpoint, which resolves the newest matching GitHub release and returns its `assets[]`. The client groups assets into per-platform buttons by **filename** (macOS `.dmg`, Windows `.exe`, Linux `.AppImage`/`.deb`; CLI `scratchmd_darwin_`/`_windows_`/`_linux_`). If the resolved release has assets but **none match a platform pattern**, the page renders an **empty download area with HTTP 200 and no error**. So we run **one uptime check per platform installer** (GCP currently allows only one `content_matcher` per check), each asserting its pattern is present **and** the status is 2xx. Running them per-platform is also what independently catches a *partial* release (e.g. the macOS-only release that once shipped as v1.0.49). A 404 (no release matched the prod channel at all) fails every check via the status assertion. This mirrors the release-time gate `scratch-desktop/scripts/finalize_release.sh` (`assert_all_required_platform_installers_present`).

## The five alerts

Each alert covers one surface; the failing **condition name identifies the exact platform** (e.g. `desktop-macos`, `cli-windows`). A check fails when it does not return 2xx, or its body is missing that platform's asset, from ≥2 prober regions.

| Alert | Surface |
| --- | --- |
| **Download - desktop server endpoint broken** (`scratch_desktop_download_server_broken`) | `api.scratch.md/desktop-release/latest` (mac/win/linux installers) |
| **Download - CLI server endpoint broken** (`scratch_cli_download_server_broken`) | `api.scratch.md/desktop-release/cli/latest` (darwin/windows/linux archives) |
| **Download - GitHub desktop release source broken** (`github_desktop_release_source_broken`) | `api.github.com/repos/whalesync/scratch-desktop/releases/latest` |
| **Download - GitHub CLI release source broken** (`github_cli_release_source_broken`) | `api.github.com/repos/whalesync/scratch-cli/releases/latest` |
| **Download - GitHub releases page not loading** (`github_releases_page_broken`) | `github.com/whalesync/scratch-desktop/releases` (the "Browse all releases" fallback) |

The **server** alerts (first two) vs the **GitHub** alerts (last three) are the key triage signal, below.

**The server-vs-GitHub distinction is the key triage signal:**

- **Server alert fires, GitHub alert green** → the release on GitHub is fine; the problem is our **server or its Redis cache** (the server serves a 30-day last-known-good response and a negative cache). Suspect the server, the `GITHUB_RELEASES_TOKEN`, or a channel-resolution bug.
- **GitHub alert fires** → the **release source itself** is bad (missing installers / no matching release) **or GitHub is down**. Users may still be getting the cached-good download (server alert green), but the newest published release is broken.
- **Both fire** → a bad release that has already propagated through the cache — the most user-visible state.

## Confirm

```bash
# What the downloads page actually sees (our server):
curl -s https://api.scratch.md/desktop-release/latest      | jq '.assets[].name'
curl -s https://api.scratch.md/desktop-release/cli/latest  | jq '.assets[].name'

# The GitHub source directly (bypasses our cache):
curl -s https://api.github.com/repos/whalesync/scratch-desktop/releases/latest | jq '{tag: .tag_name, prerelease, assets: [.assets[].name]}'
curl -s https://api.github.com/repos/whalesync/scratch-cli/releases/latest     | jq '{tag: .tag_name, prerelease, assets: [.assets[].name]}'
```

A healthy desktop release has ≥1 `*.dmg`, ≥1 `*.exe`, and ≥1 `*.AppImage`/`*.deb`. A healthy CLI release has `scratchmd_darwin_*`, `scratchmd_windows_*`, `scratchmd_linux_*`. A `404` from either GitHub call means **no non-prerelease, non-draft release with a bare-semver tag** (`^v\d+\.\d+\.\d+$`) exists — the exact failure mode from DEV-11324, where the prod channel had no valid latest release.

## Remediate

The fix is to **publish/finalize a valid release** with all platform installers attached:

- Desktop: run the `scratch-desktop` release pipeline (`.gitlab-ci-release.yml`); its `finalize_release.sh` enforces the per-platform installer contract before flipping `draft:false`. If a recent bad release is the "latest", **remove or fix it** — see [`runbook-burn-bad-desktop-release.md`](./runbook-burn-bad-desktop-release.md).
- CLI: publish a non-prerelease `scratch-cli` release with the three `scratchmd_*` archives.
- Interim mitigation (what was done on 2026-08-17): re-publish a known-good older stable release so GitHub's "latest" (non-prerelease) resolves again.

The server caches a fresh response for **5 minutes**, so once a good release is live the server alert clears within roughly one check period (uptime checks run every 5 min for our endpoints, 15 min for GitHub).

## Known false-alarm sources

- **GitHub anonymous rate limits** (60 req/hr/IP): the GitHub checks run anonymously at a 15-min cadence (~4 req/hr per prober region), well under the limit, but Cloud Monitoring prober IPs are shared across GCP customers, so an occasional `403` is possible. The alert requires **≥2 regions failing** to reduce this. If rate-limit 403s become a recurring false alarm, lengthen the GitHub check `period`, or add an authenticated `Authorization: Bearer …` header (note: uptime-check headers are stored in plaintext in Terraform state — use a fine-grained, read-only, public-repo-scoped token if you do).
- **Asset renames**: the content matchers are coupled to filename conventions. A legitimate rename of the installers/archives will trip the alert — update the `content_matchers` in `monitoring.tf` alongside any such rename.
- **Test channel**: not monitored (toggles off in `envs/eu-test`) because the `-test` channel republishes hourly and is frequently mid-publish.

## Escalate to page (if warn tier proves insufficient)

In `terraform/modules/env/monitoring.tf`, on the relevant alert policy swap:

```hcl
notification_channels = local.notification_channels   # was: local.warning_notification_channels  (adds PagerDuty)
severity              = "ERROR"                        # was: "WARNING"
```

To silence during a **known** release/republish, snooze the alert policy in the Cloud Monitoring console for the maintenance window.
