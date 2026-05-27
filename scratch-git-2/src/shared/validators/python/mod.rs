//! Python validator runtime.
//!
//! Two interchangeable backends live behind a single public entry point:
//!
//! * [`per_invocation`] — one fresh RustPython interpreter per validator call.
//!   The original implementation. Robust, isolated, but pays the full VM
//!   bootstrap cost on every record.
//! * [`persistent_worker`] — one long-lived interpreter on a dedicated worker
//!   thread, with an mtime-keyed compiled-code cache. Pays the VM bootstrap
//!   once at first use; every later call is just `new_scope + compile-cache-
//!   lookup + run`.
//!
//! Selection: the `SCRATCH_PY_BACKEND` env var (`per_invocation` or
//! `persistent`) overrides the compiled-in default below. No restart needed
//! to flip — the env var is checked on each call.
//!
//! Default is `persistent` because the workspace-wide refresh path runs the
//! same validator across hundreds of records and the per-invocation VM
//! bootstrap is the dominant cost. Flip to `per_invocation` to roll back if
//! the persistent backend misbehaves.

mod per_invocation;
mod persistent_worker;
mod shared;

use std::path::Path;

use super::{FieldValidationContext, ValidationResult};

const DEFAULT_BACKEND: Backend = Backend::Persistent;

#[derive(Copy, Clone)]
enum Backend {
    PerInvocation,
    Persistent,
}

fn selected_backend() -> Backend {
    match std::env::var("SCRATCH_PY_BACKEND").ok().as_deref() {
        Some("per_invocation") => Backend::PerInvocation,
        Some("persistent") => Backend::Persistent,
        _ => DEFAULT_BACKEND,
    }
}

/// Run a Python validator script against one field value using an embedded
/// RustPython interpreter (no system Python required).
///
/// `relative_path` is relative to `workspace_dir` (`.scratch/workspace`),
/// e.g. `validators/check_name.py`.
///
/// **Python contract (violations-only):** the script's top-level
/// `validate(ctx)` must return a list. Every item in that list is a failure.
/// Return an empty list to signal a passing value. The `is_valid` key is not
/// used.
///
/// Item shape: `{"level": "warning"|"error", "message": "...", "description": "...", "fixable": true}`.
/// `level` defaults to `"warning"` when absent. `message` and `description`
/// are optional. `fixable` defaults to `false` when absent.
///
/// Returns `None` when the validator returns `[]`; `Some` for the first
/// violation in the returned list.
pub fn run_python_validator(
    relative_path: &str,
    workspace_dir: &Path,
    ctx: &FieldValidationContext,
) -> anyhow::Result<Option<ValidationResult>> {
    match selected_backend() {
        Backend::PerInvocation => per_invocation::run(relative_path, workspace_dir, ctx),
        Backend::Persistent => persistent_worker::run(relative_path, workspace_dir, ctx),
    }
}

// ── tests ────────────────────────────────────────────────────────────────────
//
// The test suite below runs every case against BOTH backends so a regression
// in either is caught locally. Failure messages include the backend name.

#[cfg(test)]
mod tests {
    use serde_json::json;
    use std::fs;
    use std::path::Path;
    use std::time::Duration;
    use tempfile::TempDir;

    use super::super::{FieldValidationContext, ValidationLevel, ValidationResult};
    use super::{per_invocation, persistent_worker};

    type BackendFn =
        fn(&str, &Path, &FieldValidationContext) -> anyhow::Result<Option<ValidationResult>>;

    const BACKENDS: &[(&str, BackendFn)] = &[
        ("per_invocation", per_invocation::run),
        ("persistent", persistent_worker::run),
    ];

    fn write(root: &Path, rel: &str, contents: &str) {
        let path = root.join(rel);
        if let Some(p) = path.parent() {
            fs::create_dir_all(p).unwrap();
        }
        fs::write(path, contents).unwrap();
    }

    fn ctx(value: serde_json::Value) -> FieldValidationContext {
        FieldValidationContext {
            filename: "one.json".to_string(),
            field_path: "title".to_string(),
            value,
            record: json!({"title": "hello"}),
            args: json!({"max": 10}),
        }
    }

    // ── happy path ────────────────────────────────────────────────────────────

    #[test]
    fn valid_result_returns_none() {
        for (name, run) in BACKENDS {
            let tmp = TempDir::new().unwrap();
            write(
                tmp.path(),
                "validators/check.py",
                "def validate(ctx):\n    return []\n",
            );
            let result = run("validators/check.py", tmp.path(), &ctx(json!("hi"))).unwrap();
            assert!(result.is_none(), "{name}: expected none");
        }
    }

