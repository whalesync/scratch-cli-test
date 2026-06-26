# Proof

A keyboard-first **proofing canvas** for a Scratch workspace — *what your content
looks like before it publishes.* Point it at a local workspace and it renders
every record through an **AI-authored, per-folder template**, lets you search
across everything, and opens a preview that shows the published result with the
**word-level edits highlighted in place**.

It's an experiment (sibling to `rad`) exploring a "preview app" direction. It's a
**local app**: a single in-process **Rust + axum + htmx** server, server-rendered
and keyboard-driven. The look is **dark Illustrator (CS6-era)** — the chrome is a
neutral gray *tool* that recedes; the content is the *canvas*, front and center.

---

## Run

```bash
cd experimental/proof
cargo run -- "/path/to/a/scratch/workspace"   # or: PROOF_WORKSPACE=… cargo run
# then open http://127.0.0.1:3220
```

The workspace is any folder containing `.scratch/.scratchmd` (a desktop-app
workspace folder on disk). With no argument, Proof walks up from the current
directory to find one. First run seeds default templates into
`<workspace>/.scratch/proof/views/`.

> **Demo workspace on this machine:** `/Users/joel/My Scratch Folder/My workspace`
> (3733 records across 6 connections — Airtable, Webflow, WordPress, Shopify,
> YouTube — with 6 edited records to show off).
> ```bash
> PROOF_WORKSPACE="/Users/joel/My Scratch Folder/My workspace" cargo run
> ```

---

## Demoing it to someone (the 2-minute tour)

Everything is in the URL, so you can deep-link straight to the good parts.

1. **Open it** → `http://127.0.0.1:3220`. Neutral dark panels on the left (the
   tool); the canvas opens on the right.
2. **Search is instant and server-side.** Type `is:changed` — the list filters to
   the 6 edited records. Other modifiers: `folder:products`, `service:webflow`,
   `conn:airtable`, `is:unreviewed|unpublished|added|deleted`. Free words match
   the whole record.
3. **`j`/`k` to move, `space` to open the preview.** The preview renders the
   record **as it will publish** — a real article page, a product page, an
   embedded YouTube watch page — not a data dump.
4. **The money shot — word-level edits, in place.** Open the edited Webflow post:
   <br>`http://127.0.0.1:3220/?q=is%3Achanged&conn=Webflow&path=Whalesync%20Live%20Site%2FCollections%2FBlog%20Posts%2Fhow-to-export-shopify-orders-to-csv.json&view=custom`
   <br>It's the published article with every edit (here, `CSV`→`spreadsheet`)
   highlighted in amber **right where it happens**. Hover a highlight to see what
   it replaced (struck through). The **right rail** is a change minimap — each
   edit is a band; click to jump. Deletions show a red caret (hover to reveal the
   removed text).
5. **Foreign keys resolve.** The Shopify product preview shows its real image,
   pulled from another folder by gid:
   <br>`http://127.0.0.1:3220/?conn=Shopify&path=Products%2Fcopper-vacuum-insulated-bottle.json&view=custom`
6. **`t` toggles** the bespoke "published" view ⇄ the generic field-by-field diff.
7. **It's deep-linkable.** Refresh any of those URLs and you land in the exact same
   place; browser back/forward work. `r` reloads the workspace from disk (keeping
   your place).

Keyboard map (also under `?` in-app):

| key | action |
|-----|--------|
| `j` / `k` (or ↓/↑) | next / previous record |
| `space` | toggle the preview |
| `enter` | open the preview |
| `t` | preview: default ⇄ custom view |
| `/` | focus search |
| `g g` / `G` | first / last |
| `r` | reload the workspace from disk |
| `esc` | close preview / blur search |
| `?` | help |

---

## The templating ("views") system

How a row looks, and how its preview looks, are **plain HTML files with MiniJinja
expressions** that you (or an AI) write per folder. They live under the
workspace's `.scratch/` — never in a connection content folder — at
`<workspace>/.scratch/proof/views/`, mirroring the workspace tree:

