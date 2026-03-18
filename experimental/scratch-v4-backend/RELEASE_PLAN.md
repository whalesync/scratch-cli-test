# Release Plan — Rust CLI (`scratchmdv4`)

The Go CLI uses GoReleaser + Homebrew. GoReleaser doesn't support Rust,
but `cargo-dist` is the direct equivalent — it handles cross-compilation,
GitHub releases, and Homebrew formula generation in the same way.

---

## Key decisions before starting

### 1. Binary name
Two options:
- **`scratchmdv4`** (current) — parallel install alongside `scratchmd`, good for the transition period
- **`scratchmd`** (replacement) — clean, but requires Go CLI users to cut over

**Recommendation**: ship as `scratchmdv4` for now. Rename to `scratchmd` when the Go CLI is deprecated.

### 2. GitHub repo
The Go CLI releases to `github.com/whalesync/scratch-cli`. Options:
- New repo `github.com/whalesync/scratch-cli-v4` — cleanest separation
- Same repo, different binary/tap — complicated

**Recommendation**: new GitHub repo `whalesync/scratch-cli-v4` during transition.

### 3. Homebrew tap
- New tap `whalesync/homebrew-scratch-cli-v4` (mirroring the test tap pattern from the Go CLI)
- Or add a formula to the existing `whalesync/homebrew-scratch-cli` tap

**Recommendation**: new tap `whalesync/homebrew-scratch-cli-v4` for now.
Same pattern as Go CLI: separate test and prod taps.

---

## Phase 1 — Repo and Cargo.toml setup

Move the CLI out of `experimental/` into a proper top-level directory
(or its own GitHub mirror repo). The current `Cargo.toml` needs:

```toml
[package]
name = "scratchmdv4"
version = "0.1.0"
description = "Scratch engine — git backend and CLI"
homepage = "https://github.com/whalesync/scratch-cli-v4"
repository = "https://github.com/whalesync/scratch-cli-v4"
license = "Proprietary"
edition = "2021"

[[bin]]
name = "scratchmdv4"
path = "src/main.rs"
```

The `serve` subcommand is part of the same binary (the CLI is also the git
microservice). This is fine — cargo-dist ships the whole binary, including
the `serve` command.

---

## Phase 2 — Add `cargo-dist`

`cargo-dist` handles cross-compilation, artifact bundling, GitHub release
creation, and Homebrew formula generation.

```bash
# Install
cargo install cargo-dist

# Initialize (run from scratch-git/ directory)
cargo dist init
```

This adds a `[workspace.metadata.dist]` section to `Cargo.toml`:

```toml
[workspace.metadata.dist]
cargo-dist-version = "0.x.y"
ci = ["github"]                         # or "github" for the public mirror
installers = ["homebrew", "shell"]
tap = "whalesync/homebrew-scratch-cli-v4"
targets = [
    "x86_64-apple-darwin",
    "aarch64-apple-darwin",
    "x86_64-unknown-linux-gnu",
    "aarch64-unknown-linux-gnu",
]
publish-jobs = ["homebrew"]
```

cargo-dist generates a `.github/workflows/release.yml` — but since we're
on GitLab, we'll adapt it (see Phase 4).

---

## Phase 3 — Cross-compilation

The Rust binary links against `rusqlite` with `bundled` feature (SQLite
compiled in), which requires a C compiler during cross-compilation. Use
`cross` to handle this cleanly:

```bash
cargo install cross
```

Targets needed and their Docker images used by `cross`:
| Target | Notes |
|--------|-------|
| `x86_64-apple-darwin` | Build on macOS runner directly (no cross needed) |
| `aarch64-apple-darwin` | Build on macOS runner with `--target aarch64-apple-darwin` |
| `x86_64-unknown-linux-gnu` | `cross build --release --target x86_64-unknown-linux-gnu` |
| `aarch64-unknown-linux-gnu` | `cross build --release --target aarch64-unknown-linux-gnu` |

The `gix` dependency (git operations) is pure Rust. The only C dependency
is `rusqlite --features bundled`, which `cross` handles via its Docker images.

---

## Phase 4 — Release scripts

Mirror the Go CLI's `release_public.sh` / `release_test.sh` pattern.

