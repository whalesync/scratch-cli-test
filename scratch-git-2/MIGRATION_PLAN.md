# Goal: Eliminating Database State

The big picture is a migration of business logic from NestJS into Rust, and a migration of source of truth for key entities (syncs, publish plans, indices) from PostgreSQL into git-tracked files.

The motivation is threefold:
1. **Speed** — running business logic locally on the user's machine (CLI or browser via the Rust service) is orders of magnitude faster than round-tripping through the NestJS API and Postgres.
2. **Shared implementation** — the CLI and the web UI should reach identical git state. Today only the CLI can build publish plans and run syncs locally. The Rust git service needs the same capabilities so the web UI can do everything the CLI can.
3. **Simplicity** — once git is the source of truth, the NestJS layer becomes a thin executor rather than a stateful database. Several Postgres tables can be dropped entirely.

---

## Top-Level Plan

**Step 1 — Enable the CLI to perform any action (except polling and publishing) locally without talking to the database or the NestJS service.**
At this step the backend still uses the old entities and business logic. The CLI gains the ability to work fully offline for plan creation, sync execution, and validation.

**Step 2 — Port the same logic into the Rust git service so the web UI gets feature parity with the CLI.**
The git service operates on bare repos instead of local worktrees, but the core logic is identical. Once this step is complete, the web UI can do everything the CLI can, without the CLI.

**Step 3 — Drop the old duplicated code and the database tables it depended on.**
The NestJS business logic for publish plans, syncs, and indices is replaced by calls to the Rust service. The redundant Postgres tables are removed.

---

## Step-by-Step Progress

### Step 1: CLI works fully locally

- [x] **1.1** Add scratchmd instructions to CLAUDE.md and user-facing docs. _Test by: read CLAUDE.md and confirm scratchmd commands are documented._
- [x] **1.2** Run syncs locally (no transformers) — `syncs run-local`. _Test by: run `scratchmd syncs run-local` on a workspace with a sync config and verify destination files are created/updated._
- [x] **1.3** Validate sync configs locally — `syncs validate-local`. _Test by: run `scratchmd syncs validate-local` with a valid config (expect pass) and a broken one (expect error)._
- [x] **1.4** Create publish plans locally — `plan-publish`. _Test by: run `scratchmd plan-publish` on a workspace with dirty changes and confirm `plan.json` + phase dirs appear in the dirty branch._
- [x] **1.5** Job on the server to execute a publish plan stored in git (`PublishFromGitService.runFromGit`). _Test by: build a plan via CLI, trigger the publish job via the UI, and verify records are created/updated in the remote service._
- [x] **1.6** Show references in UI fed from SQLite index (not Postgres `FileIndex`). _Test by: open a file in the review panel, toggle "Show References", and confirm FK values resolve to file paths (verify no `FileIndex` Postgres query fires in server logs)._
- [x] **1.7** FileIndex calls in `PublishFromGitService` migrated to SQLite via Rust service. _Test by: run a full publish-from-git cycle (edit + create + delete + rename) and confirm the SQLite index reflects the result; no `FileIndex` table queries in server logs._
- [x] **1.8** `string_to_number` transformer in CLI sync execution. _Test by: add `{ "type": "string_to_number" }` to a field mapping in a sync config, run `syncs run-local`, and confirm the destination field is a JSON number._
- [x] **1.9** `auto_convert` transformer in CLI sync execution. _Test by: add `{ "type": "auto_convert", "targetType": "boolean" }` to a mapping, run `syncs run-local`, and confirm the destination field is `true`/`false`._
- [ ] **1.10** Custom transformer via Rhai script file. _Test by: write a simple `.rhai` script (e.g. `value * 2`), reference it in a mapping, run `syncs run-local`, and confirm the output value is doubled._
- [ ] **1.11** Publish job sends only changed fields, not all fields (use `changedFields` from plan.json). _Test by: edit one field on a record, build a plan, run the job, and confirm the remote API call contains only that one field (check connector logs or intercept the HTTP request)._

