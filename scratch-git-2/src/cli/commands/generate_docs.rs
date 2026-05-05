//! Write CLAUDE.md and .scratch/docs/ into an initialised workspace.
//!
//! Called automatically at the end of `workspaces init` and `files download`.

use std::path::Path;

pub fn write_docs(workspace: &Path, workbook_name: &str) -> anyhow::Result<()> {
    let docs_dir = workspace.join(".scratch/docs");
    std::fs::create_dir_all(&docs_dir)?;

    std::fs::write(workspace.join("CLAUDE.md"), claude_md(workbook_name))?;
    std::fs::write(docs_dir.join("structure.md"), STRUCTURE_DOC)?;
    std::fs::write(docs_dir.join("schema.md"), SCHEMA_DOC)?;
    std::fs::write(docs_dir.join("commands.md"), COMMANDS_DOC)?;
    std::fs::write(docs_dir.join("editing-data.md"), EDITING_DATA_DOC)?;
    std::fs::write(docs_dir.join("validations.md"), VALIDATIONS_DOC)?;

    Ok(())
}

/// Resolves the workspace directory for the `generate-docs` command.
/// Walks up from `path` looking for a workspace marker; falls back to `path` itself.
pub fn resolve_workspace_for_docs(path: &Path) -> anyhow::Result<std::path::PathBuf> {
    let abs = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
    Ok(crate::config::markers::find_nearest_workspace(&abs).unwrap_or(abs))
}

// ---------------------------------------------------------------------------
// CLAUDE.md
// ---------------------------------------------------------------------------

fn claude_md(workbook_name: &str) -> String {
    format!(
        r#"# {workbook_name}

Scratch pulls records from external services (Airtable, Webflow, Hubspot, Shopify, etc.) and stores them as JSON files in this workspace — one file per record, one folder per table. The top-level folders are your working copy: edit them directly.

Once your local agent has made changes, open the Scratch desktop app to review the diff. A person reviews and approves the changes, then publishes them back to the original service (e.g. creates or updates Webflow items).

- [How files are organised](.scratch/docs/structure.md)
- [Schema files (field definitions)](.scratch/docs/schema.md)
- [Editing data (creating, updating, deleting records)](.scratch/docs/editing-data.md)
- [Validation (checking records before publish)](.scratch/docs/validations.md)
- [CLI command reference](.scratch/docs/commands.md)
"#,
        workbook_name = workbook_name,
    )
}

// ---------------------------------------------------------------------------
// .scratch/docs/structure.md
// ---------------------------------------------------------------------------

const STRUCTURE_DOC: &str = r#"# Directory Structure

## What you see at the top level

Each top-level folder corresponds to one CMS connection (e.g. Airtable, Webflow).
These folders contain the **working (dirty) copy** of the remote data — the version
you and your local agent edit.

```
My-Project/
  AIRTABLE - Airtable/        <- working copy of Airtable data
    MyBase/
      Posts/
        recAbc.json           <- one file per record
  WEBFLOW - Webflow/          <- working copy of Webflow data
    MySite/
      Posts/
        recXyz.json
  .repos/                     <- bare git repos + SQLite indexes
  .scratch/
    .scratchmd                <- workspace marker
    connections/              <- shared connection metadata (see below)
    docs/                     <- generated docs + helper files
    workspace/                <- workbook config repo materialized locally
  CLAUDE.md
```

## The connection internals

Connector metadata and read-only snapshots live outside the user-editable
connection folders.

```
.scratch/connections/
  scratch/
    {SERVICE - Connection}/
      {Base}/
        {Table}/
          schema.json         <- field definitions and publish-plan files
  master/
    {SERVICE - Connection}/
      {Base}/
        {Table}/
          recAbc.json         <- published (main branch) snapshot
        .scratch/
          schema.json

.repos/
  {connectorId}.git           <- bare connector repo
  {connectorId}.db            <- SQLite index of master records
  {workbookId}.git            <- bare workbook config repo
```

## Dirty vs master

| Location | Branch | Purpose |
|----------|--------|---------|
| `{SERVICE - Connection}/` | dirty | Your working copy — edit these |
| `.scratch/connections/master/{SERVICE - Connection}/` | main | Last published state — read-only reference |
| `.scratch/connections/scratch/{SERVICE - Connection}/` | dirty metadata | Schema + publish-plan files |

To see what your local agent has changed relative to the published state, compare
the dirty folder contents against the master folder for the same connection. You
can also open the Scratch desktop app to review changes visually.
"#;