    #[test]
    fn invalid_result_returns_warning_with_message() {
        for (name, run) in BACKENDS {
            let tmp = TempDir::new().unwrap();
            write(
                tmp.path(),
                "validators/check.py",
                "def validate(ctx):\n    return [{'message': 'too short'}]\n",
            );
            let result = run("validators/check.py", tmp.path(), &ctx(json!("hi")))
                .unwrap()
                .unwrap();
            assert_eq!(result.level, ValidationLevel::Warning, "{name}");
            assert_eq!(result.message.as_deref(), Some("too short"), "{name}");
        }
    }

    #[test]
    fn empty_result_list_returns_none() {
        for (name, run) in BACKENDS {
            let tmp = TempDir::new().unwrap();
            write(
                tmp.path(),
                "validators/check.py",
                "def validate(ctx):\n    return []\n",
            );
            let result = run("validators/check.py", tmp.path(), &ctx(json!("hi"))).unwrap();
            assert!(result.is_none(), "{name}");
        }
    }

    #[test]
    fn level_error_is_preserved() {
        for (name, run) in BACKENDS {
            let tmp = TempDir::new().unwrap();
            write(
                tmp.path(),
                "validators/check.py",
                "def validate(ctx):\n    return [{'level': 'error', 'message': 'hard fail'}]\n",
            );
            let result = run("validators/check.py", tmp.path(), &ctx(json!("hi")))
                .unwrap()
                .unwrap();
            assert_eq!(result.level, ValidationLevel::Error, "{name}");
            assert_eq!(result.message.as_deref(), Some("hard fail"), "{name}");
        }
    }

    #[test]
    fn description_is_preserved() {
        for (name, run) in BACKENDS {
            let tmp = TempDir::new().unwrap();
            write(
                tmp.path(),
                "validators/check.py",
                "def validate(ctx):\n    return [{'message': 'short', 'description': 'long explanation'}]\n",
            );
            let result = run("validators/check.py", tmp.path(), &ctx(json!("hi")))
                .unwrap()
                .unwrap();
            assert_eq!(result.message.as_deref(), Some("short"), "{name}");
            assert_eq!(
                result.description.as_deref(),
                Some("long explanation"),
                "{name}"
            );
        }
    }

    #[test]
    fn fixable_is_preserved() {
        for (name, run) in BACKENDS {
            let tmp = TempDir::new().unwrap();
            write(
                tmp.path(),
                "validators/check.py",
                "def validate(ctx):\n    return [{'message': 'can fix', 'fixable': True}]\n",
            );
            let result = run("validators/check.py", tmp.path(), &ctx(json!("hi")))
                .unwrap()
                .unwrap();
            assert!(result.fixable, "{name}");
        }
    }

    #[test]
    fn first_violation_is_returned() {
        for (name, run) in BACKENDS {
            let tmp = TempDir::new().unwrap();
            write(
                tmp.path(),
                "validators/check.py",
                "def validate(ctx):\n    return [{'message': 'first'}, {'message': 'second'}]\n",
            );
            let result = run("validators/check.py", tmp.path(), &ctx(json!("hi")))
                .unwrap()
                .unwrap();
            assert_eq!(result.level, ValidationLevel::Warning, "{name}");
            assert_eq!(result.message.as_deref(), Some("first"), "{name}");
        }
    }

    #[test]
    fn ctx_fields_are_accessible_in_validator() {
        for (name, run) in BACKENDS {
            let tmp = TempDir::new().unwrap();
            write(
                tmp.path(),
                "validators/check.py",
                r#"
def validate(ctx):
    ok = (
        ctx['filename'] == 'one.json' and
        ctx['field_path'] == 'title' and
        ctx['value'] == 'hello' and
        ctx['args']['max'] == 10
    )
    if not ok:
        return [{'message': 'ctx mismatch'}]
    return []
"#,
            );
            let mut c = ctx(json!("hello"));
            c.args = json!({"max": 10});
            let result = run("validators/check.py", tmp.path(), &c).unwrap();
            assert!(
                result.is_none(),
                "{name}: all ctx fields matched — expected no failure"
            );
        }
    }