### `scripts/release_public.sh`
```bash
#!/bin/bash
set -e
cd "$(dirname "$0")/.."

RELEASE_TYPE=$1   # patch | minor | major
GITHUB_REPO="whalesync/scratch-cli-v4"

# 1. Compute next version from latest cli-v4-X.Y.Z tag on GitLab
LATEST_TAG=$(git tag -l "cli-v4-*" --sort=-v:refname | head -n1)
# ... same version bump logic as Go CLI ...

# 2. Build for all targets
for TARGET in x86_64-apple-darwin aarch64-apple-darwin; do
  cargo build --release --target $TARGET
done
for TARGET in x86_64-unknown-linux-gnu aarch64-unknown-linux-gnu; do
  cross build --release --target $TARGET
done

# 3. Package as .tar.gz per target (same naming as GoReleaser archives)
#    scratchmdv4_darwin_amd64.tar.gz, scratchmdv4_darwin_arm64.tar.gz, etc.

# 4. Create GitHub release + upload artifacts
gh release create $NEW_VERSION --repo $GITHUB_REPO ...

# 5. Update Homebrew formula in homebrew-scratch-cli-v4 tap
#    cargo-dist can do this automatically; or use the gh API + sed

# 6. Tag GitLab with cli-v4-X.Y.Z to persist state
git tag "cli-v4-$MAJOR.$MINOR.$PATCH"
git push ...
```

For the test release: same shape, different tag suffix (`cli-v4-X.Y.Z-test`),
different tap (`homebrew-scratch-cli-v4-test`), `prerelease: true`.

**Recommendation**: use `cargo-dist` to generate the artifacts and formula,
and wrap it in the same shell script + GitLab CI pattern the Go CLI already uses.
This keeps the release process consistent across both CLIs.

---

## Phase 5 — Homebrew formula

`cargo-dist` auto-generates a formula for the `homebrew-scratch-cli-v4` tap
that looks like this:

```ruby
class Scratchmdv4 < Formula
  desc "Scratch engine — git backend and CLI"
  homepage "https://github.com/whalesync/scratch-cli-v4"
  version "0.1.0"

  on_macos do
    on_arm do
      url "https://github.com/whalesync/scratch-cli-v4/releases/download/v0.1.0/scratchmdv4-aarch64-apple-darwin.tar.gz"
      sha256 "..."
    end
    on_intel do
      url "https://github.com/whalesync/scratch-cli-v4/releases/download/v0.1.0/scratchmdv4-x86_64-apple-darwin.tar.gz"
      sha256 "..."
    end
  end

  def install
    bin.install "scratchmdv4"
  end

  test do
    system "#{bin}/scratchmdv4", "--version"
  end
end
```

Install command for users:
```bash
brew tap whalesync/scratch-cli-v4
brew install scratchmdv4
```

---

## Phase 6 — GitLab CI

Add a new `.gitlab-ci-release-v4.yml` mirroring the Go CLI pattern:

```yaml
.release_v4_prod_job:
  stage: deploy
  image: rust:latest
  before_script:
    - cargo install cargo-dist cross
  script:
    - chmod +x scratch-git/scripts/release_public.sh
    - scratch-git/scripts/release_public.sh $RELEASE_TYPE
  rules:
    - if: '$CI_COMMIT_BRANCH == "prod"'
      when: manual

release-cli-v4-patch:
  extends: .release_v4_prod_job
  variables:
    RELEASE_TYPE: "patch"
  rules:
    - if: '$CI_COMMIT_BRANCH == "prod"'
      when: on_success   # auto-patch on every prod merge

release-cli-v4-minor:
  extends: .release_v4_prod_job
  variables:
    RELEASE_TYPE: "minor"

release-cli-v4-major:
  extends: .release_v4_prod_job
  variables:
    RELEASE_TYPE: "major"
```

Include it in `.gitlab-ci.yml`:
```yaml
include:
  - "scratch-git/.gitlab-ci-release-v4.yml"
```

Same secrets needed as Go CLI:
- `GITHUB_TOKEN` — for GitHub releases and tap formula commits
- `CICD_ACCESS_TOKEN` — for pushing version tags back to GitLab

---

## What's different vs the Go CLI

| | Go CLI | Rust CLI |
|---|---|---|
| Release tool | GoReleaser | cargo-dist + cargo-release |
| Cross-compile | GoReleaser handles it natively | `cross` (Docker-based) |
| Archive format | `.tar.gz` (GoReleaser) | `.tar.gz` (cargo-dist) |
| Windows | Yes (Scoop bucket) | Not needed yet |
| Binary name | `scratchmd` | `scratchmdv4` (for now) |
| Serves HTTP | No | Yes (`scratchmdv4 serve`) |
| CI image | `goreleaser/goreleaser` | `rust:latest` + cargo-dist |

The `serve` command shipping in the same binary is fine — users run it
as a background process (`scratchmdv4 serve`), same as they would a daemon.

---

## Rough order of work

1. Create `whalesync/scratch-cli-v4` GitHub repo and `whalesync/homebrew-scratch-cli-v4` tap
2. `cargo dist init` — generate CI template, tweak targets
3. Verify cross-compilation works locally for all 4 targets
4. Write `scripts/release_public.sh` and `scripts/release_test.sh`
5. Add `.gitlab-ci-release-v4.yml`, include in root CI
6. Cut first release (`v0.1.0`) manually to validate the full pipeline
7. Auto-patch on subsequent `prod` merges (same as Go CLI)
