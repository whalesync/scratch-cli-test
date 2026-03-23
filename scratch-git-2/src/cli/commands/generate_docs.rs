//! Write CLAUDE.md and .scratch/docs/ into an initialised workspace.
//!
//! Called automatically at the end of `workspaces init` and `files download`.

use std::path::Path;

pub fn write_docs(workspace: &Path, workbook_name: &str) -> anyhow::Result<()> {
    let docs_dir = workspace.join(".scratch/docs");
    std::fs::create_dir_all(&docs_dir)?;

    std::fs::write(workspace.join("CLAUDE.md"), claude_md(workbook_name))?;
    std::fs::write(docs_dir.join("structure.md"), STRUCTURE_DOC)?;
    std::fs::write(docs_dir.join("syncs.md"), SYNCS_DOC)?;
    std::fs::write(docs_dir.join("schema.md"), SCHEMA_DOC)?;
    std::fs::write(docs_dir.join("commands.md"), COMMANDS_DOC)?;

    Ok(())
}

/// Resolves the workspace directory for the `generate-docs` command.
/// Walks up from `path` looking for a `.scratchmd` marker; falls back to `path` itself.
pub fn resolve_workspace_for_docs(path: &Path) -> anyhow::Result<std::path::PathBuf> {
    let abs = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
    // Walk up looking for a .scratchmd marker file
    let mut cur = abs.as_path();
    loop {
        if cur.join(".scratchmd").exists() {
            return Ok(cur.to_path_buf());
        }
        match cur.parent() {
            Some(p) => cur = p,
            None => break,
        }
    }
    // Fall back to the given path (user may be pointing directly at a workspace dir)
    Ok(abs)
}

// ---------------------------------------------------------------------------
// CLAUDE.md
// ---------------------------------------------------------------------------

