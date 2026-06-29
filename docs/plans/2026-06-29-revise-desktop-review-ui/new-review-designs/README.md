# Handoff: Content Diff Review (in-app)

## Overview
A redesign of Whalesync's **"review content diffs"** experience — the screen where a user
reviews pending changes pulled from a source before publishing them to a destination. The
guiding principle throughout: **surface only what actually changed and push everything
unchanged out of the way.** The redesign is shown in the real app context (Shopify ›
Products sync, "Acme Store" workspace) with a working bulk-review surface and a drill-in
detail diff.

The flagship file is `Whalesync App.dc.html` — the full app shell (top bar + connector
tree) wrapping the new review surface. The `reference/` folder holds two earlier
standalone explorations that the flagship was assembled from.

## About the Design Files
The files in this bundle are **design references created in HTML** — interactive
prototypes that show the intended look and behavior. They are **not production code to
copy directly.**

They are authored as "Design Components" (`.dc.html`): a custom runtime (`support.js`,
not included) parses a `<x-dc>` template and a `class Component extends DCLogic` script
(a thin wrapper over a React class component — `renderVals()` returns the values the
template interpolates). **Do not port the DC runtime.** Read these files to understand
layout, styling, copy, and interaction, then **recreate the design in Whalesync's existing
codebase** (React, per the design system below) using its established components and
patterns. Much of the rendering logic in `Whalesync App.dc.html` is plain
`React.createElement` inside the logic class and translates directly to ordinary JSX.

## Fidelity
**High-fidelity.** Final colors, typography, spacing, and interactions are all intended as
shown. Recreate pixel-faithfully using the Scratch design system's components and tokens.
One caveat: the **top-bar buttons use ~6px rounded corners to match the live app
screenshot**, whereas the Scratch DS tokens default to square corners
(`--mantine-radius-default: 0rem`). Follow the live app where they conflict.

## Design System
Whalesync's **Scratch design system** (`scratch-desktop@0.1.0`, a Mantine-based React
library; global `window.ScratchDS`). The compiled token/styles CSS is included under
`design-system/` for reference (`styles.css` @imports `_ds_bundle.css`). In the real
codebase, build with the actual `ScratchDS` components — do not recreate them.
- Type: **Funnel Display** (headings/titles), **Inter** (body/UI), **Geist Mono** (labels,
  IDs, counts).
- Primary action color: the yellow highlight — `var(--highlight-fill)` on
  `var(--highlight-border)`.
- Review-state strokes (from tokens): `--modified-needs-review-stroke`,
  `--create-needs-review-stroke`, `--delete-needs-review-stroke`.

---

## Screens / Views

### 1. App shell (`Whalesync App.dc.html`)
Full-bleed desktop app, flex column: **top bar** (60px) over a **main row** (sidebar +
content).

**Top bar** (height 60px, white, 1px bottom border `#e7e9ec`, 16px h-padding, items
center-aligned, 9px gap):
- Logo mark: 30×30, radius 7px, `var(--highlight-fill)` bg, `var(--highlight-border)`
  border, black "W" in Funnel Display 700/14px.
- Workspace name "Acme Store" — Funnel Display 600/17px `#1c1f23` — followed by a small
  `▼` caret `#9aa0a6`.
- Spacer pushes the rest right.
- Three **ghost buttons** (`.tbtn`: Inter 500/13.5px `#3c4248`, 8px×11px padding, radius
  6px, 16px stroke-`#6b7178` icon, hover bg `#f1f3f5`): **Open in…** (external-link icon),
  **Re-download files** (download icon), **Pull all** (download icon + small `▼`).
- **"N to review" pill** (`data-act="review"`): bg `#e7effe`, border `#cadcfb`, text
  `#0551cd`, Inter 500/13px, 8px×14px, radius 6px. N = pending count.
- **"Publish all · N" primary** (`data-act="publish"`): bg `var(--highlight-fill)`, border
  `var(--highlight-border)`, black text Inter 600/13px, 8px×15px, radius 6px, leading
  upload icon (black, 15px). N = approved count.
- Kebab `⋮` `#9aa0a6` 19px.

