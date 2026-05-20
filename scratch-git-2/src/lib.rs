//! Library target. Exposes `shared::*` to the napi cdylib crate (slice H.2 of
//! DEV-10144). The two binaries (`scratch-git-2` and `scratchmd`) deliberately
//! do NOT depend on this library — they each `#[path]`-include `shared/mod.rs`
//! into their own crate root, which is how the code was structured before the
//! cdylib was added. This file is the minimum surface needed to make
//! `scratch_git_2::shared::review_ops` resolvable from outside the crate.

pub mod shared {
    #[path = "../shared/mod.rs"]
    mod inner;
    pub use inner::*;
}