fn claude_md(workbook_name: &str) -> String {
    format!(
        r#"# {workbook_name}

Scratch polls records from external services (Airtable, Webflow, Notion, …) and stores them as JSON files in this workspace — one file per record, one folder per table. The top-level folders are your working copy: edit them directly or let a sync populate them automatically.

**Syncs** copy fields from records in one folder into records of another, with optional transforms (slugify, HTML conversion, …). Run a sync to propagate source changes into the destination folder without touching the source.

Once you are happy with the changes — whether from a sync or manual edits — push them to the remote Scratch server. From there you can review the diff and publish, which writes the changes back to the destination service (e.g. creates or updates Webflow items).

- [How files are organised](.scratch/docs/structure.md)
- [Creating and running syncs](.scratch/docs/syncs.md)
- [Schema files (field definitions)](.scratch/docs/schema.md)
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
you edit and push back.

```
My-Project/
  AIRTABLE - Airtable/        <- working copy of Airtable data
    MyBase/
      Posts/
        recAbc.json           <- one file per record
      .scratch/
        schema.json           <- field definitions (read-only)
  WEBFLOW - Webflow/          <- working copy of Webflow data
    MySite/
      Posts/
        recXyz.json
      .scratch/
        schema.json
  .scratch/                   <- git plumbing + config (see below)
  CLAUDE.md
```

## The .scratch folder

Everything that is not a data record lives here. You will not normally need to
edit these files directly, but the CLI and agent tools use them heavily.

```
.scratch/
  docs/                       <- this documentation
  workbook/
    syncs/                    <- sync config files (agent edits these)
  connections/
    {SERVICE - Connection}/
      master/                 <- read-only published (main branch) snapshot
        {Base}/
          {Table}/
            recAbc.json       <- same files as top-level, but published state
          .scratch/
            schema.json
      index.db                <- SQLite index of master records
```

## Dirty vs master

| Location | Branch | Purpose |
|----------|--------|---------|
| `{SERVICE - Connection}/` | dirty | Your working copy — edit these |
| `.scratch/connections/{SERVICE - Connection}/master/` | main | Last published state — read-only reference |

To see what you have changed relative to the published state, compare the dirty
folder contents against the master folder for the same connection.
"#;

// ---------------------------------------------------------------------------
// .scratch/docs/syncs.md
// ---------------------------------------------------------------------------

const SYNCS_DOC: &str = r#"# Syncs

A sync moves data from one connection to another, applying field mappings along the way.
Sync configs live in `.scratch/workbook/syncs/*.json`.

## Sync config format

The local format matches the NestJS sync mapping format exactly. The only
difference is that `sourceDataFolderId` / `destinationDataFolderId` are
workspace-relative folder paths instead of database IDs.

```json
{
  "version": 1,
  "tableMappings": [
    {
      "sourceDataFolderId": "AIRTABLE - Airtable/MyBase/Posts",
      "destinationDataFolderId": "WEBFLOW - Webflow/MySite/Posts",
      "columnMappings": [
        { "sourceColumnId": "fields.Name",      "destinationColumnId": "fieldData.name" },
        { "sourceColumnId": "fields.Post Body", "destinationColumnId": "fieldData.post-body" }
      ],
      "recordMatching": {
        "sourceColumnId": "fields.Name",
        "destinationColumnId": "fieldData.name"
      }
    }
  ]
}
```

**`sourceDataFolderId`** / **`destinationDataFolderId`** — workspace-relative path
to the folder: `"<Connection Name>/<Base>/<Table>"`. Must match the directory names
exactly (e.g. `"AIRTABLE - Airtable/MyBase/Posts"`).

**`columnMappings`** — both `sourceColumnId` and `destinationColumnId` are
**full dot-notation paths** into the JSON file on disk. Always open a few sample
records from both folders to see the exact structure. Examples:
- Airtable: `fields.Name`, `fields.Post Body`
- Webflow: `fieldData.name`, `fieldData.post-body`
- Any path works: `id`, `createdTime`, etc.

**`recordMatching`** — used to update existing destination records instead of
creating duplicates. Matches on the column value at `sourceColumnId` vs
`destinationColumnId`. Unmatched source records are written as
`scratch_pending_<hash>.json` (new records awaiting publish).

**`tableMappings`** — array. Multiple table pairs can be synced in a single
config file.

## Creating a sync

In this version (V2), **creating a sync means writing a config file to
`.scratch/workbook/syncs/`** — nothing else happens automatically.

```bash
# Create the syncs directory if it doesn't exist
mkdir -p .scratch/workbook/syncs

# Write your config (see format above) to a new file, e.g.:
# .scratch/workbook/syncs/posts-airtable-to-webflow.json
```

> **Note:** `scratchmd syncs create` (the server-backed command) is kept for
> backwards compatibility with V1 workbooks. For V2 local workbooks, just drop
> a JSON file in the syncs folder — that is the entire create operation. Do not
> run anything else after creating the file.

## Transformers

An optional `transformer` (single) or `transformers` (array pipeline) can be added
to any field mapping to convert the source value before it is written to the destination.
When both are present, `transformers` takes precedence.

**Single transformer** — options are nested under an `options` key:
```json
{
  "sourceColumnId": "fields.Price",
  "destinationColumnId": "fieldData.price",
  "transformer": { "type": "string_to_number", "options": { "stripCurrency": true } }
}
```

**Chained pipeline** — `transformers` array runs left-to-right, each output feeds the next:
```json
{
  "sourceColumnId": "fields.Active",
  "destinationColumnId": "fieldData.active",
  "transformers": [
    { "type": "auto_convert", "options": { "targetType": "string" } },
    { "type": "auto_convert", "options": { "targetType": "boolean" } }
  ]
}
```

Cannot set both `transformer` and `transformers` — use one or the other.

### `string_to_number`

Parses a string (or number) into a JSON number.

```json
{ "sourceColumnId": "fields.Price", "destinationColumnId": "fieldData.price",
  "transformer": { "type": "string_to_number", "options": {} } }
```

Options (all optional, default `false`):
- `stripCurrency` — removes `$€£¥` and thousands-separator commas before parsing
- `parseInteger` — truncates to an integer instead of returning a float

```json
{ "transformer": { "type": "string_to_number", "options": { "stripCurrency": true, "parseInteger": false } } }
```

### `auto_convert`

Coerces a value to a target type. Requires `targetType` in `options`.

| `targetType` | Behaviour |
|---|---|
| `"string"` | Converts numbers/booleans to string; single-element arrays unwrap; multi-element arrays join with `", "` |
| `"number"` | Parses string/boolean to float |
| `"integer"` | Same but truncates to integer |
| `"boolean"` | `"true"/"yes"/"1"` → `true`; `"false"/"no"/"0"` → `false` |
| `"array"` | Wraps non-array values in a one-element array |

```json
{ "sourceColumnId": "fields.Active", "destinationColumnId": "fieldData.active",
  "transformer": { "type": "auto_convert", "options": { "targetType": "boolean" } } }
```

### `rhai` — custom script transformer

For logic that the built-in transformers can't handle, write a [Rhai](https://rhai.rs) script.
Rhai syntax is close to JavaScript/Rust. Scripts are sandboxed — no file I/O, no network.

**Config:**
```json
{ "sourceColumnId": "fields.Value",
  "destinationColumnId": "fieldData.squared",
  "transformer": { "type": "rhai", "options": { "script": "square.rhai" } } }
```

The `script` path is relative to the `.scratch/workbook/transformers/` directory in your workspace root.
Create that directory and add your script there — it will be git-tracked alongside your data.

**Example — square a number (`transformers/square.rhai`):**
```rhai
if value == () { return (); }
let n = parse_float(value.to_string());
n * n
```

The script receives the source field value as `value` and its return value becomes the
destination field value. `()` is Rhai's null — always guard against it if the field can be empty.

**Example — append a suffix (`transformers/append_usd.rhai`):**
```rhai
if value == () { return (); }
value.to_string() + " USD"
```

**Example — clamp a number to a range (`transformers/clamp.rhai`):**
```rhai
if value == () { return (); }
let n = parse_float(value.to_string());
if n < 0.0 { 0.0 } else if n > 100.0 { 100.0 } else { n }
```

Scripts are compiled once before the sync runs. A syntax error in any script will abort
the entire sync before any records are written.

## Running a sync

```bash
scratchmd syncs run-local
# or a specific sync file:
scratchmd syncs run-local --sync .scratch/workbook/syncs/posts.json
```

After running, check the destination connection folder for new/updated files.

## Pushing and publishing

```bash
# Commit dirty changes and push to remote
scratchmd files upload

# Publish changed records to the destination CMS (via web UI or API)
# Open the workbook in the browser -> Files tab -> Publish
```
"#;

// ---------------------------------------------------------------------------
// .scratch/docs/schema.md
// ---------------------------------------------------------------------------

const SCHEMA_DOC: &str = r#"# Schema Files

Each table has a `schema.json` file that describes its fields.
These files are **read-only** — they are generated from the CMS field definitions
and will be overwritten on the next pull.

## Location

```
{SERVICE - Connection}/{Base}/{Table}/.scratch/schema.json
.scratch/connections/{SERVICE - Connection}/master/{Base}/{Table}/.scratch/schema.json
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

For Airtable, fields are at the top level (no `fieldData` wrapper):
```json
{
  "type": "object",
  "properties": {
    "Name":      { "type": "string" },
    "Post Body": { "type": "string" }
  }
}
```

## Using schemas to build sync mappings

1. Open source schema — note the field names (Airtable: top-level keys)
2. Open destination schema — note the field slugs (Webflow: keys inside `fieldData`)
3. Create mappings: `{ "sourceField": "<source key>", "destField": "<dest slug>" }`

Do not include system fields like `id`, `slug`, `_archived`, `_draft` in mappings —
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
| `files upload` | Push local changes to the server |
| `files force-upload` | Force-push local state, skipping merge |

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
| `linked pull [--folder <id>]` | Pull CRM changes into the workspace |
| `linked publish [--folder <id>]` | Publish workspace changes to the CRM |

## syncs

| Command | Description |
|---|---|
| `syncs list` | List sync configurations |
| `syncs show <id>` | Show sync details |
| `syncs create --config <file\|json>` | Create a sync from a JSON config |
| `syncs update <id> --config <file\|json>` | Update a sync |
| `syncs delete <id>` | Delete a sync |
| `syncs run <id>` | Execute a sync on the server and wait |
| `syncs download` | Download all sync configs as JSON files |
| `syncs validate-local [--sync <file>]` | Validate local sync configs (no server needed) |
| `syncs run-local [--sync <file>]` | Run a sync locally against files on disk |

See [syncs.md](syncs.md) for sync config format and transformer reference.

## publish

| Command | Description |
|---|---|
| `plan-publish` | Build a publish plan locally (diffs dirty vs master, writes plan.json) |
| `publish-from-git` | Trigger server-side publish from the local publish plan |

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