### Step 2: Rust git service has full feature parity with the CLI

- [ ] **2.1** Port `plan_publish.rs` into the Rust service as an HTTP endpoint — `POST /api/repo/:id/publish-plan/build`. _Test by: call the endpoint directly (curl or test), confirm `plan.json` + phase dirs are written to the dirty branch without running the CLI._
- [ ] **2.2** Port sync execution into the Rust service — `POST /api/repo/:id/syncs/run`. _Test by: call the endpoint with a sync config path, confirm destination files in the repo match what `syncs run-local` would produce._
- [ ] **2.3** Sync config files stored in git (`syncs/` directory) and readable by the Rust service. _Test by: commit a sync config file to the repo, call the list endpoint, and confirm it appears without any Postgres `Sync` row existing._
- [ ] **2.4** Publish plan status tracked in git instead of `PublishPlan` Postgres rows. _Test by: trigger a publish, confirm `plan-status.json` appears in the dirty branch, and confirm no `PublishPlan` row is created in Postgres._
- [ ] **2.5** Web UI two-step publish flow: "Build Plan" → review → "Run". _Test by: use the UI end-to-end — click Build Plan, review the summary, click Run, confirm records update in the remote service._
- [ ] **2.6** Web UI sync management reads/writes sync config files via git. _Test by: create a sync in the UI, confirm a JSON file is committed to the repo; delete it in the UI, confirm the file is removed — no `Sync` Postgres rows involved._

### Step 3: Drop old code and database tables

- [ ] **3.1** Remove `FileIndex` + `FileReference` Postgres tables and `FileIndexService`. _Test by: run a full publish cycle and confirm it completes without errors; run migrations and confirm the tables are gone._
- [ ] **3.2** Remove `PublishPlan` + `PublishPlanOperation` Postgres tables. _Test by: run a publish end-to-end and confirm status is read from git; run migrations and confirm the tables are gone._
- [ ] **3.3** Remove `Sync` + `SyncTablePair` Postgres tables. _Test by: create, list, run, and delete a sync via the UI; run migrations and confirm the tables are gone._
- [ ] **3.4** Remove `publish-plan-build.service.ts` and `publish-plan-run.service.ts`. _Test by: `yarn build` passes with no references to the deleted files._
- [ ] **3.5** Remove `SyncMatchKeys`, `SyncRemoteIdMapping`, `SyncForeignKeyRecord` tables. _Test by: run a sync with record matching end-to-end and confirm it works; run migrations and confirm the tables are gone._
- [ ] **3.6** Remove `ref-resolver.service.ts`. _Test by: `yarn build` passes; run a publish with pseudo-refs (`@/…`) and confirm they resolve correctly via the SQLite path._

---

## Detailed Notes

### 1.8 — `string_to_number` transformer in CLI

**What it does (NestJS reference: `string-to-number.transformer.ts`)**

Converts a string or number value to a number. Options:
- `stripCurrency: bool` — removes common currency symbols (`$€£¥…`) and thousands-separator commas before parsing
- `parseInteger: bool` — uses integer truncation instead of float parsing

**How to implement in Rust (`syncs.rs`)**

1. Extend the `FieldMapping` struct to include an optional `transformer` field:
   ```rust
   #[derive(Debug, Deserialize)]
   #[serde(rename_all = "camelCase")]
   struct FieldMapping {
       source_field: String,
       dest_field: String,
       #[serde(default)]
       transformer: Option<Transformer>,
   }

   #[derive(Debug, Deserialize)]
   #[serde(tag = "type", rename_all = "snake_case")]
   enum Transformer {
       StringToNumber(StringToNumberOptions),
       AutoConvert(AutoConvertOptions),
       Rhai(RhaiOptions),
   }

   #[derive(Debug, Deserialize, Default)]
   #[serde(rename_all = "camelCase")]
   struct StringToNumberOptions {
       #[serde(default)]
       strip_currency: bool,
       #[serde(default)]
       parse_integer: bool,
   }
   ```