// ---------------------------------------------------------------------------
// .scratch/docs/schema.md
// ---------------------------------------------------------------------------

const SCHEMA_DOC: &str = r#"# Schema Files

Each table has a `schema.json` file that describes its fields.
These files are **read-only** — they are generated from the CMS field definitions
and will be overwritten on the next pull.

The schema is written using JSON Schema notation, with some custom extensions:
- x-scratch-readonly: indicates the field's data MUST NOT be modified
- x-scratch-connector-data-type: the service-specific type for the field, use only for context

Records may contain additional fields that not documented in the schema file. Those should be
treated as read-only unless explicitly instructed otherwise by the user.


## Location

```
.scratch/connections/scratch/{SERVICE - Connection}/[{Base}/]{Table}/schema.json
```

## What a schema looks like

```json
{
  "type": "object",
  "properties": {
    "fieldData": {
      "type": "object",
      "properties": {
        "name":      { "type": "string" },
        "post-body": { "type": "string", "contentMediaType": "text/html" },
        "slug":      { "type": "string" }
      }
    }
  }
}
```


## Using schemas

Use the schema to understand the structure of records when editing them. The field
names and types tell you what values are valid for each field.

Do not modify system fields like `id`, `slug`, `_archived`, `_draft` —
these are managed automatically.
"#;

// ---------------------------------------------------------------------------
// .scratch/docs/commands.md
// ---------------------------------------------------------------------------

const COMMANDS_DOC: &str = r#"# CLI Command Reference

All commands are run as `scratchmd <command> [options]`.
Run `scratchmd <command> --help` for full flag details.

## auth

| Command | Description |
|---|---|
| `auth login` | Authenticate with Scratch.md (opens browser) |
| `auth logout` | Remove stored credentials |
| `auth status` | Show current authentication status |

## workspaces

| Command | Description |
|---|---|
| `workspaces list` | List all workspaces |
| `workspaces show <id>` | Show workspace details |
| `workspaces create --name <name>` | Create a new workspace |
| `workspaces delete <id>` | Delete a workspace |
| `workspaces init <id>` | Clone a workspace locally (creates directory + docs) |

## files

| Command | Description |
|---|---|
| `files download` | Pull remote changes and three-way merge with local edits |

## connections

| Command | Description |
|---|---|
| `connections list` | List all connections in the workspace |
| `connections authorize` | Authorize a new connection |
| `connections show <id>` | Show connection details |
| `connections delete <id>` | Delete a connection |

## linked

| Command | Description |
|---|---|
| `linked list-tables <connection-id>` | List available tables from a connection |
| `linked list` | List linked tables in the workspace |
| `linked link` | Link a new table to the workspace |
| `linked unlink <folder-id>` | Remove a linked table |
| `linked show <folder-id>` | Show linked table details and pending changes |
| `linked pull [--folder <id>]` | Pull changes from the external service into the workspace |

## publish

| Command | Description |
|---|---|
| `plan-publish` | Build a publish plan locally (diffs dirty vs master, writes plan.json) |

## index

| Command | Description |
|---|---|
| `build-index` | Rebuild the SQLite file index for the current workspace |
| `dump-index [--connection <name>]` | Print file index contents (debugging) |

## docs

| Command | Description |
|---|---|
| `generate-docs [--workspace <dir>]` | Regenerate CLAUDE.md and `.scratch/docs/` in the workspace |
"#;

// ---------------------------------------------------------------------------
// .scratch/docs/editing-data.md
// ---------------------------------------------------------------------------

const EDITING_DATA_DOC: &str = r#"# Editing Data

Records in Scratch are JSON files — one file per record, one folder per table.
You edit them directly in the working copy folders. This guide covers how to
create, update, and delete records correctly.

## Record format

Each record is a single `.json` file. The filename is the record's remote ID
(e.g. `recAbc123.json` for Airtable, `66a1b2c3d4e5f6.json` for Webflow).
**Do not rename record files** — the filename links the record to its remote
counterpart.

The JSON structure varies by service. Always check the table's `schema.json`
(see [schema docs](schema.md)) or copy an existing record to understand the
expected format.

### Airtable example

```json
{
  "Name": "My Post Title",
  "Status": "Draft",
  "Body": "The post content..."
}
```

### Webflow example

```json
{
  "fieldData": {
    "name": "My Post Title",
    "slug": "my-post-title",
    "post-body": "<p>The post content...</p>"
  }
}
```

## Creating records

To create a new record, add a new `.json` file in the appropriate table folder.

