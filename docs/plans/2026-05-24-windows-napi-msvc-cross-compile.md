# Windows napi cross-compile (msvc via cargo-xwin)

**Date**: 2026-05-24
**Status**: Plan — not yet started.
**Linear**: TBD (DEV team)
**Author**: Curtis Fonger
**Related**: [`resolved/2026-05-17-simplify-local-workspace-architecture.md`](resolved/2026-05-17-simplify-local-workspace-architecture.md) slice H.4 deferred the Windows napi `.node`; this plan closes that gap.

**Scope**: Cross-compile `scratchmd-native` to `x86_64-pc-windows-msvc` from the existing Linux CI runner using `cargo-xwin`, ship the resulting `.node` inside the packaged Windows `.exe`, and verify the desktop app's cell-edit and grid-view paths work on Windows again. Linux-only build pipeline — no Windows GitLab runner.

## Problem

Windows desktop installs are broken at the user surface since slice F.5 + H.3 shipped (`mr27`, 2026-05-21). Three classes of IPC handler throw at first call:

| Handler family                                                        | Where                                                          | Triggered by                                                                                   |
| --------------------------------------------------------------------- | -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `acceptCellChange` / `acceptCellInputText` / `undoApprovedCellChange` | `scratch-desktop/src/main/local-files.ts`                      | User edits a grid cell or clicks the undo-approval action.                                     |
| `readFolderBlobs` / `readFolderBlobsFiltered`                         | `scratch-desktop/src/main/local-files.ts` (diff readers)       | User opens a folder's grid view; populates the published/approved sides of the three-way diff. |
| `listFolderFilenames`                                                 | `scratch-desktop/src/main/local-files.ts` (`findRecordOffset`) | User scrolls to a specific record.                                                             |

All six go through `scratch-desktop/src/main/native/scratchmd-native.ts:71-82`, which `throw`s when the `.node` is missing. afterPack's `nativeFilenameFor` (`scratch-desktop/scripts/afterPack.cjs:35-39`) returns `null` for `win32`, the Windows package job logs `napi cdylib not supported on win32-x64; cell-edit IPC will fail at runtime`, and the build still ships. The CLI shells (`scratchmd.exe`) does ship, but none of the broken IPC handlers fall back to shelling out — they require the native binding.

Pre-H.3, these handlers wrote to `refs/heads/dirty` from pure TypeScript and worked on Windows. The H.3 migration (2026-05-20) collapsed them onto napi without a Windows code path, and slice H.4's spec explicitly deferred Windows with the framing "same surface as before slice H." That framing was wrong by the time F.5 landed: F.5's grid readers (`readFolderBlobs`, `listFolderFilenames`) were new code that ALSO routes through the napi binding, so even the read path now requires the addon. There is no "fall back to old behavior" for Windows users — every interactive surface is dead.

## Why cross-compile from Linux (not a Windows runner)

`cargo-xwin` cross-compiles to `x86_64-pc-windows-msvc` from Linux by downloading Microsoft's Windows SDK headers and CRT import libraries from MS's official package feed (EULA-compliant). It uses LLD as the linker and clang-cl as the C compiler. This is the same approach the napi-rs flagship projects use — `napi-rs/setup-cross-toolchain-action@v0.7` wraps `cargo-xwin` internally; sentry-cli, oxc, and swc all ship Windows `.node` builds this way. Off-paved-road would be `windows-gnu` (zigbuild + MinGW), which works in principle but lacks community-debugged napi templates.

We keep `cargo-zigbuild` for the CLI (it produces a working `scratchmd.exe` on `x86_64-pc-windows-gnu` today). The napi crate adds a second, msvc-targeted build pass alongside it. Two toolchains in the same job — zig and xwin don't conflict (different sysroots, different env vars).

A Windows GitLab runner would let us run automated post-build smokes — `node -e "require('./scratchmd-native.win32-x64-msvc.node').acceptField(...)"` against a real Node binary on Windows. GitLab SaaS Windows runners (`saas-windows-medium-amd64`) cost per-minute and would add ~5min boot to every release. Out of scope for this plan; we accept manual verification on a Windows machine for first install, with the napi smoke tests in `napi/__tests__/*.mjs` (running on Linux against the Linux `.so`) as the regression backstop.