    #[test]
    fn real_length_validator_in_python() {
        for (name, run) in BACKENDS {
            let tmp = TempDir::new().unwrap();
            write(
                tmp.path(),
                "validators/max_len.py",
                r#"
def validate(ctx):
    val = ctx['value'] or ''
    max_len = ctx['args']['max']
    if len(val) > max_len:
        return [{'message': 'value is {} chars (max {})'.format(len(val), max_len)}]
    return []
"#,
            );
            let mut c = ctx(json!("this is too long"));
            c.args = json!({"max": 5});
            let result = run("validators/max_len.py", tmp.path(), &c)
                .unwrap()
                .unwrap();
            assert_eq!(result.level, ValidationLevel::Warning, "{name}");
            assert!(
                result.message.as_deref().unwrap_or("").contains("chars"),
                "{name}"
            );
        }
    }

    #[test]
    fn violation_without_message_key_returns_warning_no_message() {
        for (name, run) in BACKENDS {
            let tmp = TempDir::new().unwrap();
            write(
                tmp.path(),
                "validators/check.py",
                "def validate(ctx):\n    return [{}]\n",
            );
            let result = run("validators/check.py", tmp.path(), &ctx(json!("hi")))
                .unwrap()
                .unwrap();
            assert_eq!(result.level, ValidationLevel::Warning, "{name}");
            assert!(result.message.is_none(), "{name}");
        }
    }

    // ── stripped builtins ─────────────────────────────────────────────────────

    #[test]
    fn dangerous_builtins_are_stripped() {
        let stripped = [
            "eval",
            "exec",
            "compile",
            "__import__",
            "__loader__",
            "open",
            "input",
            "globals",
            "locals",
            "vars",
            "breakpoint",
            "help",
            "exit",
            "quit",
            "dir",
            "memoryview",
        ];

        for (backend_name, run) in BACKENDS {
            for name in stripped {
                let tmp = TempDir::new().unwrap();
                let src = format!("def validate(ctx):\n    {}\n    return []\n", name);
                write(tmp.path(), "validators/check.py", &src);
                let err = run("validators/check.py", tmp.path(), &ctx(json!("hi"))).unwrap_err();
                let msg = err.to_string();
                assert!(
                    msg.contains("NameError") || msg.contains("not defined"),
                    "{backend_name}: expected NameError for '{name}', got: {msg}"
                );
                assert!(
                    msg.contains(name),
                    "{backend_name}: expected error to name '{name}', got: {msg}"
                );
            }
        }
    }

    #[test]
    fn eval_call_is_blocked_at_runtime() {
        for (name, run) in BACKENDS {
            let tmp = TempDir::new().unwrap();
            write(
                tmp.path(),
                "validators/evil.py",
                "def validate(ctx):\n    eval('1 + 1')\n    return []\n",
            );
            let err = run("validators/evil.py", tmp.path(), &ctx(json!("hi"))).unwrap_err();
            let msg = err.to_string();
            assert!(
                msg.contains("NameError") || msg.contains("not defined"),
                "{name}: got: {msg}"
            );
            assert!(msg.contains("eval"), "{name}: got: {msg}");
        }
    }

    #[test]
    fn setattr_and_delattr_work_on_validator_locals() {
        for (name, run) in BACKENDS {
            let tmp = TempDir::new().unwrap();
            write(
                tmp.path(),
                "validators/mutates.py",
                r#"
def validate(ctx):
    def f():
        pass
    setattr(f, 'tag', 42)
    if getattr(f, 'tag') != 42:
        return [{'message': 'setattr did not stick'}]
    delattr(f, 'tag')
    if hasattr(f, 'tag'):
        return [{'message': 'delattr did not remove'}]
    return []
"#,
            );
            let result = run("validators/mutates.py", tmp.path(), &ctx(json!("hi"))).unwrap();
            assert!(
                result.is_none(),
                "{name}: expected no violation, got: {:?}",
                result
            );
        }
    }

    #[test]
    fn user_defined_classes_are_allowed() {
        for (name, run) in BACKENDS {
            let tmp = TempDir::new().unwrap();
            write(
                tmp.path(),
                "validators/cls.py",
                r#"
class Helper:
    def __init__(self, n):
        self.n = n

    def doubled(self):
        return self.n * 2

def validate(ctx):
    if Helper(21).doubled() != 42:
        return [{'message': 'class arithmetic broken'}]
    return []
"#,
            );
            let result = run("validators/cls.py", tmp.path(), &ctx(json!("hi"))).unwrap();
            assert!(
                result.is_none(),
                "{name}: expected no violation, got: {:?}",
                result
            );
        }
    }

