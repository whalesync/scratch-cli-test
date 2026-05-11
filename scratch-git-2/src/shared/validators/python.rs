use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::Arc;
use std::time::Duration;

use rustpython_vm::signal::{self, UserSignalReceiver};
use rustpython_vm::AsObject;

use super::{FieldValidationContext, ValidationLevel, ValidationResult};

// ── level parsing helper ──────────────────────────────────────────────────────

fn parse_level(s: &str) -> ValidationLevel {
    if s == "error" {
        ValidationLevel::Error
    } else {
        ValidationLevel::Warning
    }
}

// ── path containment ─────────────────────────────────────────────────────────

/// Resolve a validator's relative path against `workspace_dir`, rejecting any
/// path that escapes the workbook's `validators/` directory or that doesn't
/// look like a Python source file. Lexical checks only — no filesystem access.
fn resolve_validator_path(workspace_dir: &Path, relative_path: &str) -> anyhow::Result<PathBuf> {
    if !relative_path.ends_with(".py") {
        return Err(anyhow::anyhow!(
            "python validator path must end in .py: {}",
            relative_path
        ));
    }

    let rel = Path::new(relative_path);
    for component in rel.components() {
        match component {
            Component::ParentDir => {
                return Err(anyhow::anyhow!(
                    "python validator path must not contain '..': {}",
                    relative_path
                ));
            }
            Component::Prefix(_) | Component::RootDir => {
                return Err(anyhow::anyhow!(
                    "python validator path must be relative, not absolute: {}",
                    relative_path
                ));
            }
            Component::Normal(_) | Component::CurDir => {}
        }
    }

    if !rel.starts_with("validators") {
        return Err(anyhow::anyhow!(
            "python validator path must live under validators/: {}",
            relative_path
        ));
    }

    Ok(workspace_dir.join(rel))
}

const TIMEOUT_SECS: u64 = 5;
/// Extra wall-clock budget given to `mpsc::recv_timeout` on top of `TIMEOUT_SECS`
/// so the cooperative-interrupt path has time to raise the Python exception,
/// unwind frames, and send the result back to the main thread before the
/// backstop fires. The cooperative interrupt is the desired exit path; this
/// buffer just keeps the backstop from racing it.
const TIMEOUT_BACKSTOP_BUFFER_SECS: u64 = 2;
const MAX_VALIDATOR_BYTES: u64 = 256 * 1024;

// Names removed from the validator's `__builtins__` to reduce sandbox-escape
// surface. Each Interpreter gets its own builtins module, so this mutation is
// scoped to a single validator invocation. Removing these does not close every
// possible escape path (notably `().__class__.__bases__[0].__subclasses__()`
// still works via attribute traversal), but it shuts down the obvious dynamic-
// code execution, scope introspection, and reconnaissance vectors and shrinks
// the attack surface for future interpreter bugs.
//
// Intentionally NOT stripped:
//   setattr, delattr    — the ctx dict and its contents are JSON-deep-cloned
//                         into the VM, so any mutation is thrown away when the
//                         interpreter exits. Built-in types reject setattr at
//                         runtime, leaving only user-defined attribute paths
//                         to mutate, which have no path back to Rust state.
//   __build_class__     — required by the `class X:` statement. Validators
//                         should be free to declare helper classes; the main
//                         RustPython escape chain doesn't need this anyway.
//   id                  — leaks object identity but doesn't enable a concrete
//                         attack on its own.
//
// `open` is stripped: making it functional in our no-stdlib config would
// require the `host_env` cargo feature, which also exposes `os`/`sys.exit`/
// signal handling and meaningfully widens the sandbox. If validators ever
// genuinely need file inputs, prefer pre-loading the contents on the Rust
// side and injecting them through `ctx['args']` instead of opening the door.
const STRIPPED_BUILTINS: &[&str] = &[
    // dynamic code execution / module loading
    "eval",
    "exec",
    "compile",
    "__import__",
    "__loader__",
    "__spec__",
    "__package__",
    // filesystem / interactive IO
    "open",
    "input",
    // scope introspection
    "globals",
    "locals",
    "vars",
    // REPL / interactive helpers
    "breakpoint",
    "help",
    "exit",
    "quit",
    "copyright",
    "credits",
    "license",
    // reconnaissance / low-level
    "dir",
    "memoryview",
];

type PythonValidationItem = (ValidationLevel, Option<String>, Option<String>, bool);

