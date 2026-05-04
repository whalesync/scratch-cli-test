use std::path::Path;

use super::{FieldValidationContext, ValidationResult};

// # Python validators — temporarily disabled
//
// ## What was removed
//
// The full implementation used an embedded RustPython VM (no system Python required)
// to run user-provided `.py` validator scripts. It lived in this file and was wired
// into `dispatch_validator` in `mod.rs` via the `python:` prefix.
//
// ## Why it was disabled
//
// `rustpython-vm 0.5.0` (crates.io) has a broken cfg guard in
// `src/stdlib/time.rs`: the `#[cfg(windows)]` platform module imports
// `get_tz_info` unconditionally, but that function is only defined when
// `#[cfg(target_env = "msvc")]`. Cross-compiling to `x86_64-pc-windows-gnu`
// (MinGW) hits this — `#[cfg(windows)]` passes but `target_env` is `"gnu"`,
// not `"msvc"`, so the symbol is missing.
//
// The git-main branch of RustPython has a different breakage: it upgraded
// `icu_properties` to 2.x but `str.rs` still imports the removed
// `icu_properties::props::NumericType`, causing the same class of error.
// Neither crates.io nor git-main compiles cleanly for the Windows GNU target
// used by the release pipeline.
//
// A local vendor patch (`vendor/rustpython-vm/`) was prepared and confirmed
// working (changed two `#[cfg(target_env = "msvc")]` guards to `#[cfg(windows)]`
// in `decl` so `get_tz_info` and its `windows_sys` import are available on GNU).
// The vendor approach was set aside in favour of this stub to keep the repo lean
// until a cleaner upstream fix or git-fork solution is in place.
//
// ## How to re-enable
//
// 1. Restore the dependency in `Cargo.toml`:
//    `rustpython-vm = { version = "0.5.0", default-features = false, features = ["compiler"] }`
// 2. Replace this file with the full implementation from git history
//    (`git show HEAD~N:scratch-git-2/src/shared/validators/python.rs`).
// 3. Verify `cargo zigbuild --target x86_64-pc-windows-gnu --bin scratchmd` passes.
//    If it fails with the `get_tz_info` error, apply the vendor patch described above.

pub fn run_python_validator(
    relative_path: &str,
    _workspace_dir: &Path,
    _ctx: &FieldValidationContext,
) -> anyhow::Result<Option<ValidationResult>> {
    anyhow::bail!(
        "python validator '{}' cannot run: python validators are temporarily disabled",
        relative_path
    )
}
