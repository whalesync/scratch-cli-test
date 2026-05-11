# Harden the scratchmd Python Validator Sandbox

**Date**: 2026-05-11
**Author**: Chris Hoefgen
**Status**: Partially implemented — steps 1-4 shipped (path containment, size cap, builtin strip, cooperative interrupt). Steps 5-6 (kill-switch flag/env-var) deferred. See implementation table for per-step status.
**Scope**: [scratch-git-2/src/shared/validators/](../../../scratch-git-2/src/shared/validators/) — Python validator runner, dispatcher, and config loader

## Goal

Reduce the blast radius of a malicious or buggy Python validator script running inside `scratchmd`. Validator entries live in `validation.json` files committed to a workbook's git repo, so anyone with write access to that repo (or anyone who can land a PR in a synced upstream) can ship code that auto-executes on every contributor's next pull / index run. The current sandbox blocks the obvious imports but has real gaps: path traversal is unrestricted, the 5 s timeout doesn't actually stop a runaway thread, there is no memory cap, and dangerous Python builtins (`eval`, `exec`, `__import__`, `compile`) are still exposed inside the validator scope.

## Background — current sandbox state

The Python engine is **RustPython 0.5.0 embedded as a library** ([scratch-git-2/Cargo.toml:43](../../../scratch-git-2/Cargo.toml#L43)), built with `default-features = false, features = ["compiler"]` so no Python stdlib modules are linked in. Execution lives in [scratch-git-2/src/shared/validators/python.rs](../../../scratch-git-2/src/shared/validators/python.rs). Validators are referenced as `"python:<relative_path>"` entries in `validation.json` files committed under `.scratch/workspace/` ([mod.rs:431-490](../../../scratch-git-2/src/shared/validators/mod.rs#L431-L490)) and dispatched at [mod.rs:794-810](../../../scratch-git-2/src/shared/validators/mod.rs#L794-L810). They auto-run during `scratchmd` index, files, and validate-record commands.

### What is already locked down

- No stdlib → `import os/socket/subprocess/sys` all fail with `ModuleNotFoundError` ([python.rs:624-644](../../../scratch-git-2/src/shared/validators/python.rs#L624-L644) test).
- 5-second wall-clock cap via `mpsc::recv_timeout` ([python.rs:89-104](../../../scratch-git-2/src/shared/validators/python.rs#L89-L104)).
- Inputs are inert JSON-derived dicts; the script gets no handles to Rust-side objects.
- Worker runs on a `std::thread`, so a panic or `SystemExit`-like crash does not kill the CLI ([python.rs:76-87](../../../scratch-git-2/src/shared/validators/python.rs#L76-L87)).

### Gaps a malicious validator can exploit today

1. **Path traversal — unmitigated.** [python.rs:52](../../../scratch-git-2/src/shared/validators/python.rs#L52) does `workspace_dir.join(relative_path)` with no canonicalization or containment check. An entry like `"python:../../../home/user/.ssh/anything.py"` will read and try to compile any file on disk. Disclosure is limited to syntax-error messages, but it's a clear policy violation.
2. **Timeout doesn't actually stop the thread.** `recv_timeout` just stops _waiting_ — the worker keeps running the Python loop until it finishes naturally. A `while True: pass` validator leaks one CPU-bound thread per invocation; in a batch run that's an unbounded fan-out.
3. **No memory cap.** Within 5 s a script can `[0]*10_000_000` its way into a multi-GB allocation. There is no rlimit, no allocator hook.
4. **Dangerous builtins still exposed.** Even without stdlib, `__builtins__` includes `eval`, `exec`, `compile`, `__import__`, `getattr`, `type`, `__build_class__`, `globals`. The standard RustPython sandbox-escape patterns (`().__class__.__bases__[0].__subclasses__()` etc.) work against this scope; RustPython is not hardened against this the way CPython's RestrictedPython is.
5. **Auto-execution from git-tracked content.** Anyone who can land a commit in the workbook repo can ship a validator that runs on every contributor's next pull. No allowlist, no hash pinning, no user prompt before a new or changed validator runs.
6. **Unbounded script size.** [python.rs:54](../../../scratch-git-2/src/shared/validators/python.rs#L54) reads the whole file with `fs::read_to_string` — a 2 GB `.py` will OOM the CLI before sandboxing matters.

## Design decisions

### D1. Path containment is mandatory; validators live under `validators/`

`run_python_validator` will canonicalize the joined path, require it `starts_with(canonical_workspace_dir.join("validators"))`, require a `.py` suffix, and reject any component containing `..` before touching the filesystem. Anchoring under a fixed `validators/` subdirectory (rather than the whole workspace) prevents a validation.json from pointing at arbitrary `.py` files that happened to land in the repo for unrelated reasons.

### D2. Strip dangerous builtins from the validator scope

In `exec_in_vm`, after building the scope, walk this `Interpreter`'s `vm.builtins.dict()` and delete each name in the list below. Each `Interpreter` gets its own builtins module, so the mutation is scoped to a single validator invocation. This is defense-in-depth — it doesn't close every RustPython escape (notably `().__class__.__bases__[0].__subclasses__()` still works via attribute traversal), but it removes the obvious dynamic-code, IO, scope-introspection, and reconnaissance vectors, and shrinks the surface for future interpreter bugs. `getattr` / `type` stay because they have legitimate uses; the residual risk is documented.

#### Why each stripped builtin is bad

**Dynamic code execution / module loading**

- `eval` — runs an arbitrary Python expression from a string. Direct way to take a value the validator already received and turn it into code.
- `exec` — same as `eval` but for multi-line statements; strictly broader.
- `compile` — produces a code object from a string. Even with `eval` / `exec` removed, a code object could be smuggled to another consumer (e.g. a function called with `**kwargs`) that runs it.
- `__import__` — the low-level primitive behind `import X`. Bypasses the `import` statement and pulls in `subprocess` / `os` directly if any stdlib module ever gets linked in.
- `__loader__`, `__spec__`, `__package__` — module metadata. `__spec__.loader` typically references something with an `exec_module` callable; a useful pivot in escape chains.

**Filesystem / interactive IO**

- `open` — file I/O. Reads / writes any file the host process can. Non-functional in our current build (no `host_env` cargo feature) but stripped defensively so a future feature flip doesn't silently widen the sandbox. If validators ever genuinely need disk reads, prefer pre-loading the contents into `ctx['args']` on the Rust side rather than reopening this.
- `input` — reads from stdin. Not exploitable by itself but unwanted in a batch CLI where the runner may pipe untrusted data through.

**Scope introspection**

- `globals` — returns the calling module's globals dict. Enumerates names, mutates state, and reaches references to objects that lead to escapes.
- `locals` — returns the current frame's locals. Same hazard, narrower scope.
- `vars` — returns `__dict__` of an object, including modules. Pulls back attribute dicts that may contain dangerous references.

**REPL / interactive helpers**

- `breakpoint` — calls `sys.breakpointhook`, which by default runs `pdb.set_trace`. `pdb` itself imports a lot of stdlib and offers an interactive `exec`-equivalent shell.
- `help` — interactive help system. `help('os')` lazily imports the requested module — an import-bypass on a sandbox that blocks the `import` statement.
- `exit` / `quit` — raise `SystemExit` to terminate the interpreter. Sandbox-bypass risk is low (we already catch panics) but removing them keeps validator semantics clean and removes a confusing way to "succeed".
- `copyright` / `credits` / `license` — `site.py` REPL banners. No security value, but they're noise in the namespace and consistent to remove with the other REPL helpers.

**Reconnaissance / low-level**

- `dir` — lists an object's attributes. Standard reconnaissance step when probing for an escape path; removing it makes the runtime less self-describing to a malicious script.
- `memoryview` — exposes the raw buffer of objects that support the buffer protocol. Combined with a buggy `bytearray` or extension type, this is a path to read / write process memory directly.

### D3. Bound the validator source size before reading it

Stat the file first; refuse anything over 256 KB with a clear error. Cheap, removes the trivial OOM path, and 256 KB of `.py` is already vastly more than any reasonable validator should need.

### D4. Make the timeout actually stop work — cooperative interrupt now, subprocess later

Two-phase fix:

- **Phase 1 (this plan): cooperative interrupt.** Install a RustPython trace hook that checks an `Arc<AtomicBool>` flag periodically and raises a Python exception when the timer expires. Tight loops in pure Python will be interrupted within a few opcodes; loops that spend all their time inside a Rust-implemented builtin won't be, but the existing 5 s wall is at least no longer a _lie_ for the common case.
- **Phase 2 (separate plan): subprocess worker.** Re-exec `scratchmd __validator_worker` over stdin/stdout JSON. The OS can then enforce `RLIMIT_CPU`, `RLIMIT_AS`, `RLIMIT_NOFILE`, `RLIMIT_FSIZE`, and on Linux a seccomp filter restricted to `read`/`write`/`exit_group`. This is the only path that gives durable defense against RustPython sandbox-escape bugs and against allocation-based DoS. Tracked as a follow-up, not in this plan's scope because of the larger surface area (IPC protocol, packaging, Windows AppContainer story).

Phase 1 lands the interrupt; phase 2 is the real isolation story.

### D5. Defer: validator approval / hash pinning

A committed `validators.lock` recording the SHA-256 of each approved script, plus a `scratchmd validators trust <path>` command to update it, is the right answer for stopping drive-by-commit attacks. Not included in this plan — it interacts with workbook sync UX (what happens on a freshly cloned workbook? on a CI runner?) and deserves its own design pass. Flagged here so it's not lost.

## Implementation

Each step is a self-contained change that should land independently.

| Step | Status     | File                                                                                                                                                                               | What changes                                                                                                                                                                                                                                                                                                              |
| ---- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | ✅ shipped | [scratch-git-2/src/shared/validators/python.rs](../../../scratch-git-2/src/shared/validators/python.rs)                                                                               | Add `resolve_validator_path` that canonicalizes `workspace_dir.join("validators").join(relative_path)`, rejects `..` components and non-`.py` suffixes, requires `starts_with(canonical_validators_dir)`. Call it before `fs::read_to_string`.                                                                            |
| 2    | ✅ shipped | [scratch-git-2/src/shared/validators/python.rs](../../../scratch-git-2/src/shared/validators/python.rs)                                                                               | Stat the resolved path; refuse files larger than 256 KB with a clear "validator source too large" error. New const `MAX_VALIDATOR_BYTES`.                                                                                                                                                                                 |
| 3    | ✅ shipped | [scratch-git-2/src/shared/validators/python.rs](../../../scratch-git-2/src/shared/validators/python.rs)                                                                               | In `exec_in_vm`, after building the scope, delete `eval`, `exec`, `compile`, `__import__`, `open`, `globals`, `locals`, `vars`, `breakpoint`, `input`, `help`, `__loader__`, `__build_class__` from `scope.globals['__builtins__']` (or the equivalent RustPython API). Add a test that confirms each is now unavailable. |
| 4    | ✅ shipped | [scratch-git-2/src/shared/validators/python.rs](../../../scratch-git-2/src/shared/validators/python.rs)                                                                               | Install a tracing/interrupt hook driven by an `Arc<AtomicBool>` set by a parallel timer thread. When set, the hook raises a Python exception (`KeyboardInterrupt` equivalent) that propagates back to the main caller as a "validator exceeded 5 s" error. Existing `recv_timeout` stays as a backstop. *Implemented via `rustpython_vm::signal::user_signal_channel` + `vm.set_user_signal_channel`, which routes through the VM's existing `check_signals()` mechanism in the bytecode loop.* |
| 5    | ❌ deferred | [scratch-git-2/src/shared/validators/mod.rs](../../../scratch-git-2/src/shared/validators/mod.rs)                                                                                     | Plumb a `python_validators_disabled: bool` flag through `run_validations` / `run_validators_dry`. When true, skip `dispatch_validator` calls with a `python:` prefix and emit a single info-level result per skipped entry.                                                                                               |
| 6    | ❌ deferred | [scratch-git-2/src/cli/commands/index.rs](../../../scratch-git-2/src/cli/commands/index.rs), [scratch-git-2/src/cli/commands/files.rs](../../../scratch-git-2/src/cli/commands/files.rs) | Read `SCRATCH_DISABLE_PYTHON_VALIDATORS` env var and a new `--no-python-validators` clap flag; pass into `run_validations`.                                                                                                                                                                                               |
| 7    | ⚠️ partial | Tests in [scratch-git-2/src/shared/validators/python.rs](../../../scratch-git-2/src/shared/validators/python.rs)                                                                      | Add tests for: path-traversal rejection (`../foo.py`, absolute path, non-`.py` suffix, file outside `validators/`), size limit, each stripped builtin raising `NameError`, runaway-loop interrupt firing within ~5 s with a Python error (not just a `recv_timeout`), kill-switch flag/env-var short-circuit. *Tests for steps 1-4 landed; kill-switch tests deferred with steps 5-6.* |

### Out of scope for this plan

- Subprocess worker / OS-level resource limits (D4 phase 2) — separate plan.
- Validator allow-list with SHA pinning (D6) — separate plan.
- Replacing RustPython with a smaller DSL — long-term consideration only.

## Acceptance criteria

- A validator at `validators/foo.py` with `validation.json` entry `"python:foo.py"` still works end-to-end.
- A `"python:../../etc/passwd.py"` entry produces a clear "path escapes validators/" error and never touches the file.
- `import os` (and friends) still fail; `eval("1+1")` inside a validator now also fails with `NameError`.
- A `while True: pass` validator returns a "validator exceeded 5 s" error within ~5 s and the worker thread does not survive past that.
- A 1 MB validator source is rejected before parse.
- `SCRATCH_DISABLE_PYTHON_VALIDATORS=1 scratchmd ...` runs to completion without invoking any Python.
- All new behaviors covered by tests in `python.rs`; `cargo test` and `cargo fmt` both pass.

## Risks

- **Cooperative interrupt has gaps.** A loop spending all its time inside a Rust-implemented builtin (e.g. a giant `sorted(huge_list)`) won't see the trace hook. Phase 2 (subprocess + rlimit) is the actual fix; this plan documents the residual risk.
- **Builtin removal may break existing validators.** We do not currently know what's deployed in real workbooks — before merge, grep checked-in `validators/*.py` across known workbook repos for `eval(`/`exec(`/`compile(`/`__import__`/`open(` and confirm no legitimate usage. If there is, scope down the strip list and document why.
- **RustPython API surface for trace hooks.** RustPython 0.5.0's interrupt story is less polished than CPython's. May require a small upstream-style patch to the existing `rustpython-vm-patched` fork — acceptable since we already maintain it. Worth a one-day spike before committing to step 4.