- **Use a descriptive temporary filename** like `new-blog-post.json`. The file
  will receive a real remote ID when it is published.
- **Follow the schema** — look at `schema.json` for the table or copy an
  existing record and modify it.
- **Only include fields that have actual values.** Do not pad the JSON with
  empty strings, nulls, or placeholder values for every field in the schema.
- **Omit read-only fields.** Fields marked `"x-scratch-readonly": true` in the
  schema (e.g. `id`, `createdAt`, `updatedAt`, `archived`) are managed by the
  remote service and will be ignored on publish. Leaving them out keeps your
  files clean.

## Updating records

Edit the JSON file in place. Only change the fields you intend to update.

- **Preserve the existing structure.** Do not reorganise or reformat the JSON
  unless you are intentionally changing values.
- **Respect field types.** Check the schema for the expected type — string,
  number, boolean, array, etc. For HTML/rich-text fields
  (`"contentMediaType": "text/html"`), preserve valid HTML structure.
- **Do not modify read-only fields.** Changes to read-only fields will be
  silently ignored on publish.

## Deleting records

Delete the record's `.json` file from the working copy folder. When the change
is published, the corresponding record will be removed from the remote service.

## Reviewing and publishing changes

Edits are **not live** until they are published:

1. Make your changes in the working copy folders.
2. Open the Scratch desktop app or run `scratchmd plan-publish` to review the
   diff between your working copy and the last published state.
3. A person reviews and approves the changes, then publishes them back to the
   remote service.

You can compare your edits against the published snapshot in
`.scratch/connections/master/` to see what has changed (see
[structure docs](structure.md)).

## Tips

- **Batch related changes together.** If you are updating multiple records in
  the same table, make all edits before publishing so they can be reviewed as a
  group.
- **Use `scratchmd files download`** to pull the latest remote data before
  making edits. This avoids conflicts with changes made directly in the remote
  service.
- **Check `linked show <folder-id>`** to see pending changes for a specific
  table before publishing.
"#;

// ---------------------------------------------------------------------------
// .scratch/docs/validations.md
// ---------------------------------------------------------------------------

const VALIDATIONS_DOC: &str = r#"# Validation

Scratch can check records for problems before they are published. Validators run
automatically whenever the record index is refreshed. Results appear in the
Scratch desktop app as error and warning badges on individual records and fields.

## How it works

1. The CLI reads `validation.json` from the metadata folder for each table
   (`.scratch/connections/scratch/<connection>/<table>/validation.json`).
2. On every `scratchmd refresh-record-index` run, each record in the working copy
   is checked against the configured rules.
3. Violations are stored in a SQLite table (`validation_results_v1`) inside the
   connection's `.db` index file.
4. The desktop app reads those results and highlights affected fields inline.
   Passing records produce no rows — only violations are stored.

## Where `validation.json` lives

`validation.json` sits next to `schema.json` in the **metadata** folder, not in
the editable working copy:

```
.scratch/connections/scratch/
  WEBFLOW - My Site/
    Blog Posts/
      schema.json
      validation.json    <- add your rules here
```

The working copy folders (e.g. `WEBFLOW - My Site/Blog Posts/*.json`) are not
affected — only the config and schema live in `.scratch/`.

## `validation.json` format

`validation.json` is a JSON array of validator entries:

```json
[
  {
    "validator": "enforce_schema"
  },
  {
    "validator": "length",
    "field": "fieldData.name",
    "params": { "min": 1, "max": 256 }
  },
  {
    "validator": "python:validators/check-slug.py",
    "field": "fieldData.slug",
    "note": "Enforce lowercase slug format"
  }
]
```

### Entry fields

| Field       | Type       | Required | Description |
|-------------|------------|----------|-------------|
| `validator` | `string`   | yes      | Built-in name (`enforce_schema`, `length`) or `python:<path>`. |
| `field`     | `string`   | no       | Dot-path to a single field. Omit for record-scoped validators (`enforce_schema`). |
| `params`    | `object`   | no       | Arguments passed to the validator. Defaults to `{}`. |
| `order`     | `number`   | no       | Run order (ascending). Ties keep file order. |
| `note`      | `string`   | no       | Free-text annotation; ignored at runtime. |

---

## Built-in validators

### `enforce_schema`

**Record-scoped** (no `field` needed). Reads the table's `schema.json` and runs
two checks:

1. **Required fields** — every field listed in `schema.required` must be present,
   non-null, and non-empty-string. Emits an **error** for each violation.
   - Exception: the remote-ID column (`idColumnRemoteId`) is skipped for new
     records that have not yet been published (the remote service assigns the ID
     on first publish).

