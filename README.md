# Scratch CLI — Test Channel

Packaged releases for the **test channel** of the `scratchmd` command-line tool.

> ⚠️ **Internal test builds — not for end users.** The binaries published here are compiled to point at Whalesync's **test** backend (`test-api.scratch.md`) and can change, break, or be replaced at any time. For the real tool, use the production builds (see [Production CLI](#production-cli) below).

## What this repo is

This repository holds **only the packaged releases** of the test build of the `scratchmd` CLI — the compiled binaries for each platform. There's no source code here; the CLI is built from Whalesync's internal monorepo and published to this repo automatically by CI.

Keeping the test channel in its own repository — separate from the production repo, [`whalesync/scratch-cli`](https://github.com/whalesync/scratch-cli) — gives each channel its own release stream, so test builds never share a release list or tag namespace with production.

## Downloads

Grab a build from the [**Releases**](../../releases) page. Test builds are published as **prereleases** (tag `vX.Y.Z-test`), so pick the newest entry from the Releases list — GitHub's `/releases/latest` deliberately skips prereleases and won't point here. Each release attaches one archive per platform:

- **macOS** (Apple Silicon / arm64) — `scratchmd_darwin_arm64.tar.gz`
- **Linux** (x86_64) — `scratchmd_linux_amd64.tar.gz`
- **Windows** (x86_64) — `scratchmd_windows_amd64.zip`

The binaries are unsigned. On macOS, clear the quarantine flag before the first run (`xattr -d com.apple.quarantine ./scratchmd`); on Windows, SmartScreen may warn.

## Install

There's **no auto-update** for the CLI — to move to a newer test build, download and replace the binary. Most people get the CLI bundled inside the Scratch Desktop app; a standalone install is for advanced users.

​```bash
# macOS (Apple Silicon) example
tar -xzf scratchmd_darwin_arm64.tar.gz
sudo mv scratchmd /usr/local/bin/scratchmd
scratchmd --version
​```

These builds talk to `test-api.scratch.md`. There is **no Homebrew tap or Scoop bucket for the test channel** — those exist for production only.

## How releases are produced

Releases here are cut **automatically** by a scheduled "Hourly Test Releases" pipeline in Whalesync's internal monorepo — they aren't authored by hand. Tags are `vX.Y.Z-test` and each release is marked as a **prerelease**. A scheduled job also prunes old test releases. Please treat this repo as **CI-managed**: don't manually create, edit, or delete releases.

This repo hosts build artifacts only and isn't monitored for issues — please raise bugs through the usual internal Whalesync channels.

## Production CLI

Looking for the real thing? Production builds live in **[`whalesync/scratch-cli`](https://github.com/whalesync/scratch-cli)** — installable via the Homebrew tap (`brew install whalesync/scratch-cli/scratchmd`) or the Scoop bucket on Windows, or downloadable from the Scratch web app's downloads page. The CLI also ships bundled inside the Scratch Desktop app.

## About Scratch

Scratch is a content management system that syncs data between external services (Airtable, Webflow, Notion, and more) and a git-based storage layer, giving knowledge workers a VS Code–like workspace for managing content. Learn more at [scratch.md](https://scratch.md).