## Design

### Filename convention

Three places currently disagree:

| Where                                                               | Filename pattern (current)                              |
| ------------------------------------------------------------------- | ------------------------------------------------------- |
| `scratch-desktop/src/main/native/scratchmd-native.ts:29`            | `scratchmd-native.win32-x64.node` (abi suffix stripped) |
| `scratch-desktop/scripts/afterPack.cjs:35-39`                       | returns `null` for win32 — no name produced             |
| `docs/plans/resolved/2026-05-20-slice-h-spec.md:463` (planning doc) | `scratchmd-native.win32-x64-msvc.node`                  |

Align all three on **`scratchmd-native.win32-x64-msvc.node`** — matches napi-rs's own resolver convention and lets us add `-gnu` later if we ever need both ABIs side by side.

### CI changes (`scratch-desktop/.gitlab-ci-release.yml`)

Add to `.build_cli_for_desktop`'s `before_script` (after the existing `git restore-mtime`):

```bash
- cargo install --locked cargo-xwin
- rustup target add x86_64-pc-windows-msvc
```

`cargo install` is cached via `CARGO_HOME` (already set on the job), so warm runs are ~instant; cold install is ~30s. `xwin` itself downloads SDK artifacts on first invocation into `~/.cache/xwin/` — cache that under the existing `cargo_cross` cache key or under a dedicated `xwin-sdk` cache (~500MB once unpacked).

Add to the job's `script`, after the existing napi linux + mac zigbuild lines:

```bash
- cargo xwin build --release -p scratchmd-native --target x86_64-pc-windows-msvc
- cp target/x86_64-pc-windows-msvc/release/scratchmd_native.dll \
     cli-binaries/x86_64-pc-windows-msvc/scratchmd-native.win32-x64-msvc.node
```

The `mkdir -p` line at job start (`workspaces.yml:150`) gains `cli-binaries/x86_64-pc-windows-msvc`. Output `.dll` is renamed in-place to match the loader's expected filename, dropped into the same `cli-binaries/<triple>/` tree the CLI binaries use.

### afterPack (`scratch-desktop/scripts/afterPack.cjs`)

Two changes:

1. **`TARGET_MAP`** gains a second key for Windows msvc:

   ```js
   'win32-x64': 'x86_64-pc-windows-msvc',  // was x86_64-pc-windows-gnu
   ```

   Wait — the CLI binary still ships as `x86_64-pc-windows-gnu`. Keep two maps: `CLI_TARGET_MAP` (gnu) and `NAPI_TARGET_MAP` (msvc), OR look up the CLI binary in `x86_64-pc-windows-gnu/` and the napi `.node` in `x86_64-pc-windows-msvc/`. Pick the second — less code change, mirrors the actual reality that the two binaries have different toolchains.

2. **`nativeFilenameFor`** returns the msvc filename on win32:
   ```js
   if (platform === "win32" && arch === "x64")
     return "scratchmd-native.win32-x64-msvc.node";
   ```
   And remove the "skip with warning" early-return — Windows now lands in the same loud-failure-on-missing branch as Mac and Linux.

### Loader (`scratch-desktop/src/main/native/scratchmd-native.ts`)

`nativeBinaryFilename()` at line 26-31 needs the abi suffix on Windows:

```ts
function nativeBinaryFilename(): string {
  const platform = process.platform;
  const arch = process.arch;
  const abi =
    platform === "linux" ? "-gnu" : platform === "win32" ? "-msvc" : "";
  return `scratchmd-native.${platform}-${arch}${abi}.node`;
}
```

No other loader changes — `requireNative()` already handles the platform-correct path; the missing-binary error message is platform-agnostic.

### Local Windows build script (optional but recommended)

