# Gix Upgrade Notes

Last reviewed: 2026-04-02

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

## Important implementation note

The recent CLI clone/fetch migration was kept fairly isolated behind:

- `/Users/ijd/repos/spinner/scratch-git-2/src/cli/git_ops.rs`

That means a future `gix` upgrade can mostly revisit the internals there without redesigning higher-level CLI command flow. The upgrade would still be crate-wide, but the transport-specific logic now has a clearer home.

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