**Sidebar** (width 300px, white, 1px right border `#e7e9ec`, flex column): scrollable
folder tree on top, "286 total files" footer row (1px top border, right-aligned, 11px
`#9aa0a6`), then a secondary nav block (1px top border).
- **Tree rows** (`.trow`: 13px `#3c4248`, 5px×10px padding, 8px h-margin, radius 5px, 7px
  gap, hover `#f3f4f6`). Expand caret `▼` is `.cv` (11px-wide, 8px `#9aa0a6`). Folder glyph
  `.fi` (15px, stroke `#8b9199` 1.6, path
  `M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z`). Right-aligned
  count `.cnt` (11.5px `#9aa0a6`, tabular-nums).
- Indentation by `padding-left`: L0 connection = 12px, L1 = 40px, L2 = 68px.
- Tree content: **Airtable** ▸ Blog Posts (12), Authors (8); **Webflow (Demo)** ▸
  Collections ▸ Blog (CMS) (40); **Shopify** ▸ **Products (248, active)**, Collections (18).
- **Active row** (Products): bg `#fdf3c4`, text `#3a3500` 500, folder stroke `#7a6f00`,
  count `#7a6f00`; two 6px status dots before the folder glyph — blue `#0551cd` (modified)
  + gray `#c4cad0`.
- **Secondary nav** (`.snav`: 13px `#495057`, 8px×16px, 11px gap, 16px stroke-`#6b7178`
  icon, hover `#f3f4f6`): Connections, **Validation** (trailing green `#15803d` check),
  Publish History, Workspace Settings, and a user row (22px gray avatar "DK" +
  "dana@acme.store").

### 2. Review surface (content area of the shell; standalone twin = bulk concept)
Flex column filling the content area.

**Context banner** (flex none, 13px×20px padding, bg `#fffaf0`, 1px bottom border
`#f0e6cf`): a 9×20 yellow chip (`var(--highlight-fill)`/border), then a two-line block —
"Review before publishing to Shopify · Products" (Funnel Display 600/15px `#212529`) over
"N pending · M approved · changes pulled from Google Sheet" (Geist Mono 11px `#9a7b00`).
Right: **Discard all** button (`data-act="reject-all"`; white, 1px `#ced4da`, `#343a40`,
12px, 8px×13px).

**Subbar** (flex none, 10px×20px, bg `#fbfbfc`, 1px bottom border `#eef0f2`):
- **View toggle** (1px `#ced4da` box, square): **Table** / **By type**
  (`data-act="view-table"|"view-bytype"`). Active segment = bg `#212529`, white text
  (driven by `[data-view]` on an ancestor).
- **Filter chips** (`.fchip`, only visible in Table view; Geist Mono 10px, 5px×9px, 1px
  `#dfe3e7`, white): All / price / description / inventory / new / removed, each with a 6px
  color dot (blue `#0551cd` for modified-field types, green `#15803d` new, red `#be123c`
  removed) and a live count. Active chip = bg `#212529`, white.
- Right: live "M approved" (Geist Mono 11px `#15803d`) "· N pending" (`#adb5bd`).

**Body — Table view** (horizontal scroller, inner `min-width:1040px`):
- Row grid columns: `34px 230px 150px 104px minmax(280px,1fr) 120px` =
  checkbox · Product · Price · Inventory · Description · Status.
- Header row: sticky, Geist Mono 10px uppercase `#868e96`, 1px bottom border `#dee2e6`.
- Each cell: 6px×12px padding, vertically centered, 1px right border `#f4f5f7`, min-height
  34px. **A changed cell gets bg `rgba(5,81,205,.06)`** (the wayfinding wash); unchanged
  cells transparent.
- Row click opens the detail drawer. New-product rows tinted `rgba(21,128,61,.045)` with
  green names; removed rows `rgba(190,18,60,.04)` with red strike-through names. A
  rejected row drops to 0.45 opacity. Approved/rejected rows show a `✓`/`✕` in the
  checkbox cell.
- **Inline diff cells**: price/inventory render `<del>old</del> <ins>new</ins>`;
  description renders a one-line truncated token diff. Strike-through (`del.d`):
  `text-decoration:line-through; text-decoration-color:rgba(190,18,60,.5); color:#9f1239`.
  Insertion (`ins.a`): `color:#15803d` (no underline). **Convention: deleted text always
  precedes inserted text.**