`scripts/build_mac_local.sh` extends the local dev loop for Mac. There's no Windows equivalent because no one builds Windows locally today — CI is the only path. Skipping for v1; can add `scripts/build_windows_local.sh` later if a dev gets a Windows machine for the verification loop. Cost is ~1h script work, zero blockers if deferred.

### Dependencies that need to cross-compile clean to msvc

The napi crate path-deps `scratch-git-2`, so every transitive must build on `x86_64-pc-windows-msvc`. We already cross-compile the CLI to `x86_64-pc-windows-gnu` (different toolchain), so most C-dep weirdness has surfaced once before. Specific watch-outs:

- **`rusqlite = { features = ["bundled"] }`** — bundled SQLite ships its own `sqlite3.c`. Builds clean on msvc; well-tested combination.
- **`rustpython-vm` (whalesync fork)** — the fork patches a `cfg(target_env="msvc")` vs `cfg(windows)` bug. Ironically that patch was written for the gnu build; the upstream issue should be a no-op on msvc (the original code path was the one that worked). Confirm the patched code still compiles unchanged on msvc; if not, the fork needs a second commit.
- **`reqwest = { features = ["rustls-tls"], default-features = false }`** — rustls-only avoids the schannel/openssl detour on Windows. Already clean across platforms.
- **`gix`** — pure Rust, works on msvc.

Risk surface is small: one fork (rustpython-vm) is the only realistic blocker. If that builds clean, the rest is mechanical.

## Verification plan

1. **CI smoke (Linux runner):** existing `node --test napi/__tests__/*.mjs` runs against the Linux `.so` — already part of `prebuild`. Catches regressions in the Rust API, not Windows-specific link issues.
2. **CI build success:** `cargo xwin build` exiting 0 + the rename copy succeeding + afterPack copying the file into the packaged `.exe` and `electron-builder` happy is the first signal. ~80% chance of "it just works" after the toolchain is wired.
3. **Manual Windows install:** install the packaged `.exe` on a Windows 11 VM (Parallels / UTM / a borrowed laptop). Log in, open `wkb_3qH9SlxsNq`, edit one cell on a HubSpot Companies record. Verify:
   - No error dialog.
   - `<workspace>/.scratch/connections/HubSpot/accepted-patches.json` grows by one entry.
   - The grid view's diff badges populate (proves `readFolderBlobs` works).
   - Scroll-to-record works (proves `listFolderFilenames` works).
   - `git -C <workspace>/.repos/<id>.git log refs/heads/dirty -1` shows no advance (proves the desktop didn't fall back to the deleted direct-to-dirty path — though slice F.5 deleted that code anyway, it's a good correctness check).
4. **Customer install dogfood:** once verified internally, push the build to the `desktop-test` auto-update channel and ask the two known external dormant Windows users (if any — TBD; ask CS) to install + try a cell edit.

Failure modes to recognize:

