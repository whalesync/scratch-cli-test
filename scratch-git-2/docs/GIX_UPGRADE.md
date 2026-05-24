# Gix Upgrade Notes

Last reviewed: 2026-04-03

> For day-to-day usage patterns (gix-vs-shell-out conventions, where the helpers live, common pitfalls) see [GIX_PATTERNS.md](GIX_PATTERNS.md). This doc focuses on version-bump decisions.

## Current state

`scratch-git-2` currently uses:

- `gix = 0.70.0`

At the time of this note, the latest published version is:

- `gix = 0.81.0`

We looked into upgrading while refactoring the CLI away from the local OS `git` executable, especially around the network/transport parts of clone, fetch, and push.

## Why we investigated

The CLI must eventually work without depending on a system `git` installation.

The service can still use system `git` for selected operations on our own machines, but the CLI cannot. During that work, the hardest remaining area was remote transport, especially push. That made it worth checking whether a newer `gix` version had introduced a clearer high-level transport or push API that would reduce implementation risk.

## Conclusion

We decided **not** to upgrade yet.

The short reason is:

- newer `gix` versions do improve the dependency stack and defaults
- clone/fetch support is still present and usable
- but there was **no clear new public high-level push API** that would make the remaining CLI push migration obviously easier or safer

So upgrading now would create migration churn without clearly solving the main remaining problem.

## What is better in newer versions

These are the main concrete differences we found between `0.70.0` and `0.81.0`:

- MSRV increased from Rust `1.70` to Rust `1.82`
- default features are broader in `0.81.0`
  - `auto-chain-error` is now enabled by default
  - `sha1` is now enabled by default
  - `blame` is included in the default `extras` bundle
- the transport/network stack is newer
  - `gix-protocol` moved from `0.48.0` to `0.59.0`
  - `gix-transport` moved from `0.45.0` to `0.55.1`
- a large number of subcrates moved forward as well
  - status
  - worktree state
  - index
  - hash
  - object DB
  - refs
  - revision parsing

These changes are real, but they do not by themselves justify an upgrade for our current goal.

## What would be marginally better if we upgraded

An upgrade to `0.81.0` would likely give us:

- a newer and more mature transport stack
- better default error chaining
- clearer modern feature defaults
- a more current base for future `gix` work
- a chance to reduce some version skew between older service code and newer CLI code

Those are useful improvements, but they are **incremental**, not decisive.

## Why we did not move now

The main reasons to stay on `0.70.0` for now are:

- the remaining hard problem is still push
- we did not find a clearly better high-level push abstraction in `0.81.0`
- upgrading would affect the whole crate, not just the CLI
- the service code also uses `gix`, so an upgrade would have compile and behavior fallout outside the current CLI refactor
- `0.81.0` requires Rust `1.82`, which is a separate toolchain/build pipeline decision

In other words: upgrading now would be a general maintenance move, not a targeted fix for the transport problem that motivated the investigation.

## Current status of the CLI gix migration

Last reviewed: 2026-04-03

### Clone and fetch: regression back to system git

Commit `65cb4dd6` ("replacing remaining dependencies on git with gix") successfully migrated `clone_bare` and `fetch_origin` to use gix natively:

- `clone_bare` used `gix::prepare_clone_bare()` with `.with_in_memory_config_overrides([auth_header])`
- `fetch_origin` used gix's `remote.connect(Direction::Fetch)` → `prepare_fetch()` → `receive()`
- A helper `sync_local_heads_from_remote_branches()` mapped remote refs to local heads after clone

However, the follow-up refactor commit `39a1fe63` ("reorg cli structure - split local and remote ops and extract tests") split `git_ops.rs` into `git_ops/local.rs` and `git_ops/remote.rs`, and **reverted all remote operations back to `Command::new("git")`**. The working gix implementations were lost in the reorganization.

The local operations in `git_ops/local.rs` correctly use gix. Only `git_ops/remote.rs` shells out to system git.

This regression causes DEV-9889: on machines without a git credential helper, `git clone --bare` fails with `could not read Username for 'https://api.scratch.md:443': Device not configured` because an HTTP→HTTPS redirect strips the `Authorization` header that was injected via `-c http.extraHeader`.

