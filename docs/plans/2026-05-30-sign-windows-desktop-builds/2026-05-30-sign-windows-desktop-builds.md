# Sign Windows Desktop Builds

## Goal

The GitLab desktop release pipeline currently builds, signs, and notarizes the macOS app, but ships the Windows NSIS installer **unsigned**. Users installing `Scratch-Setup-x.y.z-x64.exe` get a SmartScreen "Unknown publisher" warning, and the auto-updater on Windows is shipping unsigned NSIS updates.

This plan wires up SSL.com eSigner cloud-HSM code signing into the Windows package job, splits the Windows release into its own pipeline stage gated behind a separate manual button, and tunes per-release signing cost so we stay within the **120-transactions-per-year SSL.com quota**.

Outcome: signed `Scratch.exe` + signed `Scratch-Setup-x.y.z-x64.exe` shipped to the same `whalesync/scratch-desktop` GitHub release as the Mac/Linux assets, on a deliberately throttled cadence (~weekly).

## Inputs already verified

- **Current state confirmed** by reading [`scratch-desktop/electron-builder.yml`](../scratch-desktop/electron-builder.yml) (lines 86–88 — the `win:` block has no signing config) and [`scratch-desktop/scripts/package.sh`](../scratch-desktop/scripts/package.sh) (lines 81–85 — comment literally says "Signing is not configured yet"). The Windows package job in [`scratch-desktop/.gitlab-ci-release.yml`](../scratch-desktop/.gitlab-ci-release.yml) runs `electronuserland/builder:wine` on a shared Linux runner with no signing env vars wired in.
- **Provider chosen: SSL.com eSigner.** Whalesync already has an SSL.com account. SSL.com over Azure Trusted Signing because: no 3-year org age requirement, no Azure dependency in an otherwise-GCP stack, true EV cert with org name on the Subject directly, and existing relationship.
- **Quota: 120 signing transactions/year.** Each invocation of CodeSignTool counts as 1 transaction regardless of file size. No batch endpoint exists.
- **Cadence target: ~weekly Windows releases** (~52/year), which forces both (a) cost reduction per release via file filtering and (b) a manual gate so we never accidentally fire one.
- **Linux CI signing is viable** via SSL.com's `CodeSignTool` (Java CLI, official from SSL.com). The existing `electronuserland/builder:wine` image needs only `default-jre-headless` + `unzip` added.

## Signing cost budget

At default electron-builder behavior, every Windows release would sign 4 files: `Scratch.exe`, `scratchmd.exe`, `Uninstall Scratch.exe`, `Scratch-x.y.z-x64.exe`. That's 4 transactions per release.

| Strategy | Transactions/release | Releases/year at quota | Weekly fits? |
| --- | --- | --- | --- |
| Sign everything | 4 | 30 (~every 12 days) | No |
| **Filter to `Scratch.exe` + `Setup.exe`** | **2** | **60** | **Yes (~16/yr headroom)** |
| Sign Setup.exe only | 1 | 120 | Yes, but breaks auto-updater publisher verification on installed app — terrible UX |

**Chosen: 2-file filter.** Visible cost is "Unknown publisher" on the uninstaller UAC dialog and on `scratchmd.exe` if a user manually double-clicks it in the install dir. Acceptable for an internal helper binary.

`scratchmd.exe` runs as a child process of the signed Electron app. Windows does not run SmartScreen on subprocess launches from a parent process — only on user-initiated `.exe` execution. So leaving it unsigned has no SmartScreen impact in normal use.

DLLs unsigned is fine on consumer Windows. Hostile to Smart App Control / WDAC enterprise baselines (rare); flag if we sell into locked-down enterprise IT.

## Architecture

**Fully separate Windows pipeline.** Mac/Linux ship as one thing on the existing manual `Bootstrap prod desktop release` click. Windows ships as a separate manual click on a new `Bootstrap prod Windows desktop release`, in its own stage. Windows attaches its assets to the already-published GitHub release that Mac/Linux finalized.

```
Stages:
  release desktop app        # Mac + Linux — existing flow, Windows removed
  release desktop windows    # new — Windows-only, separate manual gate
```

Why fully separate instead of just `when: manual` on the existing Windows jobs:
- No `optional:` needs hack in finalize
- No conditional checksum-refresh logic
- No "Windows might or might not be in this release" cognitive load when reading the pipeline graph
- Failures isolated — Windows signing breakage can't affect a Mac/Linux release