    #[test]
    fn safe_builtins_still_work() {
        for (name, run) in BACKENDS {
            let tmp = TempDir::new().unwrap();
            write(
                tmp.path(),
                "validators/uses_safe_builtins.py",
                r#"
def validate(ctx):
    s = str(ctx['value'])
    n = len(s)
    pairs = list(enumerate([1, 2, 3]))
    total = sum(range(5))
    biggest = max([n, total])
    ok = isinstance(s, str) and bool(s) and biggest > 0 and 'h' in s
    if not ok:
        return [{'message': 'safe builtin returned wrong result'}]
    return []
"#,
            );
            let result = run(
                "validators/uses_safe_builtins.py",
                tmp.path(),
                &ctx(json!("hi")),
            )
            .unwrap();
            assert!(
                result.is_none(),
                "{name}: expected no violation, got: {:?}",
                result
            );
        }
    }

    #[test]
    fn oversized_validator_is_rejected() {
        for (name, run) in BACKENDS {
            let tmp = TempDir::new().unwrap();
            let mut large = String::from("def validate(ctx):\n    return []\n# ");
            large.push_str(&"x".repeat(300 * 1024));
            write(tmp.path(), "validators/big.py", &large);
            let err = run("validators/big.py", tmp.path(), &ctx(json!("hi"))).unwrap_err();
            let msg = err.to_string();
            assert!(msg.contains("too large"), "{name}: got: {msg}");
            assert!(msg.contains("validators/big.py"), "{name}: got: {msg}");
        }
    }

    #[test]
    fn validator_just_under_size_limit_still_runs() {
        for (name, run) in BACKENDS {
            let tmp = TempDir::new().unwrap();
            let mut source = String::from("def validate(ctx):\n    return []\n# ");
            source.push_str(&"x".repeat(200 * 1024));
            write(tmp.path(), "validators/biggish.py", &source);
            let result = run("validators/biggish.py", tmp.path(), &ctx(json!("hi"))).unwrap();
            assert!(result.is_none(), "{name}");
        }
    }

    #[test]
    fn file_not_found_gives_clear_message() {
        for (name, run) in BACKENDS {
            let tmp = TempDir::new().unwrap();
            let err = run("validators/missing.py", tmp.path(), &ctx(json!("hi"))).unwrap_err();
            let msg = err.to_string();
            assert!(
                msg.contains("python validator not found"),
                "{name}: got: {msg}"
            );
            assert!(msg.contains("validators/missing.py"), "{name}: got: {msg}");
        }
    }

    // ── path containment ──────────────────────────────────────────────────────

    #[test]
    fn non_py_suffix_is_rejected() {
        for (name, run) in BACKENDS {
            let tmp = TempDir::new().unwrap();
            let err = run("validators/check.txt", tmp.path(), &ctx(json!("hi"))).unwrap_err();
            let msg = err.to_string();
            assert!(msg.contains("must end in .py"), "{name}: got: {msg}");
        }
    }

    #[test]
    fn parent_dir_traversal_is_rejected() {
        for (name, run) in BACKENDS {
            let tmp = TempDir::new().unwrap();
            let err = run("validators/../escape.py", tmp.path(), &ctx(json!("hi"))).unwrap_err();
            let msg = err.to_string();
            assert!(msg.contains("must not contain '..'"), "{name}: got: {msg}");
        }
    }

    #[test]
    fn absolute_path_is_rejected() {
        for (name, run) in BACKENDS {
            let tmp = TempDir::new().unwrap();
            let err = run("/etc/passwd.py", tmp.path(), &ctx(json!("hi"))).unwrap_err();
            let msg = err.to_string();
            assert!(
                msg.contains("must be relative") || msg.contains("absolute"),
                "{name}: got: {msg}"
            );
        }
    }

    #[test]
    fn path_outside_validators_dir_is_rejected() {
        for (name, run) in BACKENDS {
            let tmp = TempDir::new().unwrap();
            write(
                tmp.path(),
                "other/check.py",
                "def validate(ctx):\n    return []\n",
            );
            let err = run("other/check.py", tmp.path(), &ctx(json!("hi"))).unwrap_err();
            let msg = err.to_string();
            assert!(
                msg.contains("must live under validators/"),
                "{name}: got: {msg}"
            );
        }
    }

    // ── syntax and function errors ────────────────────────────────────────────

