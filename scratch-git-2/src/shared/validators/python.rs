use std::path::Path;
use std::sync::mpsc;
use std::time::Duration;

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

const TIMEOUT_SECS: u64 = 5;

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
    let validator_path = workspace_dir.join(relative_path);

    let source = std::fs::read_to_string(&validator_path).map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            anyhow::anyhow!(
                "python validator not found: {} (looked in {})",
                relative_path,
                validator_path.display()
            )
        } else {
            anyhow::anyhow!("failed to read python validator {}: {}", relative_path, e)
        }
    })?;

    // Clone context fields so the thread closure can own them.
    let filename = ctx.filename.clone();
    let field_path = ctx.field_path.clone();
    let value = ctx.value.clone();
    let record = ctx.record.clone();
    let args = ctx.args.clone();
    let script_name = relative_path.to_string();

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
        );
        let _ = tx.send(result);
    });

    let results = match rx.recv_timeout(Duration::from_secs(TIMEOUT_SECS)) {
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
) -> anyhow::Result<Vec<PythonValidationItem>> {
    use rustpython_vm as rvm;

    // Create an interpreter with no stdlib added — only Python builtins are
    // available. This prevents `import subprocess`, `import socket`, etc.
    let interp = rvm::Interpreter::with_init(Default::default(), |_vm| {});

    interp.enter(|vm| -> anyhow::Result<Vec<PythonValidationItem>> {
        let scope = vm.new_scope_with_builtins();

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

    #[test]
    fn file_not_found_gives_clear_message() {
        let tmp = TempDir::new().unwrap();
        let err = run_python_validator("validators/missing.py", tmp.path(), &ctx(json!("hi")))
            .unwrap_err();
        let msg = err.to_string();
        assert!(msg.contains("python validator not found"), "got: {}", msg);
        assert!(msg.contains("validators/missing.py"), "got: {}", msg);
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