/// Run a Python validator script against one field value using an embedded
/// RustPython interpreter (no system Python required).
///
/// `relative_path` is relative to `workspace_dir` (`.scratch/workspace`),
/// e.g. `validators/check_name.py`.
///
/// The validator script must define a top-level `validate(ctx)` function:
///
/// ```python
/// def validate(ctx):
///     # ctx keys: filename, field_path, value, record, args
///     if len(ctx["value"] or "") > ctx["args"]["max"]:
///         return [{"level": "warning", "message": "too long"}]
///     return []   # empty list = pass
/// ```
///
/// **Python contract (violations-only):** every item in the returned list is a failure.
/// Return an empty list to signal that the value is valid. The `is_valid` key is not used.
///
/// Item shape: `{"level": "warning"|"error", "message": "...", "description": "...", "fixable": true}`.
/// `level` defaults to `"warning"` when absent. `message` and `description` are optional.
/// `fixable` defaults to `false` when absent.
///
/// Returns `None` when no violations are reported; `Some` for the first violation.
pub fn run_python_validator(
    relative_path: &str,
    workspace_dir: &Path,
    ctx: &FieldValidationContext,
) -> anyhow::Result<Option<ValidationResult>> {
    let validator_path = resolve_validator_path(workspace_dir, relative_path)?;

    let metadata = std::fs::metadata(&validator_path).map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            anyhow::anyhow!(
                "python validator not found: {} (looked in {})",
                relative_path,
                validator_path.display()
            )
        } else {
            anyhow::anyhow!("failed to stat python validator {}: {}", relative_path, e)
        }
    })?;

    if metadata.len() > MAX_VALIDATOR_BYTES {
        return Err(anyhow::anyhow!(
            "python validator {} is too large: {} bytes (limit {} bytes)",
            relative_path,
            metadata.len(),
            MAX_VALIDATOR_BYTES
        ));
    }

    let source = std::fs::read_to_string(&validator_path)
        .map_err(|e| anyhow::anyhow!("failed to read python validator {}: {}", relative_path, e))?;

    // Clone context fields so the thread closure can own them.
    let filename = ctx.filename.clone();
    let field_path = ctx.field_path.clone();
    let value = ctx.value.clone();
    let record = ctx.record.clone();
    let args = ctx.args.clone();
    let script_name = relative_path.to_string();

    // Cooperative interrupt:
    //   • timer thread sleeps for TIMEOUT_SECS on `cancel_rx`. If the worker
    //     finishes first it drops `cancel_tx`, which wakes the timer and it
    //     exits without firing.
    //   • on real timeout it sets `timeout_flag` and pushes a `UserSignal`
    //     closure that raises KeyboardInterrupt at the next `check_signals`
    //     point in the bytecode loop.
    // The recv_timeout below stays as a backstop in case the script is stuck
    // inside a Rust-implemented builtin where check_signals never runs.
    let timeout_flag = Arc::new(AtomicBool::new(false));
    let (signal_tx, signal_rx) = signal::user_signal_channel();
    let (cancel_tx, cancel_rx) = mpsc::channel::<()>();

    {
        let timeout_flag = Arc::clone(&timeout_flag);
        std::thread::spawn(move || {
            if let Err(mpsc::RecvTimeoutError::Timeout) =
                cancel_rx.recv_timeout(Duration::from_secs(TIMEOUT_SECS))
            {
                timeout_flag.store(true, Ordering::Release);
                let _ = signal_tx.send(Box::new(|vm: &rustpython_vm::VirtualMachine| {
                    let exc_type = vm.ctx.exceptions.keyboard_interrupt.to_owned();
                    Err(vm.new_exception_msg(exc_type, "validator exceeded timeout".into()))
                }));
            }
        });
    }

    let (tx, rx) = mpsc::channel::<anyhow::Result<Vec<PythonValidationItem>>>();

    std::thread::spawn(move || {
        let result = exec_in_vm(
            &source,
            &script_name,
            &filename,
            &field_path,
            &value,
            &record,
            &args,
            signal_rx,
        );
        // Wake the timer thread so it doesn't sit on its sleep after the
        // worker has already finished. Send error means the timer already
        // exited — fine either way.
        let _ = cancel_tx.send(());
        let _ = tx.send(result);
    });

    let backstop = Duration::from_secs(TIMEOUT_SECS + TIMEOUT_BACKSTOP_BUFFER_SECS);
    let recv_result = rx.recv_timeout(backstop);

    // If the timer fired during execution, treat this as a timeout regardless
    // of what the worker returned — the validator either got the interrupt
    // and raised, or ignored it and snuck a result through; both should be
    // reported as a timeout.
    if timeout_flag.load(Ordering::Acquire) {
        return Err(anyhow::anyhow!(
            "python validator {} timed out after {}s",
            relative_path,
            TIMEOUT_SECS
        ));
    }

    let results = match recv_result {
        Ok(r) => r?,
        Err(mpsc::RecvTimeoutError::Timeout) => {
            return Err(anyhow::anyhow!(
                "python validator {} timed out after {}s",
                relative_path,
                TIMEOUT_SECS
            ));
        }
        Err(mpsc::RecvTimeoutError::Disconnected) => {
            return Err(anyhow::anyhow!(
                "python validator {} panicked during execution",
                relative_path
            ));
        }
    };

    // Every item is a violation; empty list means pass.
    match results.into_iter().next() {
        Some((level, message, description, fixable)) => Ok(Some(ValidationResult {
            level,
            message,
            description,
            fixable,
        })),
        None => Ok(None),
    }
}

