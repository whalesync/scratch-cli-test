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
  - **not** connection-relative (do not drop the connection folder),
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

### Failure: unresolvable references

If a `@/…` value cannot be resolved — the named file was never published and has no
file-index entry — publish fails for that record with:

```
Cannot resolve pseudo-ref "@/…": no record ID found in FileIndex for folder="…" file="…"
```

The most common causes:

- **The target file doesn't exist / was never created.** The path names a record that
  isn't in the workspace (typo, wrong folder, wrong filename).
- **A format mismatch** between the reference and how the file index is keyed — e.g. a
  connection segment present in one but not the other. Any such mismatch is a **bug to
  fix against this spec**, not a reason to change the format (see
  [Implementation notes](#implementation-notes)).

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

> **Known gap (as of this doc's writing).** The publish resolver
> (`server/src/publish-plan/ref-resolver.service.ts` → `FileIndexService`) currently
> looks up the pseudo-reference path **verbatim** against a file index keyed
> connection-relative. A workspace-absolute reference (with the connection segment)
> therefore fails to resolve, while a connection-relative one happens to match. That
> is a defect measured against this spec: the resolver (or the upload/apply step that
> feeds it) must strip/translate the connection segment and resolve against the right
> connection. Until that lands, workspace-absolute references authored through the
> desktop can fail at publish with the "Cannot resolve pseudo-ref" error above.

## Related docs

- [`publish-pipeline-flow.md`](./publish-pipeline-flow.md) — the strip → create →
  backfill → resolve mechanism in full.
- [`sync-flow.md`](./sync-flow.md) — how sync produces `@/…` references.
- [`asset-system.md`](./asset-system.md) — the `@asset/<id>` sibling for assets.
- `scratch-git-2/src/cli/commands/generate_docs.rs` — the workspace agent docs that
  teach `@/…` to the desktop's embedded assistant; must match this spec.