```
.scratch/proof/views/
  default.row.html              default.preview.html        # workspace defaults
  WEBFLOW/Whalesync Live Site/Collections/Blog Posts.row.html
  WEBFLOW/Whalesync Live Site/Collections/Blog Posts.preview.html
  SHOPIFY/Products.preview.html  YOUTUBE/…/Videos.preview.html  …
```

- **Resolution** is most-specific-wins: a user file
  `<SERVICE>/<folder>.{row,preview}.html` → `<SERVICE>.{row,preview}.html` → a
  **shipped per-service default** (Shopify Products, Webflow Blog Posts, WordPress
  Posts, YouTube Videos — embedded from `src/default_views/`, matched by service +
  folder *leaf*, so they work across sites) → `default.{row,preview}.html` → the
  generic built-in. So those four content types look great out of the box, and a
  user file in the workspace overrides them.
- **Hot reload:** files are re-read per request — edit a view and the next
  keypress shows it, no restart.
- **Context:** the record's verbatim JSON as `data` (e.g. `{{ data.fields.Name }}`),
  the published version as `published`, plus `title`, `summary`, `state`,
  `field_count`, and (for previews) `fields`/`changes`.
- **`lookup(folder, match_field, match_value, return_field)`** — resolve a
  foreign key by a literal scan: *in `folder`, find the record whose `match_field`
  equals `match_value`, return `return_field`*. No magic. e.g.
  `lookup("Product Media", "id", data.featuredMedia.id, "image.url")`.
- **`mark(working, published)`** — render an HTML field with the runs that differ
  from `published` wrapped in `<mark>` (HTML-aware), so edits highlight in place
  and the minimap can point at them. e.g.
  `{{ mark(data.fieldData.body, published.fieldData.body) }}`.

Full authoring guide: **`<workspace>/.scratch/proof/views/README.md`** (seeded on
first run). To author a new view, just ask the AI, e.g. *"write a Proof preview
view for WEBFLOW / Blog Posts."*

---

## How it reuses scratch-git-2

Proof imports `scratch-git-2` as a library and reads the **three states** exactly
as the CLI and desktop app compute them:

- **published** = the `main` git tree (`git_local::read_tree_files`)
- **approved** = published + `accepted-patches.json` (`review_ops::compute_accepted_state`)
- **local** = the on-disk worktree (`review_ops::read_worktree_files_and_scratch_state`)

It is **read-only** — it never writes to the workspace (other than seeding/reading
its own `.scratch/proof/views/` templates).

---

## Architecture

Server-authoritative and HTMX-driven — it's a local app, so every interaction is a
round-trip the Rust server renders:

- **`/`** renders the full page from the URL (`?q=&conn=&path=&view=`) — so refresh
  and deep-links restore the filtered list **and** the open preview.
- **`/list?q=`** returns the filtered rows fragment (search is filtered in Rust —
  `workspace::filter_records`); HTMX swaps it into `#list`.
- **`/card?conn=&path=&view=`** returns one record's preview fragment, swapped into
  `#preview`.
- **`/refresh`** reloads the workspace from disk, then redirects back preserving the
  query.

A thin JS layer owns only the keyboard and keeps the URL in sync (pushState /
popstate) for back/forward.

| file | role |
|------|------|
| `src/main.rs` | axum server + routes, the page chrome (maud), CSS, keyboard JS |
| `src/workspace.rs` | load a workspace, three-state records + diffs, search filter, lookup index |
| `src/templates.rs` | MiniJinja per-folder views: resolution, `lookup`/`mark`, default⇄custom |
| `src/diff.rs` | word-level diff → HTML (`mark_changes`, unit-tested) |
| `src/default_views/` | shipped per-service default views (Shopify/Webflow/WordPress/YouTube), embedded via `include_str!` |

---

## Status / next steps

Read-only previewing today. Natural next steps: wire `review_ops` to keyboard
`a`/`r`/`d` for accept/reject/discard, and wrap it in the **Tauri** shell (the
in-process server already runs that way).
