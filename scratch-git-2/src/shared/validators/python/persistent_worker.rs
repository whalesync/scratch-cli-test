//! Persistent-worker backend: one long-lived RustPython interpreter on a
//! dedicated worker thread, reused across every validator invocation.
//!
//! Trades the per-call VM bootstrap (the dominant cost) for a tiny per-call
//! scope creation + an mtime-cached `compile`. All requests serialize through
//! one worker thread; correctness is preserved by always running the script
//! in a fresh scope so module-level state doesn't leak between calls.
//!
//! Timeout still works via the shared signal channel: each request spawns a
//! short-lived timer that, on expiry, pushes a KeyboardInterrupt closure into
//! the worker's signal queue. To prevent a stale timeout firing on a *later*
//! job that happens to be running when the closure is finally processed, each
//! job carries a monotonically increasing id and the closure no-ops when the
//! worker has moved on to a different job.
//!
//! ## Known limitation
//!
//! A validator that catches `KeyboardInterrupt` in a bare `except:` clause
//! inside an infinite loop permanently wedges the worker. The caller still
//! returns a timeout error via the recv backstop, but every subsequent
//! validator call queues behind the stuck job and also times out at the
//! backstop. The per-invocation backend doesn't share this problem because
//! each call owns a private VM and thread that we abandon on timeout.
//!
//! Mitigation if this is ever observed in real use: introduce a scrap-and-
//! replace handle (swap in a fresh worker when the backstop fires, leak the
//! old thread). Not implemented today — validators are typically short pure
//! functions, and the legacy `per_invocation` backend remains a one-env-var
//! fallback.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{mpsc, Arc, OnceLock};
use std::time::{Duration, UNIX_EPOCH};

use rustpython_vm as rvm;
use rustpython_vm::signal::{self, UserSignalSender};

use super::super::{FieldValidationContext, ValidationResult};
use super::shared::{
    build_ctx_dict, exc_to_string, extract_results, first_violation_into_result,
    resolve_validator_path, PythonValidationItem, MAX_VALIDATOR_BYTES, STRIPPED_BUILTINS,
    TIMEOUT_BACKSTOP_BUFFER_SECS, TIMEOUT_SECS,
};

// ── worker handle ────────────────────────────────────────────────────────────

struct WorkerState {
    job_tx: mpsc::Sender<Job>,
    signal_tx: UserSignalSender,
    /// The id of the job the worker is currently executing (or last executed).
    /// Used by timer closures to no-op when their target job has already moved
    /// on, so a stale timeout doesn't interrupt an unrelated later job.
    current_job: Arc<AtomicU64>,
    next_job_id: AtomicU64,
}

fn state() -> &'static WorkerState {
    static STATE: OnceLock<WorkerState> = OnceLock::new();
    STATE.get_or_init(spawn_worker)
}

fn spawn_worker() -> WorkerState {
    let (signal_tx, signal_rx) = signal::user_signal_channel();
    let (job_tx, job_rx) = mpsc::channel::<Job>();
    let current_job = Arc::new(AtomicU64::new(u64::MAX));
    let current_job_for_worker = Arc::clone(&current_job);

    std::thread::Builder::new()
        .name("py-validator-worker".into())
        .spawn(move || worker_loop(job_rx, signal_rx, current_job_for_worker))
        .expect("spawn python validator worker thread");

    WorkerState {
        job_tx,
        signal_tx,
        current_job,
        next_job_id: AtomicU64::new(0),
    }
}

// ── worker thread ────────────────────────────────────────────────────────────

struct Job {
    id: u64,
    source: String,
    mtime_ns: i64,
    path: PathBuf,
    script_name: String,
    filename: String,
    field_path: String,
    value: serde_json::Value,
    record: serde_json::Value,
    args: serde_json::Value,
    response_tx: mpsc::Sender<anyhow::Result<Vec<PythonValidationItem>>>,
}

fn worker_loop(
    job_rx: mpsc::Receiver<Job>,
    signal_rx: signal::UserSignalReceiver,
    current_job: Arc<AtomicU64>,
) {
    let interp = rvm::Interpreter::with_init(Default::default(), move |vm| {
        vm.set_user_signal_channel(signal_rx);
    });

    interp.enter(|vm| {
        // Strip dangerous builtins once for the lifetime of the interpreter.
        let builtins_dict = vm.builtins.dict();
        for name in STRIPPED_BUILTINS {
            let _ = builtins_dict.del_item(*name, vm);
        }

        // mtime-keyed compiled-code cache. Owned by the worker thread, so no
        // locking — only one job runs at a time inside this loop.
        let mut code_cache: HashMap<PathBuf, (i64, rvm::PyRef<rvm::builtins::PyCode>)> =
            HashMap::new();

        while let Ok(job) = job_rx.recv() {
            current_job.store(job.id, Ordering::SeqCst);
            let result = run_job(vm, &mut code_cache, &job);
            let _ = job.response_tx.send(result);
        }
    });
}

