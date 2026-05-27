//! Legacy backend: one fresh RustPython interpreter per validator invocation.
//!
//! This is the original implementation kept on disk as a known-good revert
//! target. Selected when `SCRATCH_PY_BACKEND=per_invocation` (or when the
//! default in `mod.rs` points here).

use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::Arc;
use std::time::Duration;

use rustpython_vm as rvm;
use rustpython_vm::signal::{self, UserSignalReceiver};

use super::super::{FieldValidationContext, ValidationResult};
use super::shared::{
    build_ctx_dict, exc_to_string, extract_results, first_violation_into_result,
    resolve_validator_path, PythonValidationItem, MAX_VALIDATOR_BYTES, STRIPPED_BUILTINS,
    TIMEOUT_BACKSTOP_BUFFER_SECS, TIMEOUT_SECS,
};

pub(super) fn run(
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
                let _ = signal_tx.send(Box::new(|vm: &rvm::VirtualMachine| {
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
        let _ = cancel_tx.send(());
        let _ = tx.send(result);
    });

    let backstop = Duration::from_secs(TIMEOUT_SECS + TIMEOUT_BACKSTOP_BUFFER_SECS);
    let recv_result = rx.recv_timeout(backstop);

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

    Ok(first_violation_into_result(results))
}

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
    // Create an interpreter with no stdlib added — only Python builtins are
    // available. This prevents `import subprocess`, `import socket`, etc.
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

        let code = vm
            .compile(source, rvm::compiler::Mode::Exec, script_name.to_owned())
            .map_err(|e| {
                anyhow::anyhow!("python validator {} has a syntax error: {}", script_name, e)
            })?;

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

        let validate_fn = scope.globals.get_item("validate", vm).map_err(|_| {
            anyhow::anyhow!(
                "python validator {} must define a top-level validate(ctx) function",
                script_name
            )
        })?;

        let ctx_dict = build_ctx_dict(vm, script_name, filename, field_path, value, record, args)?;

        let result_obj = validate_fn
            .call((rvm::PyObjectRef::from(ctx_dict),), vm)
            .map_err(|exc| {
                anyhow::anyhow!(
                    "python validator {} raised {}",
                    script_name,
                    exc_to_string(vm, &exc)
                )
            })?;

        extract_results(result_obj, script_name, vm)
    })
}
