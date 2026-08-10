# Pseudo-references (`@/…`)

This is the **canonical specification** for pseudo-references — the `@/…` values a
record can carry in a foreign-key / link field to point at another record. If any
other doc, generated help text, connector, or piece of code disagrees with what is
written here, this doc wins and the other should be brought into line.

## What a pseudo-reference is

A **pseudo-reference** is a placeholder a record uses in a link field to reference
another record that **does not yet have a real remote ID** — most often a record the
user is creating in the same batch, which won't get its service-assigned ID until it
is published.

A normal (resolved) link field holds the referenced record's real remote ID, e.g.

```json
{ "Author": "1042" }
```

When the target has no remote ID yet, you can't write its ID because it doesn't
exist. Instead you write a pseudo-reference that names the target **file**, and
Scratch resolves it to the real ID at publish time (see
[Resolution](#how-pseudo-references-are-resolved-at-publish)):

```json
{ "Author": "@/AIRTABLE - Airtable/MyBase/Authors/new-author.json" }
```

There is a sibling marker, `@asset/<id>`, for not-yet-uploaded **assets**. It follows
the same "resolve at publish" idea but is system-managed and is **not** covered by
this format — see [`asset-system.md`](./asset-system.md).

## The canonical path format

A pseudo-reference is the literal marker `@/` followed by the target record file's
path **as it appears in the workspace tree, starting at the workspace root** — i.e.
an absolute, workspace-rooted path.

```
@/<connection folder>/<folder…>/<record file>.json
```

Rules, precisely:

- **Starts with the literal marker `@/`.** The `/` is part of the marker, not a
  leading slash on the path — the first path character is the start of the first
  segment.
- **The first segment is the connection folder** — the connection's display name as
  it appears at the top level of the workspace (e.g. `AIRTABLE - Airtable`,
  `HubSpot`, `HubSpot Testing`). It is always present.
- **Intermediate segments** are any nested folders between the connection and the
  record (e.g. a base/table, a site/collection).
- **Ends with the target record's filename, including the `.json` extension.**
- The path is **exactly what you would see navigating the workspace tree** to that
  file. It is:
  - **never** missing its connection folder — that first segment is required,
  - **not** a leading-slash absolute path (`@//HubSpot/…` is wrong),
  - **not** a `./`- or `../`-relative path,
  - **not** an on-disk filesystem path.

### Why workspace-absolute, and why the connection folder is included

Pseudo-references are **user-facing** — people (and agents) read, write, and reason
about them directly in record files. So the format is defined in the user's model of
the workspace: **one tree, with each connection as a top-level folder.** The path in
a pseudo-reference is just "where this file lives in that tree."

That each connection is stored as its **own git repository** under the hood is a
**hidden implementation detail**. Users don't know or care about it, so it must not
leak into the reference format. Including the connection folder as the first segment
also makes references **unambiguous** when two connections expose folders with the
same name (e.g. two HubSpot connections that both have a `Contacts` folder) — the
connection segment is what distinguishes them.

### Examples

```jsonc
// Scalar link field → a not-yet-published author in an Airtable connection:
{ "Author": "@/AIRTABLE - Airtable/MyBase/Authors/new-author.json" }

// Multi-value link field → a list of pseudo-references:
{ "Tags": ["@/AIRTABLE - Airtable/MyBase/Tags/tag-a.json",
           "@/AIRTABLE - Airtable/MyBase/Tags/tag-b.json"] }

// A HubSpot Quote associating a co-pending Contact (association id path):
{
  "associations": {
    "contacts": {
      "results": [
        { "id": "@/HubSpot/Contacts/marcos-perales-greyhound.json", "type": "quote_to_contact" }
      ]
    }
  }
}
```

A pseudo-reference may appear anywhere a real link-field id may appear: a scalar link
field, an element of a multi-value link array, or a nested id inside a
connector-specific link shape (like the HubSpot association above). Mixing is fine —
a multi-value field can hold real ids for already-published targets and
pseudo-references for co-pending ones side by side.

## When to use one

Use a pseudo-reference when you need to link to a record that has **no real remote ID
yet**:

- **Co-pending creates.** You create record B and record A in the same batch, and A
  links to B. B has no ID until it publishes, so A references it as `@/…/B.json`.
- **Referencing any not-yet-published record** by file, when you don't have (or don't
  want to hard-code) its remote ID.

If the target is already published, just use its real remote ID directly — a
pseudo-reference is only needed while the target has no ID.

## How pseudo-references are resolved at publish

Pseudo-references never reach the external service. They are stripped from the
outgoing payload and re-applied once the target's real ID is known. The publish
pipeline handles this with a **two-pass strip + later backfill** pattern (full detail
in [`publish-pipeline-flow.md`](./publish-pipeline-flow.md)):

1. **Strip.** During plan build, foreign-key fields holding a `@/…` value are
   stripped from the `edit`/`create` payload so the connector never sees an
   unresolved reference. If anything was stripped, a **`backfill`** operation is
   queued carrying the original (still-`@/…`) content.
2. **Create.** The `create` phase publishes the referenced record; the service
   returns its real remote ID, which is recorded in the **file index** keyed by the
   target file.
3. **Backfill / resolve.** The `backfill` phase (and the resolver used by
   `edit`/`create`) looks each `@/…` value up in the file index and replaces it with
   the real remote ID, then PATCHes the referencing record. Because `backfill` runs
   after `create`, every co-pending target's ID exists by the time its referrers
   resolve.

### Failure: malformed references

If a `@/…` value is not workspace-absolute — its first segment names no connection folder
in the workbook — publish fails for that record with:

```
Pseudo-ref "@/Contacts/x.json" is not workspace-absolute: "Contacts" is not a connection
folder in this workspace (expected one of: HubSpot, Airtable).
Use "@/<connection>/<folder>/<file>.json".
```

The most common cause is a reference that **omits its connection folder** — it starts at a
folder inside the connection instead of at the workspace root. The fix is always to write the
reference per this spec, prepending the connection folder; never to make the resolver accept
the shorter path.

### Failure: unresolvable references

If a `@/…` value is well-formed but names a file the index doesn't know — it was never
published and has no file-index entry — publish fails for that record with:

```
Cannot resolve pseudo-ref "@/…": no record ID found in FileIndex for folder="…" file="…"
```

The most common causes:

- **The target file doesn't exist / was never created.** The path names a record that
  isn't in the workspace (typo, wrong folder, wrong filename).
- **The path is stale.** It named a real record under a folder layout that has since
  changed (e.g. a Webflow collection that moved to `<Site>/Collections/<Collection>`).

## Who writes pseudo-references

- **Users and agents**, editing link fields directly (in the grid, the desktop app,
  or the files on disk).
- **Sync**, via the `source_fk_to_dest_fk` transformer: when a synced foreign key
  points at a destination record that only has a pending-publish ID, the transformer
  writes a `@/…` reference to that destination file (see
  [`sync-flow.md`](./sync-flow.md)).

All producers must emit the **workspace-absolute, connection-folder-first** format
defined above.

## Implementation notes

The user-facing format above is the contract. Internally, each connection is a
separate git repository whose file index and record paths are keyed **relative to
that connection** (no connection segment). A resolver consuming a pseudo-reference is
therefore responsible for **translating the workspace-absolute path into the target
connection + connection-relative path** before looking it up — the connection segment
selects the connection; the remainder is the connection-relative file path.

How this works today (DEV-10880, DEV-11238): the publish resolver
(`server/src/publish-plan/ref-resolver.service.ts`) maps the reference's leading
connection-folder segment to a `connectorAccountId` (via the workbook's connections,
matching either the bare sanitized display name or the legacy
`"<SERVICE> - <displayName>"` **folder naming**, since folders under both schemes exist
on disk), strips it, and looks the connection-relative remainder up in the
**`FileIndex`**. `FileIndex` carries a `connectorAccountId` discriminator so that two
connections exposing the same folder name (e.g. two HubSpot connections both with
`Contacts`) resolve unambiguously.

The resolver accepts **exactly one reading**: workspace-absolute. There is no leniency and
no fallback. A reference whose first segment names no connection in the workbook fails with a
diagnostic error naming the workspace's actual connection folders and the required format. It
is **not** quietly re-read against the connection being published. Because the resolver never
guesses, the reference itself is the single source of truth for which connection it points
at, and no caller has to tell the resolver "which connection am I publishing".

In the rare case where two connections' display names sanitize to the same folder name, the
resolver probes the `FileIndex` once per candidate connection: exactly one hit resolves the
reference, no hits leaves it unresolvable like any missing target, and two hits fail with an
error naming both connections rather than picking one.

## Related docs

- [`publish-pipeline-flow.md`](./publish-pipeline-flow.md) — the strip → create →
  backfill → resolve mechanism in full.
- [`sync-flow.md`](./sync-flow.md) — how sync produces `@/…` references.
- [`asset-system.md`](./asset-system.md) — the `@asset/<id>` sibling for assets.
- `scratch-git-2/src/cli/commands/generate_docs.rs` — the workspace agent docs that
  teach `@/…` to the desktop's embedded assistant; must match this spec.