2. In `run_local()`, after reading the source field value and before writing to the destination, call `apply_transformer(value, transformer)`:
   ```rust
   fn apply_string_to_number(value: &Value, opts: &StringToNumberOptions) -> Value {
       let s = match value {
           Value::Number(n) => {
               if opts.parse_integer {
                   return Value::Number(serde_json::Number::from(
                       n.as_f64().unwrap_or(0.0).trunc() as i64
                   ));
               }
               return value.clone();
           }
           Value::String(s) => s.clone(),
           Value::Null => return Value::Null,
           _ => return value.clone(), // unsupported type, pass through
       };

       let mut cleaned = s.trim().to_string();
       if opts.strip_currency {
           cleaned = cleaned
               .replace(['$', '€', '£', '¥', '₹', '₽', '₩', '₴', '₪', '฿', '₫', '₦'], "")
               .replace(',', "")
               .trim()
               .to_string();
       }
       if cleaned.is_empty() {
           return Value::Null;
       }
       if opts.parse_integer {
           if let Ok(n) = cleaned.parse::<i64>() {
               return Value::Number(n.into());
           }
       } else if let Ok(f) = cleaned.parse::<f64>() {
           if let Some(n) = serde_json::Number::from_f64(f) {
               return Value::Number(n);
           }
       }
       value.clone() // parse failed, pass through original
   }
   ```

---

### 1.9 — `auto_convert` transformer in CLI

**What it does (NestJS reference: `auto-convert.transformer.ts`)**

Generic type coercion. Requires a `targetType` option: `"string"`, `"number"`, `"integer"`, `"boolean"`, or `"array"`.

- `string`: calls `to_string()`, arrays with one element unwrap, multi-element arrays join with `", "`
- `number`/`integer`: parses string, boolean→0/1, single-element array recurses
- `boolean`: `"true"/"yes"/"1"` → true, `"false"/"no"/"0"` → false
- `array`: wraps non-array values in a one-element array

**How to implement in Rust**

Add `AutoConvert(AutoConvertOptions)` to the `Transformer` enum (see 1.8) and implement `apply_auto_convert`:

```rust
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AutoConvertOptions {
    target_type: String, // "string" | "number" | "integer" | "boolean" | "array"
}

fn apply_auto_convert(value: &Value, opts: &AutoConvertOptions) -> Value {
    if value.is_null() {
        return Value::Null;
    }
    match opts.target_type.as_str() {
        "string" => match value {
            Value::String(s) => value.clone(),
            Value::Number(n) => Value::String(n.to_string()),
            Value::Bool(b) => Value::String(b.to_string()),
            Value::Array(arr) if arr.len() == 1 => apply_auto_convert(&arr[0], opts),
            Value::Array(arr) => Value::String(
                arr.iter().map(|v| v.to_string()).collect::<Vec<_>>().join(", ")
            ),
            _ => value.clone(),
        },
        "number" | "integer" => {
            let as_f64 = match value {
                Value::Number(n) => n.as_f64(),
                Value::Bool(b) => Some(if *b { 1.0 } else { 0.0 }),
                Value::String(s) => s.trim().parse::<f64>().ok(),
                Value::Array(arr) if arr.len() == 1 => {
                    return apply_auto_convert(&arr[0], opts);
                }
                _ => None,
            };
            match as_f64 {
                Some(f) => {
                    let n = if opts.target_type == "integer" { f.trunc() } else { f };
                    serde_json::Number::from_f64(n)
                        .map(Value::Number)
                        .unwrap_or(value.clone())
                }
                None => value.clone(),
            }
        },
        "boolean" => match value {
            Value::Bool(_) => value.clone(),
            Value::Number(n) => Value::Bool(n.as_f64().unwrap_or(0.0) != 0.0),
            Value::String(s) => match s.trim().to_lowercase().as_str() {
                "true" | "yes" | "1" => Value::Bool(true),
                "false" | "no" | "0" => Value::Bool(false),
                _ => value.clone(),
            },
            _ => value.clone(),
        },
        "array" => match value {
            Value::Array(_) => value.clone(),
            _ => Value::Array(vec![value.clone()]),
        },
        _ => value.clone(),
    }
}
```