// ── VM execution (runs in its own thread) ────────────────────────────────────

#[allow(clippy::too_many_arguments)]
fn exec_in_vm(
    source: &str,
    script_name: &str,
    filename: &str,
    field_path: &str,
    value: &serde_json::Value,
    record: &serde_json::Value,
    args: &serde_json::Value,
    signal_rx: UserSignalReceiver,
) -> anyhow::Result<Vec<PythonValidationItem>> {
    use rustpython_vm as rvm;

    // Create an interpreter with no stdlib added — only Python builtins are
    // available. This prevents `import subprocess`, `import socket`, etc.
    // The signal receiver lets the timer thread raise KeyboardInterrupt at
    // the next check_signals point in the bytecode loop.
    let interp = rvm::Interpreter::with_init(Default::default(), move |vm| {
        vm.set_user_signal_channel(signal_rx);
    });

    interp.enter(|vm| -> anyhow::Result<Vec<PythonValidationItem>> {
        let scope = vm.new_scope_with_builtins();

        // Defense-in-depth: strip dangerous names from this interpreter's
        // builtins module. del_item returns KeyError for names that aren't
        // present in this build — we ignore those.
        let builtins_dict = vm.builtins.dict();
        for name in STRIPPED_BUILTINS {
            let _ = builtins_dict.del_item(*name, vm);
        }

        // ── compile ──────────────────────────────────────────────────────────
        let code = vm
            .compile(source, rvm::compiler::Mode::Exec, script_name.to_owned())
            .map_err(|e| {
                anyhow::anyhow!("python validator {} has a syntax error: {}", script_name, e)
            })?;

        // ── run module-level code (defines validate fn and any helpers) ──────
        vm.run_code_obj(code, scope.clone()).map_err(|exc| {
            let msg = exc_to_string(vm, &exc);
            if msg.contains("ModuleNotFoundError") || msg.contains("ImportError") {
                anyhow::anyhow!(
                    "python validator {} failed to import a module: {} \
                     (only Python builtins are available in the validator sandbox)",
                    script_name,
                    msg
                )
            } else {
                anyhow::anyhow!("python validator {} raised {}", script_name, msg)
            }
        })?;

        // ── locate validate function ──────────────────────────────────────────
        let validate_fn = scope.globals.get_item("validate", vm).map_err(|_| {
            anyhow::anyhow!(
                "python validator {} must define a top-level validate(ctx) function",
                script_name
            )
        })?;

        // ── build ctx dict ────────────────────────────────────────────────────
        let ctx_dict = vm.ctx.new_dict();
        dict_set_str(&ctx_dict, "filename", filename, vm, script_name)?;
        dict_set_str(&ctx_dict, "field_path", field_path, vm, script_name)?;
        dict_set_json(&ctx_dict, "value", value, vm, script_name)?;
        dict_set_json(&ctx_dict, "record", record, vm, script_name)?;
        dict_set_json(&ctx_dict, "args", args, vm, script_name)?;

        // ── call validate(ctx) ────────────────────────────────────────────────
        let result_obj = validate_fn
            .call((rvm::PyObjectRef::from(ctx_dict),), vm)
            .map_err(|exc| {
                anyhow::anyhow!(
                    "python validator {} raised {}",
                    script_name,
                    exc_to_string(vm, &exc)
                )
            })?;

        // ── extract results ───────────────────────────────────────────────────
        extract_results(result_obj, script_name, vm)
    })
}

// ── result extraction ────────────────────────────────────────────────────────

