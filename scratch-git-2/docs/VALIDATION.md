# Validation System

Record-level validation for the `scratchmd` CLI. Validators run during
`refresh-record-index` and write results to the `validation_results_v1`
SQLite table. The desktop app reads results from that table — it never
computes violations itself.

## How it works

1. Each table can have a `validation.json` file alongside its records.
2. `refresh-record-index` loads every `validation.json` it finds, runs the
   configured validators against each record, and writes the violations to the
   database. Passing records produce **no rows** — the table stores violations
   only.
3. The desktop app calls `get-validation-results` / `get-folder-validation-results`
   to read the cached results and display them in the UI.

## `validation.json` format

Place `validation.json` next to the record files for a table:

```
<connection>/<table>/
├── record-1.json
├── record-2.json
└── validation.json      ← validator config for this table
```

`validation.json` is an array of validator entries:

```json
[
  {
    "validator": "length",
    "field": "title",
    "params": { "max": 100 }
  },
  {
    "validator": "enforce_schema"
  },
  {
    "validator": "python:validators/check_name.py",
    "field": "name",
    "params": { "custom_arg": "value" },
    "note": "Optional human-readable annotation"
  }
]
```

### Entry fields

| Field | Type | Required | Description |
|---|---|---|---|
| `validator` | `string` | yes | Validator kind. Built-in name or `python:<path>`. |
| `field` | `string` | no | Single field path to validate. Mutually exclusive with `fields`. |
| `fields` | `string[]` | no | Multiple fields (multi-field validators, not yet implemented). |
| `params` | `object` | no | Arguments passed to the validator. Defaults to `{}`. |
| `order` | `number` | no | Execution order (ascending). Ties keep file order. |
| `note` | `string` | no | Free-text annotation; not used at runtime. |

If neither `field` nor `fields` is set, the entry is **record-scoped** and
the validator receives the full record (used by `enforce_schema`).

---

## Built-in validators

### `length`

Validates the character length of a field's string value.
Non-string values are coerced to their JSON representation before measuring.

```json
{ "validator": "length", "field": "title", "params": { "min": 1, "max": 100 } }
```

**Params:**

| Param | Type | Description |
|---|---|---|
| `min` | `number` | Minimum character count (inclusive). |
| `max` | `number` | Maximum character count (inclusive). |

At least one of `min` / `max` must be present. Emits a `warning` on failure.

Alias: `max_length` (identical behaviour).

---

### `enforce_schema`

Record-scoped validator. Reads the table's `schema.json` and checks:

1. **Required fields** — fields listed in `schema.required` must be present,
   non-null, and non-empty-string. For new records (no master-branch version),
   the remote-ID column (`idColumnRemoteId`) is exempt.
2. **Read-only fields** — fields marked `x-scratch-readonly: true` in
   `schema.properties` must not differ from the master-branch value. Emits a
   `warning` (the publish step silently drops readonly changes anyway; this is
   advisory).

```json
{ "validator": "enforce_schema" }
```

No `params`. Emits `error` for missing required fields, `warning` for
modified readonly fields.

---

## Python validators

Validators with the `python:` prefix run a user-provided `.py` file using an
embedded **RustPython** interpreter (no system Python required).

```json
{
  "validator": "python:validators/check_name.py",
  "field": "name",
  "params": { "max": 100 }
}
```

The path after `python:` is relative to the workspace directory
(`.scratch/workspace`).

### Validator function contract

Every Python validator must define a top-level `validate(ctx)` function:

```python
def validate(ctx):
    """
    Args:
        ctx (dict):
            table      (str)  — folder path / table name
            filename   (str)  — record filename (e.g. "post-1.json")
            field_path (str)  — field being validated (e.g. "title")
            value             — the field value (any JSON type: str, int, float, bool, None, list, dict)
            record     (dict) — full record object (read-only)
            args       (dict) — params from validation.json

    Returns:
        list[dict]: Each dict must have:
            is_valid (bool)         — True = no violation, False = violation
            message  (str | None)   — short description shown in the UI; None if not applicable
    """
    length = len(str(ctx["value"])) if ctx["value"] is not None else 0
    max_len = ctx["args"].get("max", 100)
    if length > max_len:
        return [{"is_valid": False, "message": f"value is {length} chars (max {max_len})"}]
    return [{"is_valid": True, "message": None}]
```

Returning an empty list or a list of `{"is_valid": True, ...}` entries means
the field passes.

### Error messages

Every failure mode surfaces a named, actionable message:

| Failure | Message |
|---|---|
| File not found | `python validator not found: validators/check.py (looked in <path>)` |
| Syntax error | `python validator check.py has a syntax error: <SyntaxError with line>` |
| Missing `validate` function | `python validator check.py must define a top-level validate(ctx) function` |
| Runtime exception | `python validator check.py raised <ExceptionType>: <message>` |
| Wrong return shape | `python validator check.py returned <type>: expected list[dict] with is_valid and message` |
| Timeout (default 5 s) | `python validator check.py timed out after 5s` |
| Import error | `python validator check.py failed to import '<pkg>': module not found` |

### Sandbox

The embedded RustPython VM excludes dangerous stdlib modules: `subprocess`,
`socket`, `os.system`. C extension modules (numpy, pandas) are not supported.

---

## Result schema

Violations are stored in `validation_results_v1`:

```sql
CREATE TABLE validation_results_v1 (
    folder_path     TEXT NOT NULL,
    file_name       TEXT NOT NULL,
    field_path      TEXT NOT NULL,
    validator_kind  TEXT NOT NULL,
    level           TEXT NOT NULL,   -- 'error' | 'warning'
    message         TEXT,
    description     TEXT,
    fixable         INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (folder_path, file_name, field_path, validator_kind)
);
```

- `level = 'error'`: hard constraint violated (e.g. required field missing).
- `level = 'warning'`: soft constraint (e.g. length exceeded, readonly changed).
- `fixable`: reserved for future auto-fix support; always `0` today.

### TypeScript type (desktop app)

```typescript
// scratch-desktop/src/shared/validation-types.ts
type ValidationResultRow = {
  file_name?: string;         // present in folder-level results
  field_path: string;
  validator_kind: string;
  level: 'error' | 'warning';
  message: string | null;
  description: string | null;
  fixable: boolean;           // always false today
};
```

---

## CLI commands

```bash
# Run validation for all records in a workspace
scratchmd refresh-record-index

# Run validation for specific files only
scratchmd refresh-record-index --path posts/post-1.json --path posts/post-2.json

# Read results for one record
scratchmd get-validation-results --record posts/post-1.json

# Read results for an entire folder
scratchmd get-folder-validation-results --folder posts

# Print the active validation config (no DB needed)
scratchmd dump-validation-config
```

---

## Adding a new built-in validator

1. Add the implementation in `scratch-git-2/src/shared/validators/builtin.rs`.
   - Field-scoped: `fn my_validator(ctx: &FieldValidationContext) -> Option<ValidationResult>`
   - Record-scoped: `fn my_validator(ctx: &RecordValidationContext) -> Vec<RecordValidationResult>`
2. Register the name in `dispatch_validator` or `dispatch_record_validator` in
   `scratch-git-2/src/shared/validators/mod.rs`.
3. Document it in this file.
4. Add tests in the `#[cfg(test)]` block of `builtin.rs`.
