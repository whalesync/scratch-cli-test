//! Write AGENTS.md (+ CLAUDE.md symlink) and .scratch/docs/ into an initialised workspace.
//!
//! Called automatically at the end of `workspaces init` and `files download`.

use std::path::Path;

pub fn write_docs(workspace: &Path, workbook_name: &str) -> anyhow::Result<()> {
    let docs_dir = workspace.join(".scratch/docs");
    std::fs::create_dir_all(&docs_dir)?;

    let relay_base_url = relay_base_url_for_workspace(workspace);
    std::fs::write(
        workspace.join("AGENTS.md"),
        claude_md(workbook_name, &relay_base_url),
    )?;
    let symlink_path = workspace.join("CLAUDE.md");
    // Remove any existing file/symlink so we can recreate it
    let _ = std::fs::remove_file(&symlink_path);
    #[cfg(unix)]
    std::os::unix::fs::symlink("AGENTS.md", &symlink_path)?;
    #[cfg(windows)]
    std::os::windows::fs::symlink_file("AGENTS.md", &symlink_path)?;
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
// AGENTS.md
// ---------------------------------------------------------------------------

fn relay_base_url_for_workspace(workspace: &Path) -> String {
    let server_url = crate::config::markers::read(&crate::config::markers::marker_path(workspace))
        .ok()
        .and_then(|marker| marker.server_url().map(str::to_string))
        .unwrap_or_else(|| crate::api::DEFAULT_SERVER_URL.to_string());

    relay_base_url_from_server_url(&server_url)
}

fn relay_base_url_from_server_url(server_url: &str) -> String {
    let trimmed = server_url.trim().trim_end_matches('/');
    match trimmed {
        "https://api.scratch.md" => "https://app.scratch.md".to_string(),
        "https://test-api.scratch.md" => "https://test.scratch.md".to_string(),
        "http://localhost:3010" => "http://localhost:3000".to_string(),
        "http://127.0.0.1:3010" => "http://127.0.0.1:3000".to_string(),
        _ => "https://app.scratch.md".to_string(),
    }
}

fn claude_md(workbook_name: &str, relay_base_url: &str) -> String {
    format!(
        r#"# {workbook_name}

Scratch pulls records from external services (Airtable, Webflow, Hubspot, Shopify, etc.) and stores them as JSON files in this workspace — one file per record, one folder per table. The top-level folders are your working copy: edit them directly.

Once your local agent has made changes, open the Scratch desktop app to review the diff. A person reviews and approves the changes, then publishes them back to the original service (e.g. creates or updates Webflow items).

- [How files are organised](.scratch/docs/structure.md)
- [Schema files (field definitions). Must read before editing records!](.scratch/docs/schema.md)
- [Editing data (creating, updating, deleting records)](.scratch/docs/editing-data.md)
- [Validation (checking records before publish)](.scratch/docs/validations.md)
- [CLI command reference](.scratch/docs/commands.md)

## Scratch Desktop deep links

When pointing the user back to the Scratch desktop app, create a deep link from the absolute local path and URL-encode the full path:

```
scratch://open?path=<url-encoded-absolute-path>&source=claude-code
```

The source should be the name of the tool that generated the deep link, e.g. `claude-code` or `claude-cowork`.

When creating Markdown links for tools that only open `http` or `https` URLs, pass the full `scratch://` URL through the Scratch web relay page:

```
[Open in Scratch Desktop]({relay_base_url}/open-desktop?url=<url-encoded-scratch-url>)
```

- Workspace: encode this workspace root path.
- Folder: encode the folder path, e.g. `{{workspace}}/My Website/Blog Posts`.
- Record: encode the record file path, e.g. `{{workspace}}/My Website/Blog Posts/example.json`.

## Troubleshooting with `workspace.log`

The Scratch desktop app writes a rolling log to `workspace.log` at the root of this workspace. The log tracks operations performed by the desktop app and the CLI along with errors and warnings.

Log messages are written in the following format:
```
<timestamp> <type> <status> <message>
```

Each time the user opens the workspace in the desktop app, a `SESSION Starting session` line is written; closing the workspace writes `SESSION Ending session`. When investigating an error, find the **most recent** `Starting session` line and focus on the entries between it and the next `Ending session` (or the end of the file) — that's the session the user was in when the problem occurred. Older sessions are usually unrelated.

Look for `fail exit=...` (CLI), non-2xx status codes (API), or `PUBLISH complete failed ...` lines within that window.
"#,
        workbook_name = workbook_name,
        relay_base_url = relay_base_url,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn relay_base_url_tracks_server_environment() {
        assert_eq!(
            relay_base_url_from_server_url("https://api.scratch.md"),
            "https://app.scratch.md",
        );
        assert_eq!(
            relay_base_url_from_server_url("https://test-api.scratch.md"),
            "https://test.scratch.md",
        );
        assert_eq!(
            relay_base_url_from_server_url("http://localhost:3010"),
            "http://localhost:3000",
        );
    }

    #[test]
    fn claude_md_uses_environment_specific_relay_host() {
        let docs = claude_md("Test Workbook", "https://test.scratch.md");

        assert!(docs.contains(
            "[Open in Scratch Desktop](https://test.scratch.md/open-desktop?url=<url-encoded-scratch-url>)"
        ));
    }
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
  AGENTS.md              <- also symlinked as CLAUDE.md
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

## Working copy vs published state

| Location | Branch | Purpose |
|----------|--------|---------|
| `{SERVICE - Connection}/` | main | Your working copy — edit these record files |
| `{SERVICE - Connection}/.scratch/` | main | Tracked schemas + view definitions |
| `.scratch/connections/{SERVICE - Connection}/accepted-patches.json` | (not a branch) | Per-field edits you've accepted but haven't published yet (RFC 7396 merge patches) |
| `.scratch/connections/scratch/{SERVICE - Connection}/` | (local cache) | Schema cache populated from the worktree's `.scratch/` |

The published state lives as git blobs in `.repos/{connectorId}.git/` on
`refs/heads/main`. Use `scratchmd files unreviewed` or the desktop app to see
what your edits look like relative to the published state — the on-disk
mirrors that earlier versions surfaced under `.scratch/connections/master/`
and `.scratch/connections/dirty/` were retired in DEV-10144 slice F.
"#;

// ---------------------------------------------------------------------------
// .scratch/docs/schema.md
// ---------------------------------------------------------------------------

const SCHEMA_DOC: &str = r#"# Schema Files

Each table has a `schema.json` file that describes its fields.
These files are **read-only** — they are generated from the CMS field definitions
and will be overwritten on the next pull.

The schema is written using JSON Schema notation, with some important extensions:
- x-scratch-readonly: indicates the field's data MUST NOT be modified.
- x-scratch-connector-data-type: the service-specific type for the field, use only for context
- x-scratch-agent-instructions: a plain-text hint written for you (the agent). When present,
  read it carefully — it explains a non-obvious structural detail, a soft relationship between
  fields, or which sub-values are user-relevant vs. noise. Treat it as authoritative guidance
  from the connector author about how to interpret this field or object.

Records may contain additional fields that not documented in the schema file. Those should be
treated as read-only unless explicitly instructed otherwise by the user.

Often, different representations of the same data will be present in multiple fields (ex: body_raw,
body_html, body_rendered, body_preview). Do not edit any fields with `x-scratch-readonly: true`
set; those fields are derived from the one field that is writable.


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
| `linked pull [<id>] [--mode full\|incremental]` | Pull changes from the external service into the workspace (incremental pulls only records changed since the last pull) |

## paginate

| Command | Description |
|---|---|
| `paginate-records --folder <conn>/<folder>` | Query a folder's index — paginated filenames with filters/sort. Primary read API for the grid |

## index

| Command | Description |
|---|---|
| `index dump [--connection <name>]` | Print file index contents (debugging) |
| `index find-stale-files --folder <conn>/<folder>` | List files whose working-tree mtime/size no longer matches the index |
| `index find-column-stale-files --folder <conn>/<folder> [--column <c>]` | List files where ≥1 of the given columns is stale (empty input = all non-core columns) |
| `index find-stale --folder <conn>/<folder>` | Classify stale files into `base_stale` vs `column_stale` |
| `index refresh-folder --folder <conn>/<folder> [--validate]` | Smart, mtime-aware refresh of one folder. `--validate` also runs validators where stale and populates the problems table |
| `index rebuild-folder --folder <conn>/<folder>` | Wipe + fully rebuild one folder's index (corruption recovery) |
| `index rebuild-all` | Wipe + fully rebuild every folder's index in the workspace |
| `index refresh-files-full --folder <conn>/<folder> --file <name> [--validate]` | Incrementally update specific files (base row + columns); `--validate` also runs validators |
| `index refresh-files-columns-only --folder <conn>/<folder> --file <name>` | Update only column values for specific files (working tree only) |
| `index add-column --folder <conn>/<folder> --column <jsonpath>` | Add a JSON-path column to a folder's index and populate it |
| `index clear-column --folder <conn>/<folder> --column <c>` | Remove a column (and its `:mt`/`:sz` siblings) from a folder |
| `index clear-folder --folder <conn>/<folder>` | Wipe a folder's index — all rows + dynamic columns |
| `index init` | Create the SQLite index DB for the workspace (first-time) |

## validation

| Command | Description |
|---|---|
| `validation dry-run --folder <conn>/<folder> --file <name>` | Run validators against saved file(s) WITHOUT writing to the index — agent experimentation |
| `validation dry-run --folder <conn>/<folder> --record <json>` | Dry-run inline JSON against saved rules |
| `validation dry-run --record <json> --validation <json> --schema <json>` | Fully standalone dry-run with all sources inline |
| `validation get-file-problems --record <connection>/<folder>/<file>` | Stored validation problems for a single record |
| `validation get-folder-problems --folder <connection>/<folder> [--limit <n>]` | All stored validation problems for a folder (`--limit` for UI previews) |
| `validation get-files-with-problems --folder <connection>/<folder> [--limit <n>]` | Filenames in a folder with ≥1 error-level violation |
| `validation get-stats` | Workspace-wide error/warning counts grouped by connection + folder |
| `validation dump-config [--connection <name>]` | Print the loaded `validation.json` config (no DB required) |

## docs

| Command | Description |
|---|---|
| `generate-docs [--workspace <dir>]` | Regenerate AGENTS.md (+ CLAUDE.md symlink) and `.scratch/docs/` in the workspace |
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
2. Open the Scratch desktop app to review the diff between your working copy
   and the last published state.
3. A person reviews and approves the changes, then publishes them back to the
   remote service.

Use `scratchmd files unreviewed` to list records with unaccepted edits and
`scratchmd files unpublished` for records whose accepted edits haven't been
published yet (see [structure docs](structure.md)).

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
lazily when the desktop grid loads a page of records — each record is checked
against the configured rules only when it would actually be displayed. Results
appear in the Scratch desktop app as error and warning badges on individual
records and fields.

## How it works

1. The CLI reads `validation.json` from the metadata folder for each table
   (`.scratch/connections/scratch/<connection>/<table>/validation.json`).
2. The desktop loads grid pages via `paginate-records --validate`; the index
   tracks which records have stale validation state (working tree mtime
   newer than the last validator run) and re-runs the rules for that page.
3. Violations are stored in the per-folder SQLite index inside the connection's
   `.db` file. Passing records produce no rows — only violations are stored.
4. The desktop app reads those results and highlights affected fields inline.

## Two ways to run validators

| Verb | What it does | When to use |
|------|--------------|-------------|
| `validation dry-run` | Runs validators, returns JSON. **Does not** write to the index. | Agent experimentation: check a record before saving, try a new rule, debug a validator. No side effects. |
| `index refresh-folder --folder <conn>/<folder> --validate` | Refreshes the folder's index AND runs validators where validation is stale (mtime-aware skip). Writes to the problems table. | Commit a new/changed `validation.json` and populate the problems table so the desktop app shows up-to-date stats and lets the user browse problems quickly. |

The grid also lazily populates the problems table on its own (each
`paginate-records --validate` call validates the stale rows on the page being
displayed). `index refresh-folder --validate` is the eager equivalent for the
whole folder.

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
| `validator` | `string`   | yes      | Built-in name (`enforce_schema`, `required`, `length`) or `python:<path>`. |
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

### `required`

**Field-scoped.** Emits an **error** when a field is absent from the record,
`null`, or an empty string `""`. Use this to enforce values on fields that the
schema marks as optional but your workflow needs filled in before publishing.

```json
{ "validator": "required", "field": "fields.Name" }
```

No `params`. Use one entry per field.

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

Every Python validator must define a top-level `validate(ctx)` function.
Return a **list of violations** — an empty list means the value passes.

```python
def validate(ctx):
    """
    ctx keys:
      filename   (str)  -- record filename, e.g. "post-1.json"
      field_path (str)  -- field being validated, e.g. "fieldData.slug"
      value             -- field value (str, int, float, bool, None, list, dict)
      record     (dict) -- full record (read-only)
      args       (dict) -- params from validation.json

    Returns list[dict] — each item is a violation:
      level       ("warning"|"error")  -- defaults to "warning" if absent
      message     (str | None)         -- short message shown in the UI
      description (str | None)         -- longer explanation (optional)
      fixable     (bool)               -- defaults to False
    """
    value = ctx["value"] or ""
    import re
    pattern = ctx["args"].get("pattern", r"^[a-z0-9-]+$")
    if not re.match(pattern, str(value)):
        return [{"message": f"slug '{value}' does not match {pattern}"}]
    return []
```

The sandbox excludes `subprocess`, `socket`, and `os.system`. C extensions
(numpy, pandas) are not supported. The built-ins `eval`, `exec`, and the
interactive helpers (`input`, `breakpoint`, `help`, `exit`, `quit`) are also
stripped. Validator scripts must be 256 KB or smaller.

---

## Dry-run validation for agents

Use `scratchmd validation dry-run` to run validation without touching the index.
This is the primary way for an AI agent to check records before or after
editing them — no side effects, immediate JSON output.

### Why dry-run?

- **Before saving**: validate a proposed JSON value before writing it to disk.
- **Try a new rule**: test a custom `validation.json` against existing records
  without deploying it yet.
- **Debug a validator**: supply all four inputs inline so no workspace is needed.

### Sources

Each of the four inputs (record, master record, `validation.json`, `schema.json`)
can come from disk or be supplied as an inline JSON string. Any combination works.

| Flag | Meaning |
|------|---------|
| `--folder <conn>/<folder>` | Locates disk sources; required when any source is read from disk |
| `--file <name>` | Read record(s) from working copy; repeatable; mutually exclusive with `--record` |
| `--record <json>` | Inline record JSON; mutually exclusive with `--file` |
| `--master <json>` | Inline master record (omit to treat record as new) |
| `--validation <json>` | Inline `validation.json` array (overrides disk) |
| `--schema <json>` | Inline `schema.json` (overrides disk) |

### Output

JSON array of violations (empty array = all checks pass):

```json
[
  {
    "file": "post-1.json",
    "field_path": "fieldData.slug",
    "validator_kind": "length",
    "level": "warning",
    "message": "value is 256 characters (max 200)",
    "fixable": false
  }
]
```

### Examples

```bash
# Check a saved record against saved rules
scratchmd validation dry-run \
  --folder "WEBFLOW - My Site/Blog Posts" \
  --file post-1.json

# Check multiple records at once
scratchmd validation dry-run \
  --folder "WEBFLOW - My Site/Blog Posts" \
  --file post-1.json --file post-2.json

# Test a proposed edit before saving it
scratchmd validation dry-run \
  --folder "WEBFLOW - My Site/Blog Posts" \
  --record '{"fieldData":{"name":"New Title","slug":"new-title"}}'

# Test a new validation rule against an existing record
scratchmd validation dry-run \
  --folder "WEBFLOW - My Site/Blog Posts" \
  --file post-1.json \
  --validation '[{"validator":"length","field":"fieldData.name","params":{"max":60}}]'

# Fully standalone — no workspace needed
scratchmd validation dry-run \
  --record '{"fieldData":{"slug":"BAD SLUG"}}' \
  --master '{"fieldData":{"slug":"good-slug"}}' \
  --validation '[{"validator":"python:validators/check-slug.py","field":"fieldData.slug"}]' \
  --schema '{}'

# Commit a new validation.json and populate the problems table for the whole folder
# (smart-skips files that are already fresh)
scratchmd index refresh-folder \
  --folder "WEBFLOW - My Site/Blog Posts" \
  --validate
```

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
# Eagerly run validators for a folder and populate the problems table.
# Smart-skips files that are already fresh — fast on a clean folder.
scratchmd index refresh-folder --folder "My Connection/Blog Posts" --validate

# Reindex + validate just a few records — useful after editing one record's data.
scratchmd index refresh-files-full --folder "My Connection/Blog Posts" --file post-1.json --validate

# Read problems for one record.
scratchmd validation get-file-problems --record "My Connection/Blog Posts/post-1.json"

# Read problems for an entire folder.
scratchmd validation get-folder-problems --folder "My Connection/Blog Posts"

# Workspace-wide problem counts by connection + folder.
scratchmd validation get-stats

# Print the active validation config (no DB needed).
scratchmd validation dump-config
```
"#;