fn extract_results(
    result_obj: rustpython_vm::PyObjectRef,
    script_name: &str,
    vm: &rustpython_vm::VirtualMachine,
) -> anyhow::Result<Vec<PythonValidationItem>> {
    use rustpython_vm::builtins::PyList;

    // Must be a list. Every item in the list is a violation.
    let list = result_obj.downcast::<PyList>().map_err(|obj| {
        anyhow::anyhow!(
            "python validator {} returned {}: expected list[dict] (violations only — return [] for pass)",
            script_name,
            obj.class().name()
        )
    })?;

    let mut out = Vec::new();
    let items = list.borrow_vec();
    for (i, item) in items.iter().enumerate() {
        // level — optional str; defaults to "warning"
        let level = match item.get_item("level", vm) {
            Ok(level_obj) if !vm.is_none(&level_obj) => {
                let s = obj_to_string(vm, &level_obj, script_name, i, "level")?;
                parse_level(&s)
            }
            _ => ValidationLevel::Warning,
        };

        // message — optional str/None
        let message = match item.get_item("message", vm) {
            Ok(msg_obj) if !vm.is_none(&msg_obj) => {
                Some(obj_to_string(vm, &msg_obj, script_name, i, "message")?)
            }
            _ => None,
        };

        // description — optional str/None
        let description = match item.get_item("description", vm) {
            Ok(desc_obj) if !vm.is_none(&desc_obj) => {
                Some(obj_to_string(vm, &desc_obj, script_name, i, "description")?)
            }
            _ => None,
        };

        let fixable = match item.get_item("fixable", vm) {
            Ok(fixable_obj) if !vm.is_none(&fixable_obj) => {
                obj_to_bool(vm, &fixable_obj, script_name, i, "fixable")?
            }
            _ => false,
        };

        out.push((level, message, description, fixable));
    }

    Ok(out)
}

fn obj_to_string(
    vm: &rustpython_vm::VirtualMachine,
    obj: &rustpython_vm::PyObjectRef,
    script_name: &str,
    index: usize,
    field_name: &str,
) -> anyhow::Result<String> {
    obj.str(vm).map(|s| s.to_string()).map_err(|exc| {
        anyhow::anyhow!(
            "python validator {} '{}' at index {} is not convertible to string: {}",
            script_name,
            field_name,
            index,
            exc_to_string(vm, &exc)
        )
    })
}

fn obj_to_bool(
    vm: &rustpython_vm::VirtualMachine,
    obj: &rustpython_vm::PyObjectRef,
    script_name: &str,
    index: usize,
    field_name: &str,
) -> anyhow::Result<bool> {
    let value = obj_to_string(vm, obj, script_name, index, field_name)?;
    match value.as_str() {
        "True" | "true" | "1" => Ok(true),
        "False" | "false" | "0" => Ok(false),
        other => anyhow::bail!(
            "python validator {} '{}' at index {} must be a boolean, got {}",
            script_name,
            field_name,
            index,
            other
        ),
    }
}

// ── dict helpers ─────────────────────────────────────────────────────────────

fn dict_set_str(
    dict: &rustpython_vm::builtins::PyDictRef,
    key: &str,
    val: &str,
    vm: &rustpython_vm::VirtualMachine,
    script_name: &str,
) -> anyhow::Result<()> {
    let py_val: rustpython_vm::PyObjectRef = vm.ctx.new_str(val).into();
    dict.set_item(key, py_val, vm).map_err(|e| {
        anyhow::anyhow!(
            "ctx build error in {}: {}",
            script_name,
            exc_to_string(vm, &e)
        )
    })
}

fn dict_set_json(
    dict: &rustpython_vm::builtins::PyDictRef,
    key: &str,
    val: &serde_json::Value,
    vm: &rustpython_vm::VirtualMachine,
    script_name: &str,
) -> anyhow::Result<()> {
    let py_val = json_to_py(val, vm).map_err(|e| {
        anyhow::anyhow!(
            "ctx build error in {}: {}",
            script_name,
            exc_to_string(vm, &e)
        )
    })?;
    dict.set_item(key, py_val, vm).map_err(|e| {
        anyhow::anyhow!(
            "ctx build error in {}: {}",
            script_name,
            exc_to_string(vm, &e)
        )
    })
}

// ── JSON → Python object bridge ──────────────────────────────────────────────

fn json_to_py(
    value: &serde_json::Value,
    vm: &rustpython_vm::VirtualMachine,
) -> rustpython_vm::PyResult<rustpython_vm::PyObjectRef> {
    Ok(match value {
        serde_json::Value::Null => vm.ctx.none(),
        serde_json::Value::Bool(b) => vm.ctx.new_bool(*b).into(),
        serde_json::Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                vm.ctx.new_int(i).into()
            } else if let Some(f) = n.as_f64() {
                vm.ctx.new_float(f).into()
            } else {
                vm.ctx.new_str(n.to_string()).into()
            }
        }
        serde_json::Value::String(s) => vm.ctx.new_str(s.clone()).into(),
        serde_json::Value::Array(arr) => {
            let items: rustpython_vm::PyResult<Vec<rustpython_vm::PyObjectRef>> =
                arr.iter().map(|v| json_to_py(v, vm)).collect();
            vm.ctx.new_list(items?).into()
        }
        serde_json::Value::Object(map) => {
            let dict = vm.ctx.new_dict();
            for (k, v) in map {
                let py_val = json_to_py(v, vm)?;
                dict.set_item(k.as_str(), py_val, vm)?;
            }
            dict.into()
        }
    })
}

