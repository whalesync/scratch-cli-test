//! Centralized git-binary resolution for every `git` shell-out in this crate.
//!
//! Why this exists: the desktop app needs to ship its own git binary so users
//! don't need Xcode CLT / system git installed (DEV-10196). All call sites go
//! through `git_command()` / `git_command_async()` instead of `Command::new("git")`
//! so the desktop launcher can point them at a bundled binary via the
//! `SCRATCH_GIT_BIN` env var.
//!
//! Resolution order:
//!   1. `SCRATCH_GIT_BIN` env var (absolute path to bundled git binary).
//!      When set, `GIT_EXEC_PATH` is also injected automatically so git can
//!      find its `libexec/git-core/` helpers (`git-upload-pack`,
//!      `git-receive-pack`, …) inside the bundled tree.
//!   2. Fall back to `"git"` on `PATH`. This keeps the standalone CLI install
//!      (no env var) and `cargo test` (no env var) working unchanged.
//!
//! If `SCRATCH_GIT_BIN` points at a non-existent file we still fall back to
//! `PATH` rather than failing loudly — being defensive about a stale env var
//! is cheap and avoids breaking dev shells that inherited a bad value.
//!
//! Layout assumption for the bundled tree (from dugite-native):
//!   <bundle>/bin/git
//!   <bundle>/libexec/git-core/git-upload-pack
//!   <bundle>/libexec/git-core/git-http-backend
//!   …
//! We derive `GIT_EXEC_PATH` as `<bundle>/libexec/git-core` from the binary path.

// `shared/` is `#[path]`-included into the cli and service binaries (see lib.rs
// for the comment about why). The cli binary doesn't use `git_command_async`,
// the service binary uses both — silence the resulting dead-code warning.
#![allow(dead_code)]

use std::path::{Path, PathBuf};

const ENV_VAR: &str = "SCRATCH_GIT_BIN";

/// Resolve the git binary path to use. `None` means fall back to `"git"` on PATH.
fn resolve_bundled_git() -> Option<PathBuf> {
    let raw = std::env::var(ENV_VAR).ok()?;
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    let path = PathBuf::from(trimmed);
    if path.exists() {
        Some(path)
    } else {
        tracing::warn!(
            "{ENV_VAR}={} but file does not exist; falling back to system git",
            path.display()
        );
        None
    }
}

/// Given `<bundle>/bin/git`, return `<bundle>/libexec/git-core` if it exists.
fn derive_exec_path(git_bin: &Path) -> Option<PathBuf> {
    let bundle_root = git_bin.parent()?.parent()?;
    let exec_path = bundle_root.join("libexec").join("git-core");
    exec_path.is_dir().then_some(exec_path)
}

/// Given `<bundle>/bin/git`, return `<bundle>/share/git-core/templates` if it
/// exists. Without `GIT_TEMPLATE_DIR`, git falls back to its compiled-in
/// install prefix (e.g. `//share/git-core/templates`) and warns on every
/// `git init` / `git clone`. The actual repos we touch don't depend on the
/// templates, but the warning leaks into our stderr.
fn derive_template_dir(git_bin: &Path) -> Option<PathBuf> {
    let bundle_root = git_bin.parent()?.parent()?;
    let tpl = bundle_root.join("share").join("git-core").join("templates");
    tpl.is_dir().then_some(tpl)
}

fn apply_bundle_env<C: GitCommandLike>(cmd: &mut C, git_bin: &Path) {
    if let Some(exec_path) = derive_exec_path(git_bin) {
        cmd.set_env("GIT_EXEC_PATH", exec_path.as_os_str());
    }
    if let Some(template_dir) = derive_template_dir(git_bin) {
        cmd.set_env("GIT_TEMPLATE_DIR", template_dir.as_os_str());
    }
}

/// Trait used by `apply_exec_path` to set env on either std or tokio Command.
trait GitCommandLike {
    fn set_env(&mut self, key: &str, val: &std::ffi::OsStr);
}

