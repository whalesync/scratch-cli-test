# Scratch Desktop

Electron desktop client for Scratch. See [CLAUDE.md](CLAUDE.md) for architecture, conventions, and the auth/auto-update flows.

## Local Builds

There are several ways to build the app locally, each suited to a different purpose. All commands run from `scratch-desktop/`.

### Quick reference

| Command                       | Output                       | Signing                  | Notarized | scratchmd | API URLs              | Channel        | Purpose                                    |
| ----------------------------- | ---------------------------- | ------------------------ | --------- | --------- | --------------------- | -------------- | ------------------------------------------ |
| `yarn dev`                    | (no package, hot reload)     | —                        | —         | —         | from `.env`           | —              | Day-to-day development                     |
| `yarn build`                  | `out/` (bundled JS only)     | —                        | —         | —         | from `.env`           | —              | Verify the bundle compiles                 |
| `yarn build:mac:unsigned`     | `dist/mac-arm64/Scratch.app` | ad-hoc (`-`)             | No        | Not built | from `.env`           | `desktop-test` | Fast packaged build, no certs needed       |
| `yarn build:mac:local`        | `dist/mac-arm64/Scratch.app` | ad-hoc (`-`)             | No        | Built     | from `.env`           | `desktop-test` | Local end-to-end with the bundled CLI      |
| `yarn build:mac:local-signed` | `dist/mac-arm64/Scratch.app` | Developer ID             | Yes       | Not built | from `.env`           | `desktop-test` | Verify signing + notarization locally      |
| `yarn build:mac:prod-local`   | `dist-release/`              | Developer ID             | Yes       | Built     | `*.scratch.md` (prod) | `desktop`      | Mirror the GitLab "Package prod macOS" job |
| `yarn build:mac`              | `dist/mac-arm64/Scratch.app` | Developer ID (env-based) | Yes       | Not built | from `.env`           | `desktop-test` | Raw electron-builder; you supply the env   |
| `yarn build:linux`            | `dist/`                      | —                        | —         | Not built | from `.env`           | `desktop-test` | Linux AppImage / .deb                      |

### `yarn dev` — development

Hot-reloading dev mode for the renderer, main, and preload processes. Devtools open automatically. No packaging.

### `yarn build` — bundle only

Runs `electron-vite build` to produce `out/main`, `out/preload`, and `out/renderer`. Does not package an `.app`. Useful as a sanity check or as a prerequisite for ad-hoc packaging steps.

### `yarn build:mac:unsigned` — quick packaged build

Runs `electron-vite build` then `electron-builder --mac` with `CSC_IDENTITY='-'` (ad-hoc signing) using `electron-builder.unsigned-mac.yml`. The resulting app launches on the build machine but Gatekeeper will refuse it elsewhere. The bundled `scratchmd` binary is **not** rebuilt — whatever is currently in `scratch-git-2/cli-binaries/aarch64-apple-darwin/` is used (or the build will fail if it is missing).

```bash
yarn build:mac:unsigned
```

### `yarn build:mac:local` — full local build (unsigned)

Same as `build:mac:unsigned`, but first compiles `scratchmd` for `aarch64-apple-darwin` and copies it into `scratch-git-2/cli-binaries/aarch64-apple-darwin/`. This is the standard way to get an end-to-end local build that exercises the bundled CLI.

On Apple Silicon hosts targeting `aarch64-apple-darwin` the script uses plain `cargo build` (no cross-compile). For any other host/target combination it falls back to `cargo zigbuild`, matching CI.