- `Module did not self-register` at first `requireNative` call → delay-load hook missing. Fix: add `#[link(name = "Delayimp")]` or similar — napi-rs's `napi-build` should handle this on msvc out of the box; if it doesn't, switch to the `napi-rs/setup-cross-toolchain-action` image.
- `not a valid Win32 application` → architecture or PE format mismatch. Fix: verify the `.dll` is `PE32+` for x64 via `file scratchmd_native.dll`.
- Silent crash, no error in DevTools → the addon loaded but a transitive dep panicked. Fix: run the .exe from `cmd.exe` to capture stderr; or add `OPEN_DEVTOOLS=1` env (`scratch-desktop/CLAUDE.md`'s devtools section) and check the main-process console.

## Sequencing

Single MR is realistic. Sub-slices only matter if the build doesn't go green on first try.

| Slice | Scope                                                                                                                                                                                  | Estimate                     |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| W.1   | Wire `cargo-xwin` install + `cargo xwin build` line + rename copy in `.build_cli_for_desktop`. Update afterPack + loader filename convention. Update `electron-builder.yml` if needed. | 2-3h to green CI             |
| W.2   | First Windows VM install + cell-edit verification.                                                                                                                                     | 30min if W.1 works           |
| W.3   | (If needed) Debug delay-load or transitive-dep issues.                                                                                                                                 | 0–2d depending on what trips |
| W.4   | Update slice H.4 status block in the main plan; close the Windows row in any open follow-up tables.                                                                                    | 15min                        |

W.3 is the uncertainty bucket. The honest estimate is W.1 + W.2 + W.4 = ~half a day if it goes well, ~2 days if the rustpython-vm fork needs a second patch or the delay-load hook fights us.

## Out of scope

- **Windows GitLab runner.** Would enable automated post-build smokes but costs $$ and adds release latency. Defer until manual verification proves recurring pain.
- **`scratchmd-native.win32-x64-gnu.node`** (the MinGW variant). msvc covers 99%+ of Windows users; shipping both adds CI time and maintenance for negligible reach.
- **Mac x64 (Intel).** Electron-builder targets only `arm64` for Mac (`electron-builder.yml:78-84`). If we ever re-add Intel Macs, slice H.4's `darwin-x64` placeholder in the loader needs the same treatment.
- **`scripts/build_windows_local.sh`** equivalent to the Mac local scripts. CI is the only Windows producer; no immediate need.

## Risks

| Risk                                                                   | Likelihood | Mitigation                                                                                                                                                                                                                     |
| ---------------------------------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `cargo xwin build` fails on a transitive (rustpython fork most likely) | Medium     | The CLI's `x86_64-pc-windows-gnu` build proves the deps compile _somewhere_ on Windows; msvc is a different toolchain but the C-dep surface is identical. Worst case: extra patch commit on `whalesync/rustpython-vm-patched`. |
| Delay-load hook absent → "Module did not self-register" at runtime     | Low-Medium | napi-build 2.x handles this on msvc; verify by running `dumpbin /imports` or `objdump -p` on the `.dll` and confirming `node.exe`/`electron.exe` symbols are delay-loaded.                                                     |
| Windows 7/8 customers (pre-UCRT) can't load the addon                  | Low        | Drop support — Electron 28+ already requires Win10+. Document in release notes.                                                                                                                                                |
| `xwin` SDK download flakiness in CI                                    | Low        | Cache `~/.cache/xwin/` under the existing `cargo_cross` cache key; one-time slow first run, fast thereafter. MS's package feed is reliable.                                                                                    |
| No Windows machine available for verification                          | Medium     | Borrow one from sales/ops, or spin up a Windows 11 VM via UTM/Parallels. Half a day of one-time setup.                                                                                                                         |

## Decision log

1. **msvc over gnu.** Paved-road for napi addons; one community-debugged template (napi-rs's own GHA) vs. ad-hoc bushwhack. Worth ~30 min of CI image extension to stay on the paved road.
2. **cargo-xwin over a Windows runner.** Cross-compile from the same Linux image we already trust for CLI builds. A Windows runner would only help with automated post-build smokes, and we're choosing to live without those for v1.
3. **`-msvc` filename suffix everywhere.** Lets us add `-gnu` side-by-side later without a second migration. Matches napi-rs convention.
4. **Two-map afterPack.** The CLI ships as `windows-gnu` (works today, no reason to disrupt), the napi addon ships as `windows-msvc` (paved road for cdylibs). Mixing toolchains in a single bundle is unusual but each binary is self-contained; they don't link against each other.
5. **No local Windows build script.** CI is the only producer today; pay the script-writing cost only if a dev gets a Windows machine.
6. **First install is the verification.** No CI Windows runner means the trust signal is a human clicking the packaged `.exe`. Accept this for v1; revisit if breakage recurs.

## Done when

- `cargo xwin build --release -p scratchmd-native --target x86_64-pc-windows-msvc` exits 0 in CI.
- Packaged Windows `.exe` contains `Resources/bin/scratchmd-native.win32-x64-msvc.node`.
- One human edits a cell on a Windows install, sees `accepted-patches.json` update, and confirms no errors.
- Slice H.4's status block in the main plan is updated to mark Windows shipped.
