# Release Plan — Rust CLI (`scratchmd` replacement)

> **Goal**: Ship the Rust CLI as `scratchmd` — the same binary name as the Go CLI. Users who run
> `brew upgrade scratchmd` transparently get the Rust version. Old versions remain installable.

---

## Decision: Use the same binary name, same tap, same repo

**Binary name**: `scratchmd` (replaces Go CLI — not `scratchmdv4` as previously planned)

**GitHub repo**: `whalesync/scratch-cli` (same repo) — the Rust CI creates releases there with a
version number higher than the current Go CLI. Homebrew formula points to new Rust artifacts.

**Homebrew tap**: `whalesync/homebrew-scratch-cli` (same tap, same formula `scratchmd`) — the Rust
CI writes a new formula version. `brew upgrade scratchmd` picks it up transparently.

**Revert path**: Users can pin or install a specific old version:
```bash
brew install scratchmd@0.2.X   # go back to specific Go CLI version (if formula was versioned)
# or install directly from GitHub release .tar.gz
```

---

## How releases currently work (Go CLI)

Read these before touching the CI:

- **`scratch-cli/.gitlab-ci-release.yml`** — CI job definitions
- **`scratch-cli/scripts/release_public.sh`** — prod release script
- **`scratch-cli/scripts/release_test.sh`** — test release script
- **`scratch-cli/.goreleaser.yaml`** — GoReleaser config (builds, archives, brew formula, scoop)

**Auto-release pattern** (important):
- Every `prod` merge → `release-cli-patch` fires **automatically** (`when: on_success`)
- Minor and major bumps are **manual** triggers in GitLab CI
- Tags on GitLab use `cli-X.Y.Z` prefix (tracks current version state)
- Tags on GitHub use `vX.Y.Z` (what GoReleaser/Homebrew sees)
- Same `GITHUB_TOKEN` and `CICD_ACCESS_TOKEN` secrets are used

**Version question clarification**: The Go CLI does NOT auto-major. It auto-patches on every prod
commit. Major/minor are manual. The plan should mirror this same pattern.

---

## Phase 1 — Rename the binary (trivial, 2 files)

```toml
# scratch-git-2/Cargo.toml
[[bin]]
name = "scratchmd"          # was "scratchmd2"
path = "src/cli/main.rs"

# NOTE: do NOT change default-run — it points to the service binary (scratch-git-2)
# and is used by `cargo run` in development. Leave it as-is.
```

```rust
// scratch-git-2/src/cli/main.rs
#[command(
    name = "scratchmd",     // was "scratchmd2"
    version,
    about = "Scratch content management CLI"
)]
```

---

## Phase 2 — Cross-compilation strategy