Side effect to accept: Windows release lags Mac. If Mac shipped 1.4.0 → 1.4.1 → 1.4.2 → 1.4.3 over a week and we click Windows now, Windows ships 1.4.3 directly. Windows users go 1.4.0 → 1.4.3 without seeing 1.4.1/1.4.2 release notes. Auto-updater handles this fine; release notes won't perfectly describe the diff.

## Slices

### Slice 1 — SSL.com credentials + sign hook (no pipeline changes yet)

- **Gather SSL.com credentials** (one-time, human task):
  - Username
  - Password
  - Credential ID (UUID from eSigner → Credentials)
  - **TOTP secret — the raw base32 seed**, not a one-time code. Required for unattended CI signing. Get from eSigner → Setup TOTP or regenerate.
- **Add GitLab CI/CD variables** (masked + protected so MR pipelines from branches can't read them):
  - `SSL_COM_USERNAME`
  - `SSL_COM_PASSWORD`
  - `SSL_COM_CREDENTIAL_ID`
  - `SSL_COM_TOTP_SECRET`
- **Create [`scratch-desktop/scripts/sign-windows.cjs`](../scratch-desktop/scripts/sign-windows.cjs)** — electron-builder calls this once per file. Implements the 2-file filter (`Scratch.exe`, `Scratch-x.y.z-x64.exe`) and shells out to CodeSignTool. Sketch:

  ```js
  const { execFileSync } = require('node:child_process');
  const path = require('node:path');

  exports.default = async function sign(configuration) {
    const file_to_sign_absolute_path = configuration.path;
    const file_basename_lowercase = path.basename(file_to_sign_absolute_path).toLowerCase();
    const is_main_electron_app_exe = file_basename_lowercase === 'scratch.exe';
    const is_outer_nsis_installer_setup_exe = /^scratch-\d+\.\d+\.\d+-x64\.exe$/i.test(file_basename_lowercase);
    if (!is_main_electron_app_exe && !is_outer_nsis_installer_setup_exe) {
      console.log(`[sign-windows] skipping ${file_basename_lowercase}`);
      return;
    }

    const codesigntool_install_directory = process.env.CODESIGNTOOL_DIR;
    const codesigntool_executable_path = path.join(codesigntool_install_directory, 'CodeSignTool.sh');
    const required_env_var_names = ['SSL_COM_USERNAME', 'SSL_COM_PASSWORD', 'SSL_COM_CREDENTIAL_ID', 'SSL_COM_TOTP_SECRET'];
    for (const env_var_name of required_env_var_names) {
      if (!process.env[env_var_name]) throw new Error(`Missing required env var: ${env_var_name}`);
    }

    console.log(`[sign-windows] signing ${file_basename_lowercase}`);
    execFileSync(
      codesigntool_executable_path,
      [
        'sign',
        `-username=${process.env.SSL_COM_USERNAME}`,
        `-password=${process.env.SSL_COM_PASSWORD}`,
        `-credential_id=${process.env.SSL_COM_CREDENTIAL_ID}`,
        `-totp_secret=${process.env.SSL_COM_TOTP_SECRET}`,
        `-input_file_path=${file_to_sign_absolute_path}`,
        '-override=true',
      ],
      { stdio: 'inherit', cwd: codesigntool_install_directory },
    );
  };
  ```

- **Edit [`scratch-desktop/electron-builder.yml`](../scratch-desktop/electron-builder.yml)** `win:` block:
  ```yaml
  win:
    icon: build/icons/win/icon.ico
    artifactName: '${productName}-${version}-${arch}.${ext}'
    signingHashAlgorithms:
      - sha256
    sign: scripts/sign-windows.cjs
    signtoolOptions:
      publisherName: Whalesync Inc.   # must exactly match the SSL.com cert Subject
  ```
  `publisherName` must match the legal entity on the cert exactly — electron-builder embeds it in `latest.yml` so the auto-updater can verify update signatures. Pick once, never change — renaming it breaks auto-update for already-installed users.

- **Update [`scratch-desktop/scripts/package.sh`](../scratch-desktop/scripts/package.sh:81-85)** — remove the "Signing is not configured yet" comment.

**Exit criteria**: Locally, `electron-builder.yml` references the hook but doesn't fail when env vars are absent (test by running `yarn build:mac:local` — Mac path shouldn't touch the Windows hook). Hook file lints clean.

### Slice 2 — New `release desktop windows` stage

