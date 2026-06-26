# Rad

A fast HUD / cockpit for **previewing and reviewing the edits AI agents make to Scratch content** — an experimental alternative to the Electron desktop app. Rust + axum + maud + htmx, **no JS framework**: the server renders to HTML, htmx swaps fragments, and one vanilla-JS block handles keys, filtering, and the minimap.

> **Reading this to demo Rad to someone?** Jump to **[Run it](#run-it)** → **[Demo script](#demo-script)**. The **[Keyboard & deep-links](#keyboard--deep-links)** table is your remote control. **[How it works](#how-it-works)** is there if they ask.

---

## Run it

Rad reads a **local Scratch workspace** — a folder containing `.scratch/.scratchmd` plus one directory per connection (the same layout the `scratchmd` CLI and desktop app use). Point it at one via arg or env:

```bash
cd experimental/rad
cargo run -- "/path/to/My Scratch Folder/My workspace"
# or:  RAD_WORKSPACE="/path/to/workspace" cargo run
# → http://127.0.0.1:3210
```

- Must be run from inside the spinner repo — it has a path-dependency on `../../scratch-git-2` (it reuses that crate's diff/review logic so the results are correct by construction).
- With no argument it falls back to a hard-coded default path (the author's workspace), so **always pass a workspace** on another machine.
- It is **read-only** on the workspace except for the three review actions and template saves (see [Invariants](#invariants)). Nothing is ever published.

### Make a demo edit

The diff/preview features only have something to show once a record has a **local edit**. Either let an AI agent edit records in the workspace, or do it by hand — edit any field in a record's JSON file under a connection folder:

```bash
# e.g. reword a Webflow blog post's title
f="<record>.json"; tmp=$(mktemp)
jq '.fieldData.name = "Updated: " + .fieldData.name' "$f" > "$tmp" && mv "$tmp" "$f"
```

Rad is watching the workspace, so the change **streams into the cockpit live**. These are local working-tree edits — reviewable and reversible; they go nowhere until a `publish`.

---

## Demo script

A ~5-minute path that hits the good parts in order:

1. **The List.** Launch and flip to **List** (top-right) — every record is **one row**, grouped by folder, rendered by its connection's template: Shopify rows look like products (image · type · price · status), YouTube like videos (thumbnail · channel · views), articles like articles. Same-folder rows share columns so they line up; scan them like a spreadsheet that isn't one.
2. **Find things.** Type in the command bar (instant search), or use the **folder rail** on the left — it's a real nested tree (`Scratch Demo ▸ Authors / Posts / …`). Toggle **Changed / All**.
3. **Open a record.** Click a row → the detail pane. It reads as the **clean, near-published result** — the title, the rendered article, the product card. Switch **Preview · Fields · Raw** (Fields = every field in the file, Raw = the literal JSON).
4. **The diff model — the centrepiece.** On a *changed* record:
   - it reads clean; a **margin bar** + the **right-edge minimap** show *where* the edits are;
   - **hold `space`** → every edit flashes on at once (iridescent "AI-magic" glow); release → clean again;
   - **hover** an edit → `was: <original>`;
   - **`n` / `p`** → step edit-to-edit.
   - (Deep-link `&reveal=1` opens straight into the lit state for a screenshot.)
5. **The template studio** — click **✦ Templates** (or `?openstudio=1`). Every template is listed with its JSON editable on the left and a **live sample row + card** on the right. Change a field mapping, hit **Save & apply** — it validates, writes, and re-renders live. The pitch line is in the header: *"Claude can write these too."*
6. **Review.** `a` / `r` / `d` (or the buttons) accept / reject / discard the selected record. Nothing is published.
7. **Live.** Leave it open and make another edit in the workspace — it streams in without a refresh.

---

## Keyboard & deep-links

**Keys** (shown in the footer):

| key | action |
| --- | --- |
| `j` / `k` or `↑` / `↓` | move selection in the list |
| `a` / `r` / `d` | accept / reject / discard the selected record |
| **hold `space`** | reveal every edit in the open record |
| `n` / `p` | step edit-to-edit within the open record |
| `/` or `⌘K` | focus search |
| `Esc` | close search / the template studio |

**URL params** (compose freely — handy for demos, deep-links, and scripted screenshots):

| param | effect |
| --- | --- |
| `conn=<DirName>` · `folder=<Folder/Path>` | scope the list to a connection / folder |
| `sel=<N>` | select the Nth visible row |
| `view=patterns` | open in **List** mode (default is **Review**) |
| `dview=preview\|fields\|raw` | which detail tab is active |
| `showall=1` | **All** records (default is **Changed** only) |
| `reveal=1` | open with all edits lit (the hold-space state) |
| `openstudio=1` | open straight into the template studio |
| `nostream=1` | disable the live SSE stream (use for static screenshots) |

---

## How it works

**Modules** (`src/`):

| file | role |
| --- | --- |
| `main.rs` | the axum server: routes, all HTML rendering (maud), and the embedded CSS + vanilla JS |
| `workspace.rs` | loads a workspace and computes the **three-state, field-level diffs** |
| `cards.rs` | the declarative **card-template** system |
| `review.rs` | accept / reject / discard, mirroring the CLI's review ops |

**Three-state diff (correct by construction).** For every field Rad compares three snapshots, read via `scratch-git-2`'s own `shared` modules so they match the CLI/desktop exactly:
- **published** = the `main` git tree,
- **approved** = published + `accepted-patches.json`,
- **local** = the working tree on disk.

A record is *unreviewed* (local ≠ approved), *unpublished* (approved ≠ published), *added*, *deleted*, or *unchanged*.

**Card templates** (`.scratch/rad/cards/*.json`). Declarative, per service/folder, picked most-specific-first. Each maps record field-paths to **slots** (image / title / subtitle / price / body / badge — drive the preview card) and **columns** (drive the aligned List row). Archetypes: `product` · `video` · `article` · `generic`. Defaults are **seeded on startup** (only if absent) and **hot-reloaded** every render, so editing a file — in the studio or on disk — takes effect immediately. Image slots resolve direct `http(s)` URLs, or a `gid://…` reference (e.g. Shopify `featuredMedia.id`) via a **workspace media index** built from records that carry an image URL — a files-based foreign-key lookup, no external fetch.

**Diff display.** Every changed field (plain text or HTML) goes through one renderer, `render_field_diff`, which tokenizes (HTML tags stay atomic; plain text is escaped), diffs with `similar`, and wraps inserted text in `<mark class="ins" data-before="…">`. The marks are **invisible in the flow** and light up only on hover / `.rad-focus` / `#console.rad-reveal` (hold-space). A left **margin bar** flags changed blocks; the **minimap** maps the detail scroll and ticks each edit.

**Lazy detail.** The list renders empty detail placeholders; the full preview/fields/raw for one record is fetched from `/api/detail` on selection. This keeps the page (and every live re-render) light at scale — a ~3,700-record workspace stays ~5 MB instead of ~28 MB.

**Live updates.** `notify` watches the workspace → a debounced `tokio::broadcast` tick → SSE (`/api/events`) → htmx re-fetches `/api/console`. So an agent's edits stream in without a refresh.

---

## Invariants

- **Read-only** on user data except the three review actions (`/api/review`, `/api/review-bulk`) and template saves.
- **Templates are only ever written to `.scratch/rad/cards/`** — never to a connection folder (those are what get published). `save_template` rejects path-escape and any non-`*.json` name, and only writes if the JSON parses as a template.
- `experimental/` is a sandbox — Rad is **not** part of the product build and nothing else depends on it.

---

## Open items

- **Block-level before/after** for wholesale paragraph rewrites (stepping word-by-word through a fully-rewritten paragraph is tedious).
- **Minimap → snap-to-change** so clicking a tick focuses that edit (shares the model with `n`/`p`).
- **In-memory view cache** — `/api/console` and `/api/detail` reload the workspace each call; caching it (invalidated by the fs-watch) would make live re-renders and first-open instant at scale.
- **`rad review` handshake** — a CLI command that blocks, flashes "READY FOR REVIEW", and pipes structured accept/reject feedback back to the agent.