// ── error formatting ─────────────────────────────────────────────────────────

fn exc_to_string(
    vm: &rustpython_vm::VirtualMachine,
    exc: &rustpython_vm::builtins::PyBaseExceptionRef,
) -> String {
    // PyRef<PyBaseException> → PyObjectRef so we can call the str() protocol.
    let obj: rustpython_vm::PyObjectRef = exc.clone().into();
    obj.str(vm)
        .map(|s| s.to_string())
        .unwrap_or_else(|_| exc.class().name().to_string())
}

// ── tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use serde_json::json;
    use std::fs;
    use std::path::Path;
    use std::time::Duration;
    use tempfile::TempDir;

    use super::run_python_validator;
    use crate::shared::validators::{FieldValidationContext, ValidationLevel};

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
        let tmp = TempDir::new().unwrap();
        // Empty list = pass (violations-only contract)
        write(
            tmp.path(),
            "validators/check.py",
            "def validate(ctx):\n    return []\n",
        );
        let result =
            run_python_validator("validators/check.py", tmp.path(), &ctx(json!("hi"))).unwrap();
        assert!(result.is_none());
    }

    #[test]
    fn invalid_result_returns_warning_with_message() {
        let tmp = TempDir::new().unwrap();
        write(
            tmp.path(),
            "validators/check.py",
            "def validate(ctx):\n    return [{'message': 'too short'}]\n",
        );
        let result = run_python_validator("validators/check.py", tmp.path(), &ctx(json!("hi")))
            .unwrap()
            .unwrap();
        assert_eq!(result.level, ValidationLevel::Warning);
        assert_eq!(result.message.as_deref(), Some("too short"));
    }

    #[test]
    fn empty_result_list_returns_none() {
        let tmp = TempDir::new().unwrap();
        write(
            tmp.path(),
            "validators/check.py",
            "def validate(ctx):\n    return []\n",
        );
        let result =
            run_python_validator("validators/check.py", tmp.path(), &ctx(json!("hi"))).unwrap();
        assert!(result.is_none());
    }

    #[test]
    fn level_error_is_preserved() {
        let tmp = TempDir::new().unwrap();
        write(
            tmp.path(),
            "validators/check.py",
            "def validate(ctx):\n    return [{'level': 'error', 'message': 'hard fail'}]\n",
        );
        let result = run_python_validator("validators/check.py", tmp.path(), &ctx(json!("hi")))
            .unwrap()
            .unwrap();
        assert_eq!(result.level, ValidationLevel::Error);
        assert_eq!(result.message.as_deref(), Some("hard fail"));
    }

    #[test]
    fn description_is_preserved() {
        let tmp = TempDir::new().unwrap();
        write(
            tmp.path(),
            "validators/check.py",
            "def validate(ctx):\n    return [{'message': 'short', 'description': 'long explanation'}]\n",
        );
        let result = run_python_validator("validators/check.py", tmp.path(), &ctx(json!("hi")))
            .unwrap()
            .unwrap();
        assert_eq!(result.message.as_deref(), Some("short"));
        assert_eq!(result.description.as_deref(), Some("long explanation"));
    }

    #[test]
    fn fixable_is_preserved() {
        let tmp = TempDir::new().unwrap();
        write(
            tmp.path(),
            "validators/check.py",
            "def validate(ctx):\n    return [{'message': 'can fix', 'fixable': True}]\n",
        );
        let result = run_python_validator("validators/check.py", tmp.path(), &ctx(json!("hi")))
            .unwrap()
            .unwrap();
        assert!(result.fixable);
    }

    #[test]
    fn first_violation_is_returned() {
        let tmp = TempDir::new().unwrap();
        write(
            tmp.path(),
            "validators/check.py",
            "def validate(ctx):\n    return [{'message': 'first'}, {'message': 'second'}]\n",
        );
        let result = run_python_validator("validators/check.py", tmp.path(), &ctx(json!("hi")))
            .unwrap()
            .unwrap();
        assert_eq!(result.level, ValidationLevel::Warning);
        assert_eq!(result.message.as_deref(), Some("first"));
    }

    #[test]
    fn ctx_fields_are_accessible_in_validator() {
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
        let result = run_python_validator("validators/check.py", tmp.path(), &c).unwrap();
        assert!(
            result.is_none(),
            "all ctx fields matched — expected no failure"
        );
    }

    #[test]
    fn real_length_validator_in_python() {
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
        let result = run_python_validator("validators/max_len.py", tmp.path(), &c)
            .unwrap()
            .unwrap();
        assert_eq!(result.level, ValidationLevel::Warning);
        assert!(result.message.as_deref().unwrap_or("").contains("chars"));
    }

    #[test]
    fn violation_without_message_key_returns_warning_no_message() {
        let tmp = TempDir::new().unwrap();
        // Item with no message key — still a valid violation
        write(
            tmp.path(),
            "validators/check.py",
            "def validate(ctx):\n    return [{}]\n",
        );
        let result = run_python_validator("validators/check.py", tmp.path(), &ctx(json!("hi")))
            .unwrap()
            .unwrap();
        assert_eq!(result.level, ValidationLevel::Warning);
        assert!(result.message.is_none());
    }

    // ── file loading errors ───────────────────────────────────────────────────

    // ── stripped builtins ─────────────────────────────────────────────────────

    #[test]
    fn dangerous_builtins_are_stripped() {
        // Every name we strip must raise NameError when the validator tries to
        // use it. Includes both the plan's baseline list and the additional
        // names we strip on top.
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

        for name in stripped {
            let tmp = TempDir::new().unwrap();
            // Reference the bare name at call time so lookup happens against
            // the stripped builtins.
            let src = format!("def validate(ctx):\n    {}\n    return []\n", name);
            write(tmp.path(), "validators/check.py", &src);
            let err = run_python_validator("validators/check.py", tmp.path(), &ctx(json!("hi")))
                .unwrap_err();
            let msg = err.to_string();
            assert!(
                msg.contains("NameError") || msg.contains("not defined"),
                "expected NameError for '{}', got: {}",
                name,
                msg
            );
            assert!(
                msg.contains(name),
                "expected error to name '{}', got: {}",
                name,
                msg
            );
        }
    }

    #[test]
    fn eval_call_is_blocked_at_runtime() {
        // The classic "compile arbitrary code at runtime" path must not work.
        let tmp = TempDir::new().unwrap();
        write(
            tmp.path(),
            "validators/evil.py",
            "def validate(ctx):\n    eval('1 + 1')\n    return []\n",
        );
        let err =
            run_python_validator("validators/evil.py", tmp.path(), &ctx(json!("hi"))).unwrap_err();
        let msg = err.to_string();
        assert!(
            msg.contains("NameError") || msg.contains("not defined"),
            "got: {}",
            msg
        );
        assert!(msg.contains("eval"), "got: {}", msg);
    }

    #[test]
    fn setattr_and_delattr_work_on_validator_locals() {
        // ctx values are JSON-deep-cloned into the VM, so mutation cannot leak
        // back to Rust state. setattr / delattr are kept available.
        let tmp = TempDir::new().unwrap();
        write(
            tmp.path(),
            "validators/mutates.py",
            r#"
def validate(ctx):
    # Functions accept arbitrary attribute assignment; verifies setattr/delattr
    # are callable without needing __build_class__.
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
        let result =
            run_python_validator("validators/mutates.py", tmp.path(), &ctx(json!("hi"))).unwrap();
        assert!(result.is_none(), "expected no violation, got: {:?}", result);
    }

    #[test]
    fn user_defined_classes_are_allowed() {
        // Validators are free to declare helper classes; __build_class__
        // stays available.
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
        let result =
            run_python_validator("validators/cls.py", tmp.path(), &ctx(json!("hi"))).unwrap();
        assert!(result.is_none(), "expected no violation, got: {:?}", result);
    }

    #[test]
    fn safe_builtins_still_work() {
        // The names a typical validator needs must survive the strip. If this
        // test ever fails, the strip list has gone too far.
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
        let result = run_python_validator(
            "validators/uses_safe_builtins.py",
            tmp.path(),
            &ctx(json!("hi")),
        )
        .unwrap();
        assert!(result.is_none(), "expected no violation, got: {:?}", result);
    }

    #[test]
    fn oversized_validator_is_rejected() {
        let tmp = TempDir::new().unwrap();
        // Syntactically valid Python, but padded past the 256 KB cap so the
        // size check rejects it before the parser ever sees it.
        let mut large = String::from("def validate(ctx):\n    return []\n# ");
        large.push_str(&"x".repeat(300 * 1024));
        write(tmp.path(), "validators/big.py", &large);
        let err =
            run_python_validator("validators/big.py", tmp.path(), &ctx(json!("hi"))).unwrap_err();
        let msg = err.to_string();
        assert!(msg.contains("too large"), "got: {}", msg);
        assert!(msg.contains("validators/big.py"), "got: {}", msg);
    }

    #[test]
    fn validator_just_under_size_limit_still_runs() {
        let tmp = TempDir::new().unwrap();
        // Stay safely under 256 KB so the runner accepts the file.
        let mut source = String::from("def validate(ctx):\n    return []\n# ");
        source.push_str(&"x".repeat(200 * 1024));
        write(tmp.path(), "validators/biggish.py", &source);
        let result =
            run_python_validator("validators/biggish.py", tmp.path(), &ctx(json!("hi"))).unwrap();
        assert!(result.is_none());
    }

    #[test]
    fn file_not_found_gives_clear_message() {
        let tmp = TempDir::new().unwrap();
        let err = run_python_validator("validators/missing.py", tmp.path(), &ctx(json!("hi")))
            .unwrap_err();
        let msg = err.to_string();
        assert!(msg.contains("python validator not found"), "got: {}", msg);
        assert!(msg.contains("validators/missing.py"), "got: {}", msg);
    }

    // ── path containment ──────────────────────────────────────────────────────

    #[test]
    fn non_py_suffix_is_rejected() {
        let tmp = TempDir::new().unwrap();
        let err = run_python_validator("validators/check.txt", tmp.path(), &ctx(json!("hi")))
            .unwrap_err();
        let msg = err.to_string();
        assert!(msg.contains("must end in .py"), "got: {}", msg);
    }

    #[test]
    fn parent_dir_traversal_is_rejected() {
        let tmp = TempDir::new().unwrap();
        let err = run_python_validator("validators/../escape.py", tmp.path(), &ctx(json!("hi")))
            .unwrap_err();
        let msg = err.to_string();
        assert!(msg.contains("must not contain '..'"), "got: {}", msg);
    }

    #[test]
    fn absolute_path_is_rejected() {
        let tmp = TempDir::new().unwrap();
        let err =
            run_python_validator("/etc/passwd.py", tmp.path(), &ctx(json!("hi"))).unwrap_err();
        let msg = err.to_string();
        assert!(
            msg.contains("must be relative") || msg.contains("absolute"),
            "got: {}",
            msg
        );
    }

    #[test]
    fn path_outside_validators_dir_is_rejected() {
        let tmp = TempDir::new().unwrap();
        // File exists but lives outside `validators/` — must still be rejected
        // before we ever read it.
        write(
            tmp.path(),
            "other/check.py",
            "def validate(ctx):\n    return []\n",
        );
        let err =
            run_python_validator("other/check.py", tmp.path(), &ctx(json!("hi"))).unwrap_err();
        let msg = err.to_string();
        assert!(msg.contains("must live under validators/"), "got: {}", msg);
    }

    // ── syntax and function errors ────────────────────────────────────────────

    #[test]
    fn syntax_error_gives_clear_message() {
        let tmp = TempDir::new().unwrap();
        write(
            tmp.path(),
            "validators/bad.py",
            "def validate(ctx\n    return []\n",
        );
        let err =
            run_python_validator("validators/bad.py", tmp.path(), &ctx(json!("hi"))).unwrap_err();
        let msg = err.to_string();
        assert!(msg.contains("syntax error"), "got: {}", msg);
    }

    #[test]
    fn missing_validate_function_gives_clear_message() {
        let tmp = TempDir::new().unwrap();
        write(tmp.path(), "validators/check.py", "x = 1\n");
        let err =
            run_python_validator("validators/check.py", tmp.path(), &ctx(json!("hi"))).unwrap_err();
        let msg = err.to_string();
        assert!(
            msg.contains("must define a top-level validate(ctx) function"),
            "got: {}",
            msg
        );
    }

    #[test]
    fn import_blocked_in_sandbox() {
        let tmp = TempDir::new().unwrap();
        write(
            tmp.path(),
            "validators/check.py",
            "import subprocess\ndef validate(ctx):\n    return []\n",
        );
        let err =
            run_python_validator("validators/check.py", tmp.path(), &ctx(json!("hi"))).unwrap_err();
        let msg = err.to_string();
        // RustPython surfaces this as "No module named 'subprocess'" when the
        // stdlib module is absent from the sandboxed interpreter.
        assert!(
            msg.contains("import")
                || msg.contains("ModuleNotFoundError")
                || msg.contains("No module named"),
            "expected import error, got: {}",
            msg
        );
    }

    // ── wrong return shape ────────────────────────────────────────────────────

    #[test]
    fn returns_none_gives_clear_message() {
        let tmp = TempDir::new().unwrap();
        write(
            tmp.path(),
            "validators/check.py",
            "def validate(ctx):\n    pass\n",
        );
        let err =
            run_python_validator("validators/check.py", tmp.path(), &ctx(json!("hi"))).unwrap_err();
        let msg = err.to_string();
        assert!(
            msg.contains("expected list") || msg.contains("NoneType"),
            "got: {}",
            msg
        );
    }

    #[test]
    fn returns_dict_not_list_gives_clear_message() {
        let tmp = TempDir::new().unwrap();
        write(
            tmp.path(),
            "validators/check.py",
            "def validate(ctx):\n    return {'is_valid': True, 'message': None}\n",
        );
        let err =
            run_python_validator("validators/check.py", tmp.path(), &ctx(json!("hi"))).unwrap_err();
        let msg = err.to_string();
        assert!(msg.contains("expected list"), "got: {}", msg);
    }

    #[test]
    fn result_with_only_message_key_is_a_valid_violation() {
        // New contract: no is_valid key needed — every item is a violation.
        let tmp = TempDir::new().unwrap();
        write(
            tmp.path(),
            "validators/check.py",
            "def validate(ctx):\n    return [{'message': 'x'}]\n",
        );
        let result = run_python_validator("validators/check.py", tmp.path(), &ctx(json!("hi")))
            .unwrap()
            .unwrap();
        assert_eq!(result.level, ValidationLevel::Warning);
        assert_eq!(result.message.as_deref(), Some("x"));
    }

    // ── runtime exceptions ────────────────────────────────────────────────────

    #[test]
    fn runtime_exception_gives_clear_message() {
        let tmp = TempDir::new().unwrap();
        write(
            tmp.path(),
            "validators/check.py",
            "def validate(ctx):\n    raise ValueError('something went wrong')\n",
        );
        let err =
            run_python_validator("validators/check.py", tmp.path(), &ctx(json!("hi"))).unwrap_err();
        let msg = err.to_string();
        assert!(msg.contains("raised"), "got: {}", msg);
    }

    // ── cooperative interrupt ─────────────────────────────────────────────────

    #[test]
    fn runaway_loop_is_interrupted_within_timeout() {
        // A pure-Python infinite loop should be cut off by the cooperative
        // interrupt within roughly TIMEOUT_SECS — well before the
        // recv_timeout backstop fires.
        let tmp = TempDir::new().unwrap();
        write(
            tmp.path(),
            "validators/spin.py",
            "def validate(ctx):\n    while True:\n        pass\n",
        );
        let start = std::time::Instant::now();
        let err =
            run_python_validator("validators/spin.py", tmp.path(), &ctx(json!("hi"))).unwrap_err();
        let elapsed = start.elapsed();
        let msg = err.to_string();
        assert!(
            msg.contains("timed out") && msg.contains("validators/spin.py"),
            "got: {}",
            msg
        );
        // Cooperative interrupt should fire close to 5s, well under the
        // backstop (5 + 2 = 7s). Allow 1s of slack for slow CI.
        assert!(
            elapsed < Duration::from_secs(8),
            "took {:?}, expected interrupt around 5s",
            elapsed
        );
    }

    #[test]
    fn validator_swallowing_keyboard_interrupt_still_reports_timeout() {
        // A malicious validator that swallows the interrupt via a bare
        // `except:` block in a tight loop should still surface as a timeout
        // (via the recv_timeout backstop) rather than running forever.
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
        let err = run_python_validator("validators/swallow.py", tmp.path(), &ctx(json!("hi")))
            .unwrap_err();
        let elapsed = start.elapsed();
        let msg = err.to_string();
        assert!(msg.contains("timed out"), "got: {}", msg);
        // First interrupt fires at ~5s, hits the bare except, gets swallowed.
        // The timeout_flag is still set so run_python_validator returns the
        // timeout error without waiting for the backstop. Should still be
        // well within the backstop window.
        assert!(elapsed < Duration::from_secs(8), "took {:?}", elapsed);
    }

    #[test]
    fn fast_validator_returns_well_before_timeout() {
        // Sanity check that the timer-thread plumbing doesn't add latency
        // to validators that complete normally.
        let tmp = TempDir::new().unwrap();
        write(
            tmp.path(),
            "validators/quick.py",
            "def validate(ctx):\n    return []\n",
        );
        let start = std::time::Instant::now();
        let result =
            run_python_validator("validators/quick.py", tmp.path(), &ctx(json!("hi"))).unwrap();
        let elapsed = start.elapsed();
        assert!(result.is_none());
        assert!(
            elapsed < Duration::from_secs(2),
            "fast validator took {:?}; timer-thread cancel may be broken",
            elapsed
        );
    }

    #[test]
    fn sys_exit_does_not_kill_process() {
        let tmp = TempDir::new().unwrap();
        write(
            tmp.path(),
            "validators/check.py",
            // sys is not importable in sandbox, so this tests the import block.
            // If sys were available, SystemExit should be caught by the VM.
            "import sys\ndef validate(ctx):\n    sys.exit(1)\n",
        );
        // Should error cleanly, not panic or kill the process.
        let result = run_python_validator("validators/check.py", tmp.path(), &ctx(json!("hi")));
        assert!(result.is_err());
    }
}