- Status pill (Geist Mono 10px, 2px×7px): modified `#e9f9ee`/`#15803d`, created
  `#dcfce7`/`#15803d`, removed `#ffe4e6`/`#be123c`.

**Body — By type view** (grouped):
- One block per change type: Price, Description, Inventory, New products, Removed. Group
  header (bg `#fbfbfc`, 13px×20px): 8px color dot, group name (Funnel Display 600/15px,
  colored for new/removed), Geist Mono count, an optional summary pill (e.g. Price → "avg
  −10% · mostly lowered", bg `#eef3ff` `#0551cd`), and a right-aligned **"Approve all N"**
  button (white, 1px `#c8d3ee`, `#0551cd`, 11px; flips to "All approved ✓" / bg `#e9f9ee`).
- Group rows: a `✓`/`✕`/blank status glyph, a 200px-wide name, a flex diff/preview cell,
  and a trailing value (% change for price, "view →" for description, "units" for
  inventory). Row click opens the drawer scoped to that group.

### 3. Detail diff drawer (right-side overlay)
Opened by clicking any row. Fixed full-viewport scrim `rgba(33,37,41,.28)`, panel pinned
right: 640px wide (max 92vw), white, `box-shadow:-12px 0 40px rgba(0,0,0,.18)`, flex
column.
- **Header** (13px×18px, 1px bottom border `#eef0f2`): "← All changes" chip (Geist Mono
  11px, bg `#f1f3f5`), spacer, **↑ / ↓ stepper** with "i / n" (steps within the current
  filtered/grouped set, wraps), and a `✕` close.
- **Title block**: product name (Funnel Display 600/18px), a state badge
  (MODIFIED `#e0e7ff`/`#0551cd`, NEW `#dcfce7`/`#15803d`, REMOVED `#ffe4e6`/`#be123c`),
  "product i of 248", and an approved/rejected marker when set.
- **Field blocks** (scroll area): only changed fields are shown, each under a Geist Mono
  10px uppercase label with a 1px top border. Price/Inventory render `old → new` (+ %
  for price). Removed products show an "will be archived" explanation instead.
- **Description block** — the key interaction. A segmented toggle: **Changes only** vs
  **Full + map**.
  - *Changes only*: renders only the paragraphs that changed (inline redline), collapsing
    runs of unchanged paragraphs into a divider "▾ N unchanged paragraph(s)" (Geist Mono
    10px `#adb5bd` + dashed rule). **No background wash on changed lines here** (everything
    shown is a change, so the wash is redundant).
  - *Full + map*: the entire description in a 470px scroll pane (left) beside a 56px **MAP
    rail** (right). The rail draws a 6px tick (`--modified-needs-review-stroke`) at each
    changed paragraph's true vertical position, plus a live "viewport" box
    (1.5px `#0551cd`, bg `rgba(5,81,205,.06)`) that tracks the reader's scroll. Tick and
    viewport positions are computed from `offsetTop / scrollHeight` on scroll and after
    layout. Body paragraphs: 14.5px/1.78 `#3c4248`.
- **Footer** (13px×20px, 1px top border `#dee2e6`): "↑ ↓ to step" hint, **Reject**
  (`#fff0f1`/`#f7c9cf`/`#be123c`; "Keep product" for removed), **Approve · next →**
  (yellow primary) which approves and auto-advances.

---

## Interactions & Behavior
- **Top bar**: `Publish all` approves all currently-pending items (prototype stand-in for
  publish). `Pull all`, `Open in…`, `Re-download`, `N to review` are non-functional
  placeholders. In production, wire these to the real sync/publish actions.
- **View toggle / filters**: switch the body between Table and grouped views; filter chips
  narrow the Table rows and scope the drawer's stepper to the filtered set.
- **Row → drawer**: opens the detail diff for that record, with prev/next stepping bounded
  to the active set (wraps at ends).
- **Approve / Reject**: per-record (drawer) or bulk (group "Approve all", header "Discard
  all", top-bar "Publish all"). Approve in the drawer auto-advances to the next record.
  All counts (pending/approved, chip counts, button labels) update live.
- **Description toggle**: Changes-only ⇄ Full+map per the spec above. The map's tick +
  viewport positions recompute on scroll and after each render while in Full+map mode.
- Delegated click handling: most actions are dispatched via `data-act` attributes read by
  a single root `onClick` (see `onClick()` in the logic class) — a pattern you can keep or
  replace with normal handlers.

## State Management
From the logic class (`renderVals` derives the rest):
- `view`: `'table' | 'bytype'`.
- `filter`: `'all' | 'price' | 'description' | 'inventory' | 'new' | 'removed'`.
- `drawer`: `null | { set: number[], idx: number }` — the ordered id set being stepped and
  the current index.
- `descView`: `'changes' | 'full'` — description diff mode.
- `statuses`: `{ [recordId]: 'approved' | 'rejected' | null }`.
- Derived: `approvedCount`, `pendingCount`, and per-type changed counts.
- Per-record data shape: `{ id, name, kind: 'modified'|'created'|'deleted', status,
  price{changed,from,to,pct,dir|now}, inv{changed,from,to|now},
  desc{changed,isNew,preview[],full[][]} }`. A diff token is `['e'|'d'|'i', text]`
  (equal / deleted / inserted); `desc.full` is an array of paragraphs, each an array of
  tokens.
- Real data: replace the in-file `P = [...]` fixture with the actual change records from
  the review store; compute token-level diffs server- or client-side.

## Design Tokens
- **Yellow / primary**: `var(--highlight-fill)`, `var(--highlight-border)`; active-folder
  wash `#fdf3c4`; banner bg `#fffaf0`.
- **Modified (blue)**: stroke `var(--modified-needs-review-stroke)` / `#0551cd`; cell wash
  `rgba(5,81,205,.06)`; pill bg `#e0e7ff`; review pill bg `#e7effe` border `#cadcfb`.
- **Created (green)**: `var(--create-needs-review-stroke)` / `#15803d`; row tint
  `rgba(21,128,61,.045)`; pill `#dcfce7`.
- **Deleted (red)**: `var(--delete-needs-review-stroke)` / `#be123c` / `#9f1239`; row tint
  `rgba(190,18,60,.04)`; pill `#ffe4e6`; reject btn `#fff0f1`/`#f7c9cf`.
- **Neutrals**: text `#1c1f23`/`#212529`/`#3c4248`/`#495057`; muted `#868e96`/`#9aa0a6`/
  `#adb5bd`; borders `#e7e9ec`/`#eef0f2`/`#f1f3f5`/`#dee2e6`; surfaces `#fff`/`#fbfbfc`/
  `#fafbfc`.
- **Radius**: 5–7px on app chrome (matching live app) — note this overrides the DS square
  default; review-surface chips/cells are square.
- **Type**: Funnel Display (600/700 for titles), Inter (400/500/600 UI), Geist Mono
  (400/500 labels, counts, IDs). Sizes per component above.
- **Diff text**: `del.d` line-through `rgba(190,18,60,.5)` on `#9f1239`; `ins.a` `#15803d`
  no underline.

## Assets
- **Fonts**: Funnel Display, Inter, Geist Mono (Google Fonts in the prototype; use the
  codebase's bundled equivalents).
- **Icons**: inline SVG (folder, external-link, download, link/plug, shield-check, list,
  gear, check, search). Replace with the codebase's icon set.
- **No raster images or logos** — connector "logos" in earlier drafts were removed; the
  current tree uses neutral folder glyphs only.
- DS token CSS is under `design-system/` for reference; in production consume the real
  `ScratchDS` package, not these copies.

## Files
- `Whalesync App.dc.html` — **the flagship**: app shell + sidebar + review surface +
  detail drawer. Start here.
- `reference/Post Diff Review v2.dc.html` — standalone long-form post diff with the
  Changes-only ⇄ Full+map toggle and the minimap; the origin of the drawer's description
  view.
- `reference/Bulk Diff Concepts.dc.html` — the bulk-review concept board (Table + By-type
  lenses) the flagship's review surface was built from.
- `design-system/_ds_bundle.css`, `design-system/styles.css` — Scratch DS compiled tokens
  & styles, for value reference only.

> Note: the `.dc.html` files reference the design system via a project-relative
> `_ds/scratch-design-system-.../` path that won't resolve outside the original project.
> That only affects the live `ScratchDS` component mounts (none remain in the flagship) —
> the token CSS is mirrored under `design-system/` here. Open the files as source to read
> the design; they are not meant to run standalone.