    #[test]
    fn syntax_error_gives_clear_message() {
        for (name, run) in BACKENDS {
            let tmp = TempDir::new().unwrap();
            write(
                tmp.path(),
                "validators/bad.py",
                "def validate(ctx\n    return []\n",
            );
            let err = run("validators/bad.py", tmp.path(), &ctx(json!("hi"))).unwrap_err();
            let msg = err.to_string();
            assert!(msg.contains("syntax error"), "{name}: got: {msg}");
        }
    }

    #[test]
    fn missing_validate_function_gives_clear_message() {
        for (name, run) in BACKENDS {
            let tmp = TempDir::new().unwrap();
            write(tmp.path(), "validators/check.py", "x = 1\n");
            let err = run("validators/check.py", tmp.path(), &ctx(json!("hi"))).unwrap_err();
            let msg = err.to_string();
            assert!(
                msg.contains("must define a top-level validate(ctx) function"),
                "{name}: got: {msg}"
            );
        }
    }

    #[test]
    fn import_blocked_in_sandbox() {
        for (name, run) in BACKENDS {
            let tmp = TempDir::new().unwrap();
            write(
                tmp.path(),
                "validators/check.py",
                "import subprocess\ndef validate(ctx):\n    return []\n",
            );
            let err = run("validators/check.py", tmp.path(), &ctx(json!("hi"))).unwrap_err();
            let msg = err.to_string();
            assert!(
                msg.contains("import")
                    || msg.contains("ModuleNotFoundError")
                    || msg.contains("No module named"),
                "{name}: expected import error, got: {msg}"
            );
        }
    }

    // ── wrong return shape ────────────────────────────────────────────────────

    #[test]
    fn returns_none_gives_clear_message() {
        for (name, run) in BACKENDS {
            let tmp = TempDir::new().unwrap();
            write(
                tmp.path(),
                "validators/check.py",
                "def validate(ctx):\n    pass\n",
            );
            let err = run("validators/check.py", tmp.path(), &ctx(json!("hi"))).unwrap_err();
            let msg = err.to_string();
            assert!(
                msg.contains("expected list") || msg.contains("NoneType"),
                "{name}: got: {msg}"
            );
        }
    }

    #[test]
    fn returns_dict_not_list_gives_clear_message() {
        for (name, run) in BACKENDS {
            let tmp = TempDir::new().unwrap();
            write(
                tmp.path(),
                "validators/check.py",
                "def validate(ctx):\n    return {'is_valid': True, 'message': None}\n",
            );
            let err = run("validators/check.py", tmp.path(), &ctx(json!("hi"))).unwrap_err();
            let msg = err.to_string();
            assert!(msg.contains("expected list"), "{name}: got: {msg}");
        }
    }

    #[test]
    fn result_with_only_message_key_is_a_valid_violation() {
        for (name, run) in BACKENDS {
            let tmp = TempDir::new().unwrap();
            write(
                tmp.path(),
                "validators/check.py",
                "def validate(ctx):\n    return [{'message': 'x'}]\n",
            );
            let result = run("validators/check.py", tmp.path(), &ctx(json!("hi")))
                .unwrap()
                .unwrap();
            assert_eq!(result.level, ValidationLevel::Warning, "{name}");
            assert_eq!(result.message.as_deref(), Some("x"), "{name}");
        }
    }

    // ── runtime exceptions ────────────────────────────────────────────────────

    #[test]
    fn runtime_exception_gives_clear_message() {
        for (name, run) in BACKENDS {
            let tmp = TempDir::new().unwrap();
            write(
                tmp.path(),
                "validators/check.py",
                "def validate(ctx):\n    raise ValueError('something went wrong')\n",
            );
            let err = run("validators/check.py", tmp.path(), &ctx(json!("hi"))).unwrap_err();
            let msg = err.to_string();
            assert!(msg.contains("raised"), "{name}: got: {msg}");
        }
    }

    // ── cooperative interrupt ─────────────────────────────────────────────────

    #[test]
    fn runaway_loop_is_interrupted_within_timeout() {
        for (name, run) in BACKENDS {
            let tmp = TempDir::new().unwrap();
            write(
                tmp.path(),
                "validators/spin.py",
                "def validate(ctx):\n    while True:\n        pass\n",
            );
            let start = std::time::Instant::now();
            let err = run("validators/spin.py", tmp.path(), &ctx(json!("hi"))).unwrap_err();
            let elapsed = start.elapsed();
            let msg = err.to_string();
            assert!(
                msg.contains("timed out") && msg.contains("validators/spin.py"),
                "{name}: got: {msg}"
            );
            assert!(
                elapsed < Duration::from_secs(8),
                "{name}: took {:?}, expected interrupt around 5s",
                elapsed
            );
        }
    }