`cargo-zigbuild` handles all targets from a single runner. Install zig from the official release
(not apt — Debian's package is 0.10.x, cargo-zigbuild requires 0.11+):

```bash
ZIG_VERSION="0.13.0"
curl -L "https://ziglang.org/download/${ZIG_VERSION}/zig-linux-x86_64-${ZIG_VERSION}.tar.xz" | tar -xJ
export PATH="$PWD/zig-linux-x86_64-${ZIG_VERSION}:$PATH"
cargo install cargo-zigbuild
rustup target add aarch64-apple-darwin x86_64-apple-darwin \
                  x86_64-unknown-linux-gnu aarch64-unknown-linux-gnu \
                  x86_64-pc-windows-gnu

cargo zigbuild --release --target aarch64-apple-darwin
cargo zigbuild --release --target x86_64-apple-darwin
cargo zigbuild --release --target x86_64-unknown-linux-gnu
cargo zigbuild --release --target aarch64-unknown-linux-gnu
cargo zigbuild --release --target x86_64-pc-windows-gnu
```

`rusqlite` with `features = ["bundled"]` compiles SQLite from C source — zig's embedded C compiler
handles this across all targets without Docker.

---

## Phase 3 — Release scripts

Mirror `scratch-cli/scripts/release_public.sh` exactly. Key differences:

| | Go CLI | Rust CLI |
|---|---|---|
| GitLab tag prefix | `cli-X.Y.Z` | **`cli-X.Y.Z` (same)** |
| Build tool | `goreleaser release` | `cargo zigbuild` + manual packaging |
| Archive naming | GoReleaser convention | Match GoReleaser: `scratchmd_darwin_arm64.tar.gz` |
| Formula location | `brews:` in `.goreleaser.yaml` | Manual `sed` update to tap formula |

The Rust script reads the same `cli-*` tags the Go script writes. No new tag prefix. The version
sequence is continuous — Go CLI left off at `cli-0.2.X`, Rust picks up at `cli-0.2.X+1`.

### `scratch-git-2/scripts/release_public.sh` (outline)

```bash
#!/bin/bash
set -e
cd "$(dirname "$0")/.."

RELEASE_TYPE=$1      # patch | minor | major
GITHUB_REPO="whalesync/scratch-cli"

# 1. Read latest cli-X.Y.Z tag (same sequence as Go CLI)
LATEST_TAG=$(git tag -l "cli-*" --sort=-v:refname | head -n1)

# 2. Bump version per RELEASE_TYPE (identical logic to Go script)

# 3. Build all targets with cargo-zigbuild
for TARGET in aarch64-apple-darwin x86_64-apple-darwin \
              x86_64-unknown-linux-gnu aarch64-unknown-linux-gnu \
              x86_64-pc-windows-gnu; do
  cargo zigbuild --release --target $TARGET
done

# 4. Package artifacts
#    macOS + Linux → .tar.gz (GoReleaser-compatible naming)
#      scratchmd_darwin_arm64.tar.gz, scratchmd_darwin_amd64.tar.gz
#      scratchmd_linux_amd64.tar.gz, scratchmd_linux_arm64.tar.gz
#    Windows → .zip (Scoop convention)
#      scratchmd_windows_amd64.zip  → contains scratchmd.exe

# 5. Compute SHA256 for each archive

# 6. Create GitHub release + upload artifacts
git tag "$NEW_VERSION"  # local vX.Y.Z tag for GitHub
curl POST to GitHub API to create tag on remote HEAD
gh release create "$NEW_VERSION" --repo $GITHUB_REPO ...

# 7. Update Homebrew formula in whalesync/homebrew-scratch-cli
#    sed-replace version + sha256 per platform block
#    commit + push to tap repo

# 7b. Update Scoop manifest in whalesync/scratch-cli-bucket
#    sed-replace version + sha256 for windows amd64
#    commit + push to bucket repo

# 8. Tag GitLab with cli-X.Y.Z to save state (same as Go script)
git tag "cli-$MAJOR.$MINOR.$PATCH"
git push "https://oauth2:${CICD_ACCESS_TOKEN}@${CI_SERVER_HOST}/${CI_PROJECT_PATH}.git" "$CLI_TAG"
```

### Stop Go releases entirely

Remove all Go release CI jobs in the same commit — not just auto-patch, all of them. Go code and
scripts stay in the repo as dead code but nothing triggers them anymore.

**Changes to Go CLI files:**

1. `scratch-cli/.gitlab-ci-release.yml`: delete the entire file (or remove all job definitions).
2. `.gitlab-ci.yml`: remove the `include: scratch-cli/.gitlab-ci-release.yml` line.

The goreleaser config and release scripts can stay — no need to delete them.

**Updated file list**:

---

## Phase 4 — GitLab CI

### `scratch-git-2/.gitlab-ci-release.yml`

```yaml
.release_rust_prod_job:
  stage: deploy
  image: rust:latest
  variables:
    GIT_DEPTH: 0
  dependencies: []
  before_script:
    - apt-get update -qq && apt-get install -y zig
    - cargo install cargo-zigbuild
    - rustup target add aarch64-apple-darwin x86_64-apple-darwin
                        x86_64-unknown-linux-gnu aarch64-unknown-linux-gnu
  script:
    - chmod +x scratch-git-2/scripts/release_public.sh
    - scratch-git-2/scripts/release_public.sh $RELEASE_TYPE
  rules:
    - if: '$CI_COMMIT_BRANCH == "prod"'
      when: manual
      allow_failure: true

release-rust-cli-patch:
  extends: .release_rust_prod_job
  variables:
    RELEASE_TYPE: "patch"
  rules:
    - if: '$CI_COMMIT_BRANCH == "prod"'
      when: on_success    # auto on every prod commit (same as Go CLI)

release-rust-cli-minor:
  extends: .release_rust_prod_job
  variables:
    RELEASE_TYPE: "minor"

release-rust-cli-major:
  extends: .release_rust_prod_job
  variables:
    RELEASE_TYPE: "major"

# TEST (master branch)
...same pattern as Go CLI...
```

### `.gitlab-ci.yml` addition

```yaml
include:
  - "scratch-cli/.gitlab-ci-release.yml"
  - "scratch-git-2/.gitlab-ci-release.yml"   # add this line
```

---

## Phase 5 — Homebrew formula

The current formula in `whalesync/homebrew-scratch-cli` looks like:
```ruby
class Scratchmd < Formula
  ...
  on_macos do
    on_arm do
      url "https://github.com/whalesync/scratch-cli/releases/download/vX.Y.Z/scratchmd_darwin_arm64.tar.gz"
      sha256 "..."
    end
    on_intel do
      url ".../scratchmd_darwin_amd64.tar.gz"
      sha256 "..."
    end
  end

  def install
    bin.install "scratchmd"
  end
end
```

The Rust binary is named `scratchmd` in the archive (matching Cargo.toml `[[bin]] name = "scratchmd"`).
The formula doesn't need to change structurally — only the version and sha256 per release.

---

## Version strategy for the initial Rust release

No special logic needed. The Rust script reads the same `cli-*` tags as the Go script:

1. Commit lands on `prod` → **auto-patch** fires → e.g. `cli-0.2.4`, Homebrew updated to Rust binary
2. Immediately **manually trigger minor** → `cli-0.3.0`, Homebrew updated
3. **Delete `v0.2.4`** from GitHub (cleanup — nobody had time to upgrade)
4. From now on, **auto-patch** continues: `0.3.1`, `0.3.2`, ...

The Go CLI release jobs remain in CI but stop touching the Homebrew formula (see Phase 3 —
remove `brews:` from `.goreleaser.yaml`). If Go CLI auto-patch fires on the same prod commit, it
creates a GitHub release artifact but doesn't update Homebrew. Rust CI owns the formula.

---

## Implementation steps

### Step 1 — everything except CI pipeline files

| File | Change |
|------|--------|
| `scratch-git-2/Cargo.toml` | Rename `[[bin]] name` to `scratchmd` |
| `scratch-git-2/src/cli/main.rs` | Update `name =` in `#[command(...)]` |
| `scratch-git-2/scripts/release_public.sh` | New file (~140 lines, mirrors Go script) |
| `scratch-git-2/scripts/release_test.sh` | New file (~160 lines, mirrors Go script) |

Then test locally (see "Testing locally" section below) — run all 5 build targets and dry-run
the release script to confirm artifacts are correct before touching CI.

### Step 2 — CI pipeline files

| File | Change |
|------|--------|
| `scratch-git-2/.gitlab-ci-release.yml` | New file (~50 lines, mirrors Go CI) |
| `scratch-cli/.gitlab-ci-release.yml` | Delete all job definitions (Go releases stopped) |
| `.gitlab-ci.yml` | Replace Go include with Rust include |

Push and merge to `master`. Manually trigger `release-rust-cli-test-patch` to validate
end-to-end before the first prod merge.

---

## Full file list

For reference:

| File | Change |
|------|--------|
| `scratch-git-2/Cargo.toml` | Rename `[[bin]] name` to `scratchmd` |
| `scratch-git-2/src/cli/main.rs` | Update `name =` in `#[command(...)]` |
| `scratch-git-2/scripts/release_public.sh` | New file (~140 lines, mirrors Go script) |
| `scratch-git-2/scripts/release_test.sh` | New file (~160 lines, mirrors Go script) |
| `scratch-git-2/.gitlab-ci-release.yml` | New file (~50 lines, mirrors Go CI) |
| `scratch-cli/.gitlab-ci-release.yml` | Delete all job definitions (Go releases stopped) |
| `.gitlab-ci.yml` | Replace Go include with Rust include |

**Total**: ~7 files, ~400 lines of new content.

**What is NOT in the commit (external setup):**
- Verify `GITHUB_TOKEN` has push access to `whalesync/scratch-cli` releases AND `whalesync/homebrew-scratch-cli` tap (it should — same token the Go CLI uses)
- Verify the Homebrew tap formula structure is compatible (just needs a `scratchmd.rb` file with url/sha256)

**Realistic order:**
1. Commit all 7 files
2. Test locally (see below)
3. Merge to `master` → manually trigger `release-rust-cli-test-minor` → validate end-to-end
4. Merge to `prod` → auto-patch fires, users get Rust binary on next `brew upgrade`

---

## Testing locally before pushing

Release job failures have `allow_failure: true` so they won't block MRs — but a broken release
pipeline is still annoying and will silently stop users from getting updates. Test this before
merging to master.

**Step 1 — verify all targets build:**
Install `cargo-zigbuild` and zig locally (macOS: `brew install zig`), then:
```bash
cd scratch-git-2
rustup target add aarch64-apple-darwin x86_64-apple-darwin \
                  x86_64-unknown-linux-gnu aarch64-unknown-linux-gnu \
                  x86_64-pc-windows-gnu
cargo zigbuild --release --target aarch64-apple-darwin
cargo zigbuild --release --target x86_64-apple-darwin
cargo zigbuild --release --target x86_64-unknown-linux-gnu
cargo zigbuild --release --target aarch64-unknown-linux-gnu
cargo zigbuild --release --target x86_64-pc-windows-gnu
```
If all five succeed, the CI build step will work. This is the highest-risk part.

**Step 2 — dry-run the release script:**
Add a `DRY_RUN=1` guard at the top of `release_public.sh` that skips the GitHub API calls, git
tag pushes, and Homebrew/Scoop commits but still runs the build and packaging steps. Run it
locally to verify archives are created correctly:
```bash
DRY_RUN=1 ./scratch-git-2/scripts/release_public.sh patch
# should produce: scratchmd_darwin_arm64.tar.gz, scratchmd_darwin_amd64.tar.gz,
#                 scratchmd_linux_amd64.tar.gz, scratchmd_linux_arm64.tar.gz,
#                 scratchmd_windows_amd64.zip
# and print the GitHub + Homebrew + Scoop commands it would run
```

**Step 3 — validate the CI YAML:**
```bash
# Lint before pushing (requires gitlab-runner installed locally, or use the GitLab API)
gitlab-runner exec shell release-rust-cli-test-patch  # dry-run the job locally
```
Or just paste the YAML into the GitLab CI linter (`gitlab.com/<project>/-/ci/lint`) before merging.

**Step 4 — test release on master:**
Once the branch is on `master`, manually trigger `release-rust-cli-test-patch` in the GitLab
pipeline. This uses `release_test.sh` which pushes to a test GitHub release and test Homebrew tap.
Verify: GitHub release exists with 5 artifacts, Homebrew test tap formula updated, `brew install`
from test tap works.

---

## What's different vs original plan

| Original plan | Updated plan |
|---|---|
| New binary name `scratchmdv4` | Same name `scratchmd` (transparent upgrade) |
| New GitHub repo `scratch-cli-v4` | Same repo `whalesync/scratch-cli` |
| New tap `homebrew-scratch-cli-v4` | Same tap `homebrew-scratch-cli` |
| Use `cargo-dist` | Use `cargo-zigbuild` (no Docker, works on shared runners) |
| Separate from Go CLI | Go CLI stops owning Homebrew formula |
| Manual migration for users | Transparent via `brew upgrade` |