**To fix clone and fetch**: restore the gix-based implementations from commit `65cb4dd6`. The code is proven and the gix 0.70 APIs support it.

### Push: no gix support in any version

Push remains the hard problem. Confirmed as of 2026-04-03:

- **gix 0.70 through 0.81**: The `Connection` struct only exposes `ref_map()` and `prepare_fetch()`. There is no `prepare_push()`, `send_pack()`, or push module with execution logic.
- **gix-protocol**: The `Command` enum only has `LsRefs` and `Fetch` variants. No `ReceivePack`.
- **gitoxide roadmap**: Push is explicitly "outscoped" from the gix 1.0 roadmap (tracking issue #470). The open issue #306 ("client push to remote") has been open since January 2022 with no implementation.

Push is used in the CLI's upload flow (`files.rs`): `push_origin_dirty` and `force_push_origin_dirty` save local changes back to the server. Without push, users can clone and view but cannot save.

### Options for push without system git

1. **HTTP API endpoint**: Add a server endpoint that accepts file content directly (e.g., POST the dirty file map as JSON). The CLI already builds file maps in memory via gix. The server commits to the bare repo on its side. This bypasses the git push protocol entirely.

2. **libgit2 / git2-rs**: The `git2` Rust crate wraps libgit2, which does support push. This would add a C dependency to compile and link, but would give full git protocol support.

3. **Keep system git for push only**: Accept a partial dependency on system git for the push path. Give a clear error message when git is missing ("git is required for saving changes; install Xcode Command Line Tools or Homebrew git") instead of the current cryptic credential error. Harden with `-c credential.helper=` and `GIT_TERMINAL_PROMPT=0`.

4. **Lower-level protocol implementation**: Use `gix-transport` and `gix-protocol` directly to implement the `send-pack` client. This is technically possible but complex and fragile — essentially reimplementing what gix has not yet built.

### Implementation note

Remote transport logic lives in `src/cli/git_ops/remote.rs`. Local repo operations in `src/cli/git_ops/local.rs` already use gix correctly. The split is clean — fixing remote.rs does not require changes to local.rs or to higher-level command flow.

## What to check if we revisit this later

If a future agent or engineer wants to reevaluate the upgrade, start here:

- check the published version:
  - `cargo search gix --limit 1`
  - `cargo info gix`
- compare published metadata:
  - `cargo info --verbose gix@0.70.0`
  - `cargo info --verbose gix@0.81.0`
- inspect the downloaded crate sources in Cargo registry:
  - `~/.cargo/registry/src/.../gix-0.70.0/`
  - `~/.cargo/registry/src/.../gix-0.81.0/`
- compare feature definitions:
  - `Cargo.toml.orig`
- compare transport-related APIs by grepping for:
  - `fetch_only`
  - `connect`
  - `prepare_fetch`
  - `with_credentials`
  - `prepare_push`
  - `send_pack`
  - `remote_tracking_ref_name`
- check our own history for why the version was chosen:
  - `git log -L 21,21:scratch-git-2/Cargo.toml`
  - `git log -S 'version = "0.70"' -- scratch-git-2/Cargo.toml scratch-git-2/Cargo.lock`

## What we learned about the pin

The `0.70.0` version does **not** appear to be a carefully chosen long-term pin.

It was introduced in the initial `scratch-git-2` Rust service import:

- commit `62d77648`
- message: `[scratch-git-2] Add Rust scratch-git-2 service and HTTP backend proxy`

We did not find later history showing that `0.70.0` was intentionally kept for a specific compatibility reason. Right now it looks more like “the version used when the Rust rewrite started” than “a version we deliberately froze on for a known technical reason.”

## Suggested future decision rule

Revisit the upgrade only if at least one of these becomes true:

- we are ready to move build/CI/tooling to Rust `1.82+`
- a newer `gix` version exposes a clearly higher-level public push API
- we want the upgrade for general maintenance and can afford crate-wide retesting
- the remaining CLI push migration on `0.70.0` becomes too awkward to justify staying put

If none of those are true, it is reasonable to keep finishing the CLI migration on `0.70.0`.
