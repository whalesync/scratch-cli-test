//! `scratchmd generate-docs` — write CLAUDE.md and .scratch/docs/ for a pulled workspace.
//!
//! Called automatically at the end of `scratchmd pull`, and can be re-run manually.

use std::path::{Path, PathBuf};

use crate::Result;
use super::resolve_workspace;

#[derive(clap::Args, Debug)]
pub struct Args {
    /// Path to the pulled workspace root (default: current directory)
    #[arg(long, default_value = ".")]
    pub workspace: PathBuf,

    /// Workbook display name (used in CLAUDE.md header)
    #[arg(long, default_value = "Scratch Workbook")]
    pub workbook_name: String,
}

pub async fn run(args: Args) -> Result<()> {
    let workspace = resolve_workspace(&args.workspace)?;
    write_docs(&workspace, &args.workbook_name)
}

pub fn write_docs(workspace: &Path, workbook_name: &str) -> Result<()> {
    let docs_dir = workspace.join(".scratch/docs");
    std::fs::create_dir_all(&docs_dir)?;

    std::fs::write(workspace.join("CLAUDE.md"), claude_md(workbook_name))?;
    std::fs::write(docs_dir.join("structure.md"), STRUCTURE_DOC)?;
    std::fs::write(docs_dir.join("syncs.md"), SYNCS_DOC)?;
    std::fs::write(docs_dir.join("schema.md"), SCHEMA_DOC)?;

    Ok(())
}

// ---------------------------------------------------------------------------
// CLAUDE.md — minimal, links to docs
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
  Airtable/               <- working copy of Airtable data
    MyBase/
      Posts/
        recAbc.json       <- one file per record
      .scratch/
        schema.json       <- field definitions (read-only)
  Webflow/                <- working copy of Webflow data
    MySite/
      Posts/
        recXyz.json
      .scratch/
        schema.json
  .scratch/               <- git plumbing + config (see below)
  CLAUDE.md
```

## The .scratch folder

Everything that is not a data record lives here. You will not normally need to
edit these files directly, but the CLI and agent tools use them heavily.

```
.scratch/
  docs/                   <- this documentation
  workbook/
    .git/                 <- workbook-level git repo (syncs, config)
    syncs/                <- sync config files (agent edits these)
  connections/
    {ConnectionName}/
      .git/               <- bare git repo for this connection
      id                  <- connection ID used by the server
      master/             <- read-only published (master branch) snapshot
        {Base}/
          {Table}/
            recAbc.json   <- same files as top-level, but published state
          .scratch/
            schema.json
```

## Dirty vs master

| Location | Branch | Purpose |
|----------|--------|---------|
| `{Connection}/` | dirty | Your working copy — edit these |
| `.scratch/connections/{Connection}/master/` | master | Last published state — read-only reference |

To see what you have changed relative to the published state:
```bash
git -C .scratch/connections/{Connection}/.git diff master dirty
```
"#;

// ---------------------------------------------------------------------------
// .scratch/docs/syncs.md
// ---------------------------------------------------------------------------

const SYNCS_DOC: &str = r#"# Syncs

A sync moves data from one connection to another, applying field mappings along the way.
Sync configs live in `.scratch/workbook/syncs/*.json`.

## Sync config format

```json
{
  "version": 1,
  "displayName": "Posts: Airtable -> Webflow",
  "source": {
    "connection": "Airtable",
    "folder": "MyBase/Posts"
  },
  "destination": {
    "connection": "Webflow",
    "folder": "MySite/Posts"
  },
  "fieldMappings": [
    { "sourceField": "fields.Name",      "destField": "fieldData.name" },
    { "sourceField": "fields.Post Body", "destField": "fieldData.post-body" }
  ],
  "recordMatching": {
    "sourceField": "fields.Name",
    "destField": "fieldData.name"
  }
}
```

**`source.connection`** and **`destination.connection`** must match the top-level
folder names exactly (case-sensitive).

**`source.folder`** and **`destination.folder`** are the path within the connection,
e.g. `MyBase/Posts`. Check the actual folder names by looking at the directory tree.

**`fieldMappings`** — both `sourceField` and `destField` are **full dot-notation
paths** into the JSON file on disk. Always open a few sample records from both
source and destination to see the exact structure — schemas show types but
records show the real nesting. Examples:
- Airtable source fields: `fields.Name`, `fields.Post Body`
- Webflow dest fields: `fieldData.name`, `fieldData.post-body`
- Any path works: `id`, `createdTime`, `fieldData.slug`, etc.

**`recordMatching`** — used to update existing destination records instead of
creating duplicates. The sync finds the destination record where the value at
`destField` equals the value at `sourceField`. Unmatched source records are
written as `scratch_pending_<hash>.json` (new records awaiting publish).

## Running a sync

```bash
scratchmd run-sync --workspace .
# or a specific sync:
scratchmd run-sync --workspace . --sync posts
```

After running, check the destination connection folder for new/updated files.

## Pushing and publishing

```bash
# Commit dirty changes and push to remote
scratchmd push --workspace .

# Publish changed records to the destination CMS (run from server directory)
cd /path/to/experimental/scratch-v4-backend/server
yarn publish-records
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
{Connection}/{Base}/{Table}/.scratch/schema.json       <- in dirty worktree
.scratch/connections/{Connection}/master/{Base}/{Table}/.scratch/schema.json
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