**Prerequisites**: Rust toolchain. [`cargo-zigbuild`](https://github.com/rust-cross/cargo-zigbuild) and Zig are only needed when cross-compiling (i.e., not on an Apple Silicon Mac targeting itself).

```bash
yarn build:mac:local
```

Run the resulting app:

```bash
yarn run:mac   # launches dist/mac/Scratch.app with OPEN_DEVTOOLS=1
```

### `yarn build:mac:local-signed` — signed + notarized

Loads signing and notarization credentials from a local env file, then runs `yarn build:mac` (Developer ID signing + Apple notarization). After packaging, the script verifies `codesign --deep --strict` and asserts the `TeamIdentifier` matches `APPLE_TEAM_ID`. Use this to validate that your local credentials produce a notarized build.

**Default env file**: `scratch-desktop/.env.signing-credentials` (override with `ENV_FILE=...`).

The env file must define:

```
CSC_LINK                       # Developer ID Application .p12, base64 or path
CSC_KEY_PASSWORD               # password for the .p12
APPLE_ID                       # Apple ID for notarization
APPLE_APP_SPECIFIC_PASSWORD    # app-specific password for that Apple ID
APPLE_TEAM_ID                  # 10-char Team ID; must match the .p12
```

`scratchmd` is **not** rebuilt — make sure the binary already exists under `scratch-git-2/cli-binaries/aarch64-apple-darwin/` (e.g. by running `yarn build:mac:local` once first).

```bash
yarn build:mac:local-signed
```

### `yarn build:mac:prod-local` — production-equivalent build

Mirrors GitLab's "Package prod macOS" job locally. Uses the same flow (`scripts/package.sh mac`) and emits artifacts under `dist-release/`. Forces production API URLs and the stable update channel:

- `VITE_SCRATCH_API_URL=https://api.scratch.md`
- `VITE_SCRATCH_WEB_URL=https://app.scratch.md`
- `UPDATE_CHANNEL=desktop`

Defaults to building `scratchmd` against `SCRATCH_DEFAULT_URL=https://api.scratch.md`. Pass `BUILD_SCRATCHMD=0` to skip the Rust build if `cli-binaries/aarch64-apple-darwin/scratchmd` is already in place.

**Default env file**: `scratch-desktop/.env.signing-credentials` (override with `ENV_FILE=...`). Same required vars as `build:mac:local-signed`.

```bash
yarn build:mac:prod-local           # SEMVER taken from package.json
yarn build:mac:prod-local -- 1.2.3  # explicit SEMVER
```

Use this to test a release build (signed, notarized, prod URLs) without cutting an actual release.

### `yarn build:mac` — raw electron-builder

The lowest-level signed-build entry point. Runs `electron-vite build` + `electron-builder --mac` with `UPDATE_CHANNEL=${UPDATE_CHANNEL:-desktop-test}`. You are responsible for exporting `CSC_*` and `APPLE_*` env vars yourself; if they are missing the build will fall back to ad-hoc signing and notarization will be skipped. Prefer `build:mac:local-signed` or `build:mac:prod-local` for everyday use.

### `yarn build:linux` — Linux build

`electron-vite build` + `electron-builder --linux`. Produces an AppImage and `.deb` under `dist/`. No CLI cross-compile is performed; supply the matching `scratchmd` binary if you need a working CLI in the package.

## Choosing a build

- **Iterating on UI / IPC**: `yarn dev`.
- **Smoke-testing a packaged app on your machine**: `yarn build:mac:local`.
- **Verifying signing/notarization plumbing**: `yarn build:mac:local-signed`.
- **Reproducing a release artifact**: `yarn build:mac:prod-local`.
- **Testing the auto-updater path**: a packaged build (`build:mac:local` is enough); see [CLAUDE.md](CLAUDE.md#local-testing) for the `dev-app-update.yml` flow.

## Triggering a GitLab Pipeline Build

The desktop release pipeline lives in [.gitlab-ci-release.yml](.gitlab-ci-release.yml). It bootstraps a draft GitHub release, cross-compiles `scratchmd`, runs `electron-builder` for mac/linux/windows, uploads assets, and finalizes the release. Linux and Windows jobs run on shared runners; **the macOS Package + Upload jobs require a local shell-executor runner** because `.dmg` packaging and Developer ID signing have to happen on a real Mac.

### Prerequisites (one-time, per developer)

Register a local macOS shell runner. Follow [docs/ops/local-gitlab-runner.md § macOS Shell Runner](../docs/ops/local-gitlab-runner.md#macos-shell-runner-for-native-dmg-builds). The runner must be tagged with both `local-macos-YOUR_GITLAB_USERNAME` (personal MR jobs) and `team-macos-release` (team-wide desktop release jobs), and have Node 22, Yarn, and Git on its `PATH`.

The mac Package + Upload jobs generate on prod pipelines and on the hourly **Hourly Test Releases** schedule (and as manual ▶︎ jobs on a normal `master` pipeline), and are dispatched to whichever team-tagged runner is online — no per-user opt-in is needed in `gitlab-ci/common.yml`. At least one teammate's mac runner must be online when a release pipeline reaches the `release desktop app` stage — including during the hourly scheduled window — otherwise the mac job will sit pending until one comes up or the job hits its timeout.

### Cutting a release

[Walkthrough Video](https://www.loom.com/share/74b4024c7ab54c18802e8b2c2c3a76ec)

**Prod releases are automatic.** Every pipeline on the `prod` branch — including the scheduled `master → prod` auto-push — runs the `release desktop app` stage on its own and cuts a **patch** prod release (`api.scratch.md`, `desktop` update channel, Homebrew cask updated on finalize). No manual ▶︎ click is needed: `Bootstrap prod desktop release` and everything downstream (`Build CLI for…`, `Package… macOS/Linux/Windows`, `Upload… assets`, `Finalize…`) run automatically.

To cut a **minor** or **major** prod release instead, run a pipeline manually:

1. Go to **CI/CD → Pipelines → Run pipeline** and pick the `prod` branch.
2. Add a `RELEASE_TYPE` variable set to `minor` or `major` (defaults to `patch`).
3. Optionally set **`RELEASE_DESKTOP_ONLY = true`** to skip the normal build/test/deploy stages and run only the desktop release jobs (leave `RELEASE_CLI_ONLY` at `false`).
4. Run the pipeline.

**Test releases run on a schedule, not on every merge.** The hourly **Hourly Test Releases** scheduled pipeline (`PIPELINE_NAME="Hourly Test Releases"`, branch `master`) cuts the **test** variant (`test-api.scratch.md`, `desktop-test` update channel) automatically, and **no-ops in seconds** when nothing under `scratch-desktop/`, `scratch-git-2/`, or `packages/shared-types/` changed since the last test release (set `FORCE_RELEASE=1` on a manual run of the schedule to force a build). To cut an **immediate** test release, open the latest `master` pipeline and click the manual ▶︎ `Bootstrap test desktop release` job — it appears on every master pipeline but no longer runs automatically. Test releases can also be triggered from an MR — see [Triggering a test release from an MR](#triggering-a-test-release-from-an-mr) below.

`Finalize` blocks on the mac upload — if no team-tagged mac runner is online when the pipeline reaches the mac stage, Finalize fails and the release is not published, rather than silently shipping without mac artifacts.

### Triggering a test release from an MR

For MRs that touch the release pipeline itself (any of the files listed in `.changes.release_pipeline`), the test variant jobs appear as manual ▶︎ buttons on the MR pipeline. You don't need `RELEASE_DESKTOP_ONLY` here — the trigger is the file change. Click `Bootstrap test desktop release` to run the full release end-to-end against the `test-api.scratch.md` environment. The mac jobs are dispatched to any online `team-macos-release` runner — same as a manual pipeline run.