- **Add stage to [`gitlab-ci/stages.yml`](../gitlab-ci/stages.yml)** after `release desktop app`: `release desktop windows`.
- **In [`scratch-desktop/.gitlab-ci-release.yml`](../scratch-desktop/.gitlab-ci-release.yml)**:

  **New job: `Bootstrap prod Windows desktop release`**
  - `stage: release desktop windows`
  - `when: manual`, `if: $CI_COMMIT_BRANCH == "prod"`, `needs: []`
  - Doesn't touch GitHub for release creation. Doesn't bump version.
  - Reads `package.json#version` (already bumped by the prior Mac/Linux bootstrap on `prod`), looks up the published release by tag via GitHub API, emits `release.env` with `RELEASE_ID`, `NEW_VERSION`, `SEMVER`.
  - New script `scratch-desktop/scripts/bootstrap_windows_release.sh`. Should error out unless the release exists and `draft: false` — forces the natural ordering "Mac/Linux finalize first, then Windows attaches."
  - Uses `resource_group: github-releases` (same as existing bootstrap).

  **New job: `Build CLI for prod Windows desktop release`**
  - `stage: release desktop windows`
  - Copy of existing `.build_cli_for_desktop` but **Windows-only**: drop the `aarch64-apple-darwin` and `x86_64-unknown-linux-gnu` cargo zigbuild lines and the napi cdylib lines for those targets. Keep only:
    ```
    mkdir -p cli-binaries/x86_64-pc-windows-gnu
    SCRATCH_DEFAULT_URL="$SCRATCH_DEFAULT_URL" cargo zigbuild --release --bin scratchmd --target x86_64-pc-windows-gnu
    cp target/x86_64-pc-windows-gnu/release/scratchmd.exe cli-binaries/x86_64-pc-windows-gnu/scratchmd.exe
    ```
  - `needs: Bootstrap prod Windows desktop release` (artifacts: false).
  - Separate cargo cache key from the Mac/Linux CLI job. If it goes cold between weekly builds the first compile is slow — cosmetic, not a quota concern.

  **Move `Package prod Windows`** to `release desktop windows` stage:
  - `needs:` becomes the new Windows bootstrap + new Windows CLI build (both with `artifacts: true`).
  - Update `.package_desktop_windows` `before_script` to install Java + CodeSignTool **before** invoking `package.sh`:
    ```yaml
    .package_desktop_windows:
      extends: .package_desktop
      image: electronuserland/builder:wine
      variables:
        PLATFORM: 'windows'
        CODESIGNTOOL_VERSION: '1.3.2'  # pin
        CODESIGNTOOL_DIR: '/opt/codesigntool'
      before_script:
        - apt-get update -qq && apt-get install -y default-jre-headless unzip
        - mkdir -p "$CODESIGNTOOL_DIR"
        - curl -fsSL "<pinned-mirror-url>" -o /tmp/cst.zip
        - unzip -q /tmp/cst.zip -d "$CODESIGNTOOL_DIR"
        - chmod +x "$CODESIGNTOOL_DIR"/CodeSignTool.sh
        - cd scratch-desktop
        - chmod +x scripts/package.sh
    ```
  - **Mirror the CodeSignTool zip** into our own GCS bucket and pin the URL/SHA256. SSL.com's "latest" redirect can break CI silently.

  **Move `Upload prod Windows assets`** to `release desktop windows` stage:
  - `needs:` becomes the new Windows bootstrap + new `Package prod Windows`.
  - Uploads to the *published* release (GitHub allows asset uploads to published releases; existing `upload_assets.sh` already does DELETE-then-POST, so it's idempotent).

  **New job: `Finalize prod Windows release`**
  - `stage: release desktop windows`
  - `needs:` Windows bootstrap + `Upload prod Windows assets`.
  - New script `scratch-desktop/scripts/finalize_windows_release.sh` — the checksum-aggregation half of the existing `finalize_release.sh`. Re-aggregates `checksums.txt` from the now-complete asset list, re-uploads it to the release.
  - No Homebrew step (Mac/Linux owns that).
  - No draft→published flip (already published).

  **Optional: `Notify slack prod Windows release published`** — same pattern as the existing Slack jobs.

**Exit criteria**: New stage shows up in pipeline graph with manual `Bootstrap prod Windows desktop release` button. No automatic triggering. Validated by inspecting a prod pipeline visualization without clicking the button — the new jobs should sit pending forever.

### Slice 3 — Strip Windows from the existing Mac/Linux flow

- **`.build_cli_for_desktop`** in [`scratch-desktop/.gitlab-ci-release.yml`](../scratch-desktop/.gitlab-ci-release.yml) — drop the `x86_64-pc-windows-gnu` mkdir + zigbuild + cp lines. Mac/Linux CLI compile becomes actually Mac/Linux only.
- **Delete jobs**: existing `Package prod Windows`, `Upload prod Windows assets`.
- **`Finalize prod release`** — drop `Upload prod Windows assets` from its `needs:`. Finalize now publishes the release with Mac + Linux assets only; Windows attaches later.

**Exit criteria**: A prod-branch pipeline can complete end-to-end (Mac/Linux only) without touching any Windows job. The published GitHub release has Mac + Linux assets and a `checksums.txt` covering those.

### Slice 4 — Strip test Windows builds entirely

- **Delete jobs**: `Package test Windows`, `Upload test Windows assets` in [`scratch-desktop/.gitlab-ci-release.yml`](../scratch-desktop/.gitlab-ci-release.yml).
- **`Finalize test release`** — drop `Upload test Windows assets` from its `needs:`.
- **Drop windows target** from `Build CLI for test desktop release` (same edit as Slice 3 applied to test).

Rationale: test releases auto-fire on every `master` merge. Building Windows for every master merge would either burn the entire quota in weeks (if signing) or ship unsigned test installers no one uses. End-to-end verification of the Windows pipeline can happen against `prod` directly via the new manual button — it's the same flow.

**Exit criteria**: `master` pushes no longer produce Windows artifacts in test releases. Test release GitHub releases contain Mac + Linux only.

### Slice 5 — Quota tracking

Two low-cost mechanisms, do both:

1. **Per-build log line** — `sign-windows.cjs` `console.log`s each transaction. The Finalize Windows job adds a Slack notification summary "Used N signing transactions" via the existing Slack webhook pattern.
2. **Monthly calendar reminder** to check the SSL.com dashboard and confirm the running total against expected (~5/month at 2 transactions × ~2.5 releases/month if cadence drifts, or ~8/month at strict weekly).

If we discover we're trending over budget, the next moves in order of preference are: (a) cut cadence; (b) upgrade SSL.com tier; (c) drop to Setup.exe-only signing (rejected above on UX grounds — revisit if forced).

### Slice 6 — Verify on real Windows

Once Slices 1–4 land and the first prod pipeline runs successfully:

1. Download `Scratch-Setup-x.y.z-x64.exe` from the published GitHub release.
2. On Linux/Mac: `osslsigncode verify Scratch-Setup-x.y.z-x64.exe` — should report valid signature, Whalesync Inc. as Subject.
3. On a clean Windows VM:
   - Right-click installer → Properties → Digital Signatures: should show Whalesync Inc. with valid timestamp.
   - PowerShell: `Get-AuthenticodeSignature .\Scratch-Setup-1.2.3-x64.exe` → `Valid`.
   - Run installer; SmartScreen should show verified publisher name (or pass silently if EV reputation has been built).
   - After install, run `Scratch.exe` from the install dir → `Get-AuthenticodeSignature` → `Valid`.
   - Uninstall via Control Panel: UAC dialog will show "Unknown publisher" — expected, documented above.
4. Confirm the auto-updater path: install an older signed version, let it pick up the new release, confirm update applies. The `publisherName` field in `latest.yml` must match across both for the verification to succeed.

## Open questions

- **Are we 100% sure our SSL.com product is eSigner cloud signing, not a YubiKey EV token?** This plan assumes eSigner. If we actually have a physical USB token, the entire CI integration path is different (and Linux-CI-incompatible — would require a self-hosted Windows runner with the token attached). **Verify before starting Slice 1.**
- **TOTP rate limits.** SSL.com throttles ~3 signatures per ~30s window per credential. With the 2-file filter at 2 transactions per release we should be fine, but worth confirming by reading the SSL.com docs against our actual tier.
- **CodeSignTool malware pre-scan.** Default behavior runs a malware scan on SSL.com's side before signing. For Electron installers this is usually fine; if a build fails scan, we need either SSL.com support engagement or `-malware_block=false` (only if our account allows it). Worth doing a one-off test sign of a recent unsigned `Setup.exe` artifact manually before plumbing CI.
- **`publisherName` exact string.** Whatever we write in `electron-builder.yml`'s `signtoolOptions.publisherName` must match the SSL.com cert Subject exactly. Read the cert before committing the YAML.
- **CodeSignTool zip mirror location.** We don't have an obvious "Whalesync CI artifacts" GCS bucket. Either create one or accept the SSL.com redirect risk and pin to a specific version number we can re-pin if the upstream URL changes.

## What this plan does **not** cover

- Signing the macOS app — already done.
- Signing Linux artifacts — no signing infrastructure exists for Linux desktop binaries; not in scope.
- Signing the standalone `scratchmd` CLI binaries shipped via the CLI release pipeline — separate from desktop, separate plan if needed.
- Migrating to Azure Trusted Signing or any other provider — we already have SSL.com; revisit only if SSL.com becomes uneconomic at our cadence.
