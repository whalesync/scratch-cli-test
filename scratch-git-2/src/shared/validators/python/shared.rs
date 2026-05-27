use std::path::{Component, Path, PathBuf};

use rustpython_vm as rvm;
use rustpython_vm::AsObject;

use super::super::{ValidationLevel, ValidationResult};

// ── public constants ─────────────────────────────────────────────────────────

pub(super) const TIMEOUT_SECS: u64 = 5;
/// Extra wall-clock budget given to `mpsc::recv_timeout` on top of `TIMEOUT_SECS`
/// so the cooperative-interrupt path has time to raise the Python exception,
/// unwind frames, and send the result back to the main thread before the
/// backstop fires.
pub(super) const TIMEOUT_BACKSTOP_BUFFER_SECS: u64 = 2;
pub(super) const MAX_VALIDATOR_BYTES: u64 = 256 * 1024;

// Names removed from the validator's `__builtins__` to reduce sandbox-escape
// surface. See `per_invocation.rs` for the full rationale on each entry.
pub(super) const STRIPPED_BUILTINS: &[&str] = &[
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

pub(super) type PythonValidationItem = (ValidationLevel, Option<String>, Option<String>, bool);

// ── path resolution ──────────────────────────────────────────────────────────

/// Resolve a validator's relative path against `workspace_dir`, rejecting any
/// path that escapes the workbook's `validators/` directory or that doesn't
/// look like a Python source file. Lexical checks only — no filesystem access.
pub(super) fn resolve_validator_path(
    workspace_dir: &Path,
    relative_path: &str,
) -> anyhow::Result<PathBuf> {
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

// ── level parsing ────────────────────────────────────────────────────────────

pub(super) fn parse_level(s: &str) -> ValidationLevel {
    if s == "error" {
        ValidationLevel::Error
    } else {
        ValidationLevel::Warning
    }
}

// ── results extraction ───────────────────────────────────────────────────────

pub(super) fn extract_results(
    result_obj: rvm::PyObjectRef,
    script_name: &str,
    vm: &rvm::VirtualMachine,
) -> anyhow::Result<Vec<PythonValidationItem>> {
    use rvm::builtins::{PyDict, PyList};

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
        let dict = item.clone().downcast::<PyDict>().map_err(|obj| {
            anyhow::anyhow!(
                "python validator {} returned item at index {} as {}: expected dict",
                script_name,
                i,
                obj.class().name()
            )
        })?;

        let level = match dict.get_item_opt("level", vm).map_err(|exc| {
            anyhow::anyhow!(
                "python validator {} failed reading 'level' at index {}: {}",
                script_name,
                i,
                exc_to_string(vm, &exc)
            )
        })? {
            Some(level_obj) if !vm.is_none(&level_obj) => {
                let s = obj_to_string(vm, &level_obj, script_name, i, "level")?;
                parse_level(&s)
            }
            _ => ValidationLevel::Warning,
        };

        let message = match dict.get_item_opt("message", vm).map_err(|exc| {
            anyhow::anyhow!(
                "python validator {} failed reading 'message' at index {}: {}",
                script_name,
                i,
                exc_to_string(vm, &exc)
            )
        })? {
            Some(msg_obj) if !vm.is_none(&msg_obj) => {
                Some(obj_to_string(vm, &msg_obj, script_name, i, "message")?)
            }
            _ => None,
        };

        let description = match dict.get_item_opt("description", vm).map_err(|exc| {
            anyhow::anyhow!(
                "python validator {} failed reading 'description' at index {}: {}",
                script_name,
                i,
                exc_to_string(vm, &exc)
            )
        })? {
            Some(desc_obj) if !vm.is_none(&desc_obj) => {
                Some(obj_to_string(vm, &desc_obj, script_name, i, "description")?)
            }
            _ => None,
        };

        let fixable = match dict.get_item_opt("fixable", vm).map_err(|exc| {
            anyhow::anyhow!(
                "python validator {} failed reading 'fixable' at index {}: {}",
                script_name,
                i,
                exc_to_string(vm, &exc)
            )
        })? {
            Some(fixable_obj) if !vm.is_none(&fixable_obj) => {
                obj_to_bool(vm, &fixable_obj, script_name, i, "fixable")?
            }
            _ => false,
        };

        out.push((level, message, description, fixable));
    }

    Ok(out)
}

pub(super) fn first_violation_into_result(
    items: Vec<PythonValidationItem>,
) -> Option<ValidationResult> {
    items
        .into_iter()
        .next()
        .map(|(level, message, description, fixable)| ValidationResult {
            level,
            message,
            description,
            fixable,
        })
}

fn obj_to_string(
    vm: &rvm::VirtualMachine,
    obj: &rvm::PyObjectRef,
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
    vm: &rvm::VirtualMachine,
    obj: &rvm::PyObjectRef,
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

// ── ctx dict construction ────────────────────────────────────────────────────

pub(super) fn build_ctx_dict(
    vm: &rvm::VirtualMachine,
    script_name: &str,
    filename: &str,
    field_path: &str,
    value: &serde_json::Value,
    record: &serde_json::Value,
    args: &serde_json::Value,
) -> anyhow::Result<rvm::builtins::PyDictRef> {
    let ctx_dict = vm.ctx.new_dict();
    dict_set_str(&ctx_dict, "filename", filename, vm, script_name)?;
    dict_set_str(&ctx_dict, "field_path", field_path, vm, script_name)?;
    dict_set_json(&ctx_dict, "value", value, vm, script_name)?;
    dict_set_json(&ctx_dict, "record", record, vm, script_name)?;
    dict_set_json(&ctx_dict, "args", args, vm, script_name)?;
    Ok(ctx_dict)
}

fn dict_set_str(
    dict: &rvm::builtins::PyDictRef,
    key: &str,
    val: &str,
    vm: &rvm::VirtualMachine,
    script_name: &str,
) -> anyhow::Result<()> {
    let py_val: rvm::PyObjectRef = vm.ctx.new_str(val).into();
    dict.set_item(key, py_val, vm).map_err(|e| {
        anyhow::anyhow!(
            "ctx build error in {}: {}",
            script_name,
            exc_to_string(vm, &e)
        )
    })
}

fn dict_set_json(
    dict: &rvm::builtins::PyDictRef,
    key: &str,
    val: &serde_json::Value,
    vm: &rvm::VirtualMachine,
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

fn json_to_py(
    value: &serde_json::Value,
    vm: &rvm::VirtualMachine,
) -> rvm::PyResult<rvm::PyObjectRef> {
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
            let items: rvm::PyResult<Vec<rvm::PyObjectRef>> =
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

pub(super) fn exc_to_string(
    vm: &rvm::VirtualMachine,
    exc: &rvm::builtins::PyBaseExceptionRef,
) -> String {
    let obj: rvm::PyObjectRef = exc.clone().into();
    obj.str(vm)
        .map(|s| s.to_string())
        .unwrap_or_else(|_| exc.class().name().to_string())
}