impl GitCommandLike for std::process::Command {
    fn set_env(&mut self, key: &str, val: &std::ffi::OsStr) {
        self.env(key, val);
    }
}

impl GitCommandLike for tokio::process::Command {
    fn set_env(&mut self, key: &str, val: &std::ffi::OsStr) {
        self.env(key, val);
    }
}

/// Build a `std::process::Command` that invokes git. Use this in place of
/// `std::process::Command::new("git")` everywhere.
pub fn git_command() -> std::process::Command {
    match resolve_bundled_git() {
        Some(bin) => {
            let mut cmd = std::process::Command::new(&bin);
            apply_bundle_env(&mut cmd, &bin);
            cmd
        }
        None => std::process::Command::new("git"),
    }
}

/// Build a `tokio::process::Command` that invokes git. Use this in place of
/// `tokio::process::Command::new("git")`.
pub fn git_command_async() -> tokio::process::Command {
    match resolve_bundled_git() {
        Some(bin) => {
            let mut cmd = tokio::process::Command::new(&bin);
            apply_bundle_env(&mut cmd, &bin);
            cmd
        }
        None => tokio::process::Command::new("git"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Sequential guard — these tests mutate a process-global env var, so they
    /// can't run in parallel. `cargo test` parallelizes by default, so we
    /// serialize via a mutex.
    fn env_lock() -> std::sync::MutexGuard<'static, ()> {
        use std::sync::{Mutex, OnceLock};
        static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        LOCK.get_or_init(|| Mutex::new(()))
            .lock()
            .unwrap_or_else(|p| p.into_inner())
    }

    #[test]
    fn unset_env_uses_path_git() {
        let _guard = env_lock();
        std::env::remove_var(ENV_VAR);
        assert!(resolve_bundled_git().is_none());
    }

    #[test]
    fn empty_env_uses_path_git() {
        let _guard = env_lock();
        std::env::set_var(ENV_VAR, "");
        assert!(resolve_bundled_git().is_none());
        std::env::remove_var(ENV_VAR);
    }

    #[test]
    fn missing_bundled_binary_falls_back() {
        let _guard = env_lock();
        std::env::set_var(ENV_VAR, "/definitely/not/a/real/path/git");
        assert!(resolve_bundled_git().is_none());
        std::env::remove_var(ENV_VAR);
    }

    #[test]
    fn existing_bundled_binary_is_used() {
        let _guard = env_lock();
        let tmp = tempfile::tempdir().unwrap();
        let bin_dir = tmp.path().join("bin");
        std::fs::create_dir_all(&bin_dir).unwrap();
        let git_path = bin_dir.join("git");
        std::fs::write(&git_path, b"#!/bin/sh\n").unwrap();

        std::env::set_var(ENV_VAR, &git_path);
        let resolved = resolve_bundled_git();
        std::env::remove_var(ENV_VAR);

        assert_eq!(resolved, Some(git_path));
    }

    #[test]
    fn derive_exec_path_returns_libexec_dir_when_present() {
        let tmp = tempfile::tempdir().unwrap();
        let bundle = tmp.path();
        let bin = bundle.join("bin");
        let libexec = bundle.join("libexec").join("git-core");
        std::fs::create_dir_all(&bin).unwrap();
        std::fs::create_dir_all(&libexec).unwrap();
        let git = bin.join("git");
        std::fs::write(&git, b"").unwrap();

        assert_eq!(derive_exec_path(&git), Some(libexec));
    }

    #[test]
    fn derive_exec_path_returns_none_when_libexec_missing() {
        let tmp = tempfile::tempdir().unwrap();
        let bin = tmp.path().join("bin");
        std::fs::create_dir_all(&bin).unwrap();
        let git = bin.join("git");
        std::fs::write(&git, b"").unwrap();
        assert_eq!(derive_exec_path(&git), None);
    }
}