fn run_job(
    vm: &rvm::VirtualMachine,
    code_cache: &mut HashMap<PathBuf, (i64, rvm::PyRef<rvm::builtins::PyCode>)>,
    job: &Job,
) -> anyhow::Result<Vec<PythonValidationItem>> {
    let code = match code_cache.get(&job.path) {
        Some((cached_mtime, code)) if *cached_mtime == job.mtime_ns => code.clone(),
        _ => {
            let code = vm
                .compile(
                    &job.source,
                    rvm::compiler::Mode::Exec,
                    job.script_name.clone(),
                )
                .map_err(|e| {
                    anyhow::anyhow!(
                        "python validator {} has a syntax error: {}",
                        job.script_name,
                        e
                    )
                })?;
            code_cache.insert(job.path.clone(), (job.mtime_ns, code.clone()));
            code
        }
    };

    // Fresh scope each call so module-level defs / globals don't leak between
    // validator invocations.
    let scope = vm.new_scope_with_builtins();

    vm.run_code_obj(code, scope.clone()).map_err(|exc| {
        let msg = exc_to_string(vm, &exc);
        if msg.contains("ModuleNotFoundError") || msg.contains("ImportError") {
            anyhow::anyhow!(
                "python validator {} failed to import a module: {} \
                 (only Python builtins are available in the validator sandbox)",
                job.script_name,
                msg
            )
        } else {
            anyhow::anyhow!("python validator {} raised {}", job.script_name, msg)
        }
    })?;

    let validate_fn = scope.globals.get_item("validate", vm).map_err(|_| {
        anyhow::anyhow!(
            "python validator {} must define a top-level validate(ctx) function",
            job.script_name
        )
    })?;

    let ctx_dict = build_ctx_dict(
        vm,
        &job.script_name,
        &job.filename,
        &job.field_path,
        &job.value,
        &job.record,
        &job.args,
    )?;

    let result_obj = validate_fn
        .call((rvm::PyObjectRef::from(ctx_dict),), vm)
        .map_err(|exc| {
            anyhow::anyhow!(
                "python validator {} raised {}",
                job.script_name,
                exc_to_string(vm, &exc)
            )
        })?;

    extract_results(result_obj, &job.script_name, vm)
}

// ── public entry point ───────────────────────────────────────────────────────

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

    let mtime_ns = metadata
        .modified()
        .ok()
        .and_then(|m| m.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_nanos() as i64)
        .unwrap_or(0);

    let source = std::fs::read_to_string(&validator_path)
        .map_err(|e| anyhow::anyhow!("failed to read python validator {}: {}", relative_path, e))?;

    let state = state();
    let job_id = state.next_job_id.fetch_add(1, Ordering::SeqCst);

    // Cooperative timeout: short-lived timer pushes a KeyboardInterrupt
    // closure into the worker's shared signal channel. The closure no-ops
    // when the worker has moved on (current_job != captured id), so a late-
    // firing timer from job N doesn't interrupt job N+1.
    let timeout_flag = Arc::new(AtomicBool::new(false));
    let (cancel_tx, cancel_rx) = mpsc::channel::<()>();
    {
        let timeout_flag = Arc::clone(&timeout_flag);
        let signal_tx = state.signal_tx.clone();
        let current_job = Arc::clone(&state.current_job);
        std::thread::spawn(move || {
            if let Err(mpsc::RecvTimeoutError::Timeout) =
                cancel_rx.recv_timeout(Duration::from_secs(TIMEOUT_SECS))
            {
                timeout_flag.store(true, Ordering::Release);
                let captured = job_id;
                let _ = signal_tx.send(Box::new(move |vm: &rvm::VirtualMachine| {
                    if current_job.load(Ordering::SeqCst) != captured {
                        return Ok(());
                    }
                    let exc_type = vm.ctx.exceptions.keyboard_interrupt.to_owned();
                    Err(vm.new_exception_msg(exc_type, "validator exceeded timeout".into()))
                }));
            }
        });
    }

    let (response_tx, response_rx) = mpsc::channel::<anyhow::Result<Vec<PythonValidationItem>>>();
    let job = Job {
        id: job_id,
        source,
        mtime_ns,
        path: validator_path,
        script_name: relative_path.to_string(),
        filename: ctx.filename.clone(),
        field_path: ctx.field_path.clone(),
        value: ctx.value.clone(),
        record: ctx.record.clone(),
        args: ctx.args.clone(),
        response_tx,
    };
    state
        .job_tx
        .send(job)
        .map_err(|_| anyhow::anyhow!("python validator worker thread is not running"))?;

    let backstop = Duration::from_secs(TIMEOUT_SECS + TIMEOUT_BACKSTOP_BUFFER_SECS);
    let recv_result = response_rx.recv_timeout(backstop);
    // Wake the timer so it doesn't sit on its sleep if we returned fast.
    let _ = cancel_tx.send(());

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
