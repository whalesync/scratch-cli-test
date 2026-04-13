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

Scratch pulls records from external services (Airtable, Webflow, Notion, …) and stores them as JSON files in this workspace — one file per record, one folder per table. The top-level folders are your working copy: edit them directly.

Once your local agent has made changes, open the Scratch desktop app to review the diff. A person reviews and approves the changes, then publishes them back to the original service (e.g. creates or updates Webflow items).

- [How files are organised](.scratch/docs/structure.md)
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

## Location

```
.scratch/connections/scratch/{SERVICE - Connection}/{Base}/{Table}/schema.json
.scratch/connections/master/{SERVICE - Connection}/{Base}/{Table}/.scratch/schema.json
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