---

### 1.10 — Custom transformer via Rhai script

**What is Rhai**

[Rhai](https://rhai.rs) is a lightweight scripting language designed for embedding in Rust. Syntax is close to Rust/JavaScript. Scripts are sandboxed, have no I/O by default, and evaluate fast. The crate is `rhai`.

**Design**

A custom transformer is declared in the sync config as:
```json
{
  "sourceField": "price",
  "destField": "priceUsd",
  "transformer": {
    "type": "rhai",
    "script": "scripts/price_to_usd.rhai"
  }
}
```

The script receives the source value as a variable named `value` and returns the transformed value:
```rhai
// scripts/price_to_usd.rhai
if value == () { return (); }
let n = parse_float(value.to_string());
(n * 0.85).to_string()
```

**How to implement in Rust**

1. Add `rhai` to `Cargo.toml`:
   ```toml
   rhai = { version = "1", features = ["sync"] }
   ```

2. Add `Rhai(RhaiOptions)` to the `Transformer` enum:
   ```rust
   #[derive(Debug, Deserialize)]
   struct RhaiOptions {
       script: String, // path relative to workspace root
   }
   ```

3. Load scripts once at the start of `run_local()` (avoid re-parsing per record). Use a `HashMap<String, rhai::AST>` keyed by script path:
   ```rust
   let engine = rhai::Engine::new();
   let mut script_cache: HashMap<String, rhai::AST> = HashMap::new();

   fn get_or_compile<'a>(
       engine: &rhai::Engine,
       cache: &'a mut HashMap<String, rhai::AST>,
       script_path: &str,
       wb_dir: &Path,
   ) -> anyhow::Result<&'a rhai::AST> {
       if !cache.contains_key(script_path) {
           let full_path = wb_dir.join(script_path);
           let ast = engine.compile_file(full_path.clone())
               .map_err(|e| anyhow::anyhow!("Rhai compile error in {}: {e}", full_path.display()))?;
           cache.insert(script_path.to_string(), ast);
       }
       Ok(cache.get(script_path).unwrap())
   }
   ```

4. Evaluate per record:
   ```rust
   fn apply_rhai(engine: &rhai::Engine, ast: &rhai::AST, value: &Value) -> anyhow::Result<Value> {
       let mut scope = rhai::Scope::new();
       // Convert serde_json::Value → rhai::Dynamic
       let dynamic = json_to_dynamic(value);
       scope.push("value", dynamic);
       let result: rhai::Dynamic = engine.eval_ast_with_scope(&mut scope, ast)?;
       Ok(dynamic_to_json(result))
   }
   ```

5. Helper conversions `json_to_dynamic` / `dynamic_to_json`:
   - `Value::Null` ↔ `Dynamic::UNIT`
   - `Value::Bool` ↔ `Dynamic::from(bool)`
   - `Value::Number` ↔ `Dynamic::from(f64)`
   - `Value::String` ↔ `Dynamic::from(String)`
   - `Value::Array` ↔ `Dynamic::from(Vec<Dynamic>)` (via `rhai::Array`)
   - `Value::Object` ↔ `Dynamic::from(BTreeMap<String, Dynamic>)` (via `rhai::Map`)

**Notes**
- Scripts live in the workspace directory alongside the sync config, so they're git-tracked.
- Disable file I/O and module loading on the engine (`engine.set_max_modules(0)`, `engine.on_print(|_| {})`) to keep execution sandboxed.
- Script compile errors should fail fast at startup (before processing any records), not silently per record.

---

### 1.11 — Publish job sends only changed fields

**What needs to change**

The `plan.json` already contains a `changedFields` map (`relPath → { fieldName: value, ... }`). The publish job (`PublishFromGitService.dispatchUpdateBatch`) currently passes the full file content to `connector.updateRecords()`.

The fix:
1. Read `changedFields` from `plan.json` for each `relPath` in the `edit` phase (already loaded into `PhaseOperation.changedFields`).
2. Build a `changedKeys` array from `Object.keys(changedFields)`.
3. Pass it to `connector.updateRecords(tableSpec, contents, changedKeysArray)` — the connector already supports a sparse update via the third argument.
4. The NestJS `updateRecords` implementation already uses `changedKeys` to send only the diff to the remote API — this code path just wasn't being activated from the git publish path.

---

### 2.1 — Publish plan build endpoint in Rust service

**Current state**
- The CLI builds a `plan.json` + phase directories into the dirty git branch (`plan_publish.rs`)
- The server already reads from git to execute the plan (`PublishFromGitService.runFromGit`)
- The server still creates `PublishPlan` + `PublishPlanOperation` DB rows to track status

**What needs to change**
- New endpoint `POST /api/repo/:id/publish-plan/build` in the Rust service that ports `plan_publish.rs`: scans dirty vs master, builds `plan.json` + phase dirs, strips FK refs using the SQLite index, writes everything back to dirty.
- Status tracking moves to git: the BullMQ job writes `plan-status.json` into the dirty branch instead of updating a `PublishPlan` row.
- The publish button becomes a two-step flow: "Build Plan" → review summary → "Run".
- `PublishPlan` + `PublishPlanOperation` tables can be dropped.

**Key files**
- `scratch-git-2/src/cli/commands/plan_publish.rs` — port this logic into the Rust service
- `server/src/publish-plan/publish-from-git.service.ts` — status writing needs to move to git
- `server/src/publish-plan/publish-plan-crud.service.ts` — can be deleted

---

### 2.3 / 3.3 — Syncs: Configs to git

**Current state**
- Sync configs live in Postgres `Sync` + `SyncTablePair` tables
- The CLI can `syncs download` to export them and `syncs run-local` to execute locally

**What needs to change**
- Store each sync as a JSON file in `.scratch/workbook/syncs/` in the workbook's git repo (format matches `syncs download` output). `Sync` + `SyncTablePair` become derived, not authoritative.
- `SyncService` reads sync configs from git via the Rust service instead of Postgres.
- The execution engine (two-phase, transformers, match key caches) stays on the NestJS server — only config storage moves.
- Schedule cron expressions move into the sync config file itself (already exported in `_metadata`).
- UI sync list, create, edit, delete flows write/read git files instead of Postgres rows.
- `Sync` + `SyncTablePair` tables can be dropped once all reads/writes go through git.

**Key files**
- `server/src/sync/sync.service.ts` — replace DB reads with git-backed config loading
- `scratch-git-2/src/cli/commands/syncs.rs` — target file format
- `server/prisma/schema.prisma` lines 529–572 — `Sync` + `SyncTablePair` to remove

---

### 3.1 — Complete SQLite index migration

**Current state**
- `PublishFromGitService` is now fully migrated to SQLite — no Postgres `FileIndex` calls remain there.
- `publish-plan-run.service.ts`, `publish-plan-build.service.ts`, and `ref-resolver.service.ts` still call `FileIndexService` (old DB-backed publish path).

**What needs to change**
- Migrate `publish-plan-run.service.ts` and `publish-plan-build.service.ts` off `FileIndexService` (same pattern as the migration already done in `PublishFromGitService`).
- Migrate `ref-resolver.service.ts` off `FileIndexService.getRecordIds` — replace with a batch SQLite lookup via the Rust service.
- Replace `FileReferenceService` (writes to Postgres `FileReference`) with equivalent SQLite index updates after publish.
- Once all callers are migrated, remove `FileIndex`, `FileReference`, `FileIndexService`, and `FileReferenceService`.

**Key files**
- `server/src/publish-plan/file-index.service.ts` — remove once all callers migrated
- `server/src/publish-plan/ref-resolver.service.ts` — migrate `getRecordIds` to Rust service
- `server/src/publish-plan/file-reference.service.ts` — remove once replaced
- `server/prisma/schema.prisma` lines 447–471 — `FileIndex` + `FileReference` to remove