2. **Read-only fields** — fields marked `"x-scratch-readonly": true` in
   `schema.properties` must not differ from the last-published (master-branch)
   value. Emits a **warning** for each changed read-only field.
   - For new records: warns if a read-only field is set at all (the value will
     be silently dropped when publishing).
   - For existing records: warns if the working-copy value differs from the
     master-branch value, and shows both values in the description.

```json
{ "validator": "enforce_schema" }
```

No `params`. Good default to add to every table.

**Violations produced:**

| Situation | Level | Message |
|-----------|-------|---------|
| Required field absent, null, or empty | `error` | `field 'slug' is required but missing or null` |
| Read-only field changed on existing record | `warning` | `Updated read-only field` (description includes old → new values) |
| Read-only field set on new record | `warning` | `Updated read-only field` (description: value will be ignored) |

---

### `length` (alias: `max_length`)

**Field-scoped.** Checks that a field's string value is within an optional
minimum and/or maximum character count. Non-string values are coerced to their
JSON representation before measuring. `null` counts as 0 characters.

```json
{ "validator": "length", "field": "fieldData.name", "params": { "max": 256 } }
```

**Params:**

| Param | Type     | Description |
|-------|----------|-------------|
| `min` | `number` | Minimum character count (inclusive). |
| `max` | `number` | Maximum character count (inclusive). |

At least one of `min` / `max` must be present. Emits a **warning** on failure.

---

## Python validators (custom rules)

Use the `python:` prefix to run a `.py` file. No system Python is needed — the
CLI embeds a sandboxed Python interpreter (RustPython).

```json
{
  "validator": "python:validators/check-slug.py",
  "field": "fieldData.slug",
  "params": { "pattern": "^[a-z0-9-]+$" }
}
```

### Where Python scripts live

Paths are relative to the **workspace directory** (`.scratch/workspace`):

```
.scratch/workspace/
  validators/
    check-slug.py
    title-case.py
```

So `"python:validators/check-slug.py"` resolves to
`.scratch/workspace/validators/check-slug.py`.

### The `validate(ctx)` contract

Every Python validator must define a top-level `validate(ctx)` function:

```python
def validate(ctx):
    """
    ctx keys:
      table      (str)  -- folder path of the table
      filename   (str)  -- record filename, e.g. "post-1.json"
      field_path (str)  -- field being validated, e.g. "fieldData.slug"
      value             -- field value (str, int, float, bool, None, list, dict)
      record     (dict) -- full record (read-only)
      args       (dict) -- params from validation.json

    Returns list[dict], each with:
      is_valid (bool)       -- True = pass, False = violation
      message  (str | None) -- short message shown in the UI
    """
    value = ctx["value"] or ""
    import re
    pattern = ctx["args"].get("pattern", r"^[a-z0-9-]+$")
    if not re.match(pattern, str(value)):
        return [{"is_valid": False, "message": f"slug '{value}' does not match {pattern}"}]
    return [{"is_valid": True, "message": None}]
```

Returning an empty list or all `{"is_valid": True}` entries means the field
passes. The sandbox excludes `subprocess`, `socket`, and `os.system`. C
extensions (numpy, pandas) are not supported.

---

## Examples

### Webflow Blog Posts — common rule set

```json
[
  { "validator": "enforce_schema" },
  {
    "validator": "length",
    "field": "fieldData.name",
    "params": { "min": 1, "max": 256 },
    "note": "Webflow Name field hard limit"
  },
  {
    "validator": "length",
    "field": "fieldData.slug",
    "params": { "min": 1, "max": 200 }
  }
]
```

### Custom slug format check

```json
[
  { "validator": "enforce_schema" },
  {
    "validator": "python:validators/check-slug.py",
    "field": "fieldData.slug",
    "params": { "pattern": "^[a-z0-9]+(-[a-z0-9]+)*$" },
    "note": "Webflow requires lowercase alphanumeric slugs with hyphens only"
  }
]
```

---

## CLI commands

```bash
# Run validation for all records (runs automatically with refresh-record-index)
scratchmd refresh-record-index

# Run validation for specific files only
scratchmd refresh-record-index --path "Blog Posts/post-1.json"

# Read results for one record
scratchmd get-validation-results --record "Blog Posts/post-1.json"

# Read results for an entire folder
scratchmd get-folder-validation-results --folder "Blog Posts"

# Print the active validation config (no DB needed)
scratchmd dump-validation-config
```
"#;