    // per_invocation only: a validator that swallows KeyboardInterrupt in a
    // bare except inside an infinite loop permanently wedges the persistent
    // backend's shared VM (see persistent_worker.rs module doc). The caller
    // would still return a timeout error within the backstop, but the worker
    // would block every subsequent call. Per-invocation isolates this safely
    // by spawning a fresh VM per call.
    #[test]
    fn validator_swallowing_keyboard_interrupt_still_reports_timeout() {
        let tmp = TempDir::new().unwrap();
        write(
            tmp.path(),
            "validators/swallow.py",
            r#"
def validate(ctx):
    while True:
        try:
            pass
        except:
            pass
"#,
        );
        let start = std::time::Instant::now();
        let err = per_invocation::run("validators/swallow.py", tmp.path(), &ctx(json!("hi")))
            .unwrap_err();
        let elapsed = start.elapsed();
        let msg = err.to_string();
        assert!(msg.contains("timed out"), "got: {msg}");
        assert!(elapsed < Duration::from_secs(8), "took {:?}", elapsed);
    }

    #[test]
    fn fast_validator_returns_well_before_timeout() {
        for (name, run) in BACKENDS {
            let tmp = TempDir::new().unwrap();
            write(
                tmp.path(),
                "validators/quick.py",
                "def validate(ctx):\n    return []\n",
            );
            let start = std::time::Instant::now();
            let result = run("validators/quick.py", tmp.path(), &ctx(json!("hi"))).unwrap();
            let elapsed = start.elapsed();
            assert!(result.is_none(), "{name}");
            assert!(
                elapsed < Duration::from_secs(2),
                "{name}: fast validator took {:?}; timer-thread cancel may be broken",
                elapsed
            );
        }
    }

    #[test]
    fn sys_exit_does_not_kill_process() {
        for (_name, run) in BACKENDS {
            let tmp = TempDir::new().unwrap();
            write(
                tmp.path(),
                "validators/check.py",
                "import sys\ndef validate(ctx):\n    sys.exit(1)\n",
            );
            let result = run("validators/check.py", tmp.path(), &ctx(json!("hi")));
            assert!(result.is_err());
        }
    }

    // ── persistent-backend-specific: reuse across calls + cache hit ──────────

    #[test]
    fn persistent_backend_reuses_vm_across_calls() {
        // Three calls back-to-back against the persistent worker. First call
        // pays the VM bootstrap; later calls should be substantially faster.
        // The exact ratio depends on machine speed, so we just assert that
        // none of the calls regress to first-call timings (5s timeout etc).
        let tmp = TempDir::new().unwrap();
        write(
            tmp.path(),
            "validators/quick.py",
            "def validate(ctx):\n    return []\n",
        );

        for _ in 0..3 {
            let start = std::time::Instant::now();
            let result =
                persistent_worker::run("validators/quick.py", tmp.path(), &ctx(json!("hi")))
                    .unwrap();
            let elapsed = start.elapsed();
            assert!(result.is_none());
            assert!(
                elapsed < Duration::from_secs(4),
                "call took {:?}, persistent backend should be well under 4s",
                elapsed
            );
        }
    }

    #[test]
    fn persistent_backend_picks_up_validator_edits() {
        // The compiled-code cache is mtime-keyed. Editing the file should
        // invalidate the cache entry and recompile on the next call.
        let tmp = TempDir::new().unwrap();
        write(
            tmp.path(),
            "validators/changing.py",
            "def validate(ctx):\n    return []\n",
        );
        let first = persistent_worker::run("validators/changing.py", tmp.path(), &ctx(json!("hi")))
            .unwrap();
        assert!(first.is_none());

        // Sleep briefly so the mtime tick advances on filesystems with
        // coarse-grained timestamps (older HFS+, some Linux mounts).
        std::thread::sleep(Duration::from_millis(20));

        write(
            tmp.path(),
            "validators/changing.py",
            "def validate(ctx):\n    return [{'level': 'error', 'message': 'changed'}]\n",
        );
        let second =
            persistent_worker::run("validators/changing.py", tmp.path(), &ctx(json!("hi")))
                .unwrap()
                .unwrap();
        assert_eq!(second.level, ValidationLevel::Error);
        assert_eq!(second.message.as_deref(), Some("changed"));
    }
}
