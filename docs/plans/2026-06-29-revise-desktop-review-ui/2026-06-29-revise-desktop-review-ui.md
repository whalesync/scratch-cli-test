# Revise Desktop Review UI — Phased Implementation Strategy

- **Status:** In Progress
- **Created:** 2026-06-29
- **Author:** Chris Hoefgen
- **Parent issue:** [DEV-10615 — [MAJOR] Revise desktop review UI](https://linear.app/whalesync/issue/DEV-10615/major-revise-desktop-review-ui)
- **Child issues (all assigned to Chris Hoefgen):** Phase 0 [DEV-10617](https://linear.app/whalesync/issue/DEV-10617) · Phase 1 [DEV-10616](https://linear.app/whalesync/issue/DEV-10616) *(in progress)* · Phase 2 [DEV-10618](https://linear.app/whalesync/issue/DEV-10618) · Phase 3 [DEV-10619](https://linear.app/whalesync/issue/DEV-10619) · Phase 4 [DEV-10649](https://linear.app/whalesync/issue/DEV-10649) · Phase 5 [DEV-10620](https://linear.app/whalesync/issue/DEV-10620). See §8 for the build order.
- **Design source:** [`new-review-designs/README.md`](./new-review-designs/README.md) and the `.dc.html` prototypes alongside it (flagship: `Whalesync App.dc.html`).
- **Scope note:** This plan focuses **mostly on the dedicated review surface** — the screen the user lives on while reviewing pending changes (Table view, By-type view, filter chips, and the detail drawer). The app shell (top bar + sidebar) is covered only where it needs touching. Implementation will happen in **other sessions**, one merge request per phase.
- **Already in flight:** **the detail drawer (Phase 1) has been started** under child issue [DEV-10616 — Record changes panel](https://linear.app/whalesync/issue/DEV-10616) — branch `dev-10616-record-changes-panel` (Conductor worktree `beirut`). It is deliberately picked up first because the drawer is the most independent chunk: it adds a new component beside the grid and does **not** depend on the FolderDataGrid restyle, filter chips, or By-type view. See §4 Phase 1 for what's built vs. remaining.

> Each numbered phase below is intended to become its own **Linear child issue under DEV-10615**. Those issues will be generated once this plan is approved (DEV-10616 already exists for Phase 1). Not everything in the design will be built — the **Work Chunk Catalog** exists so we can decide, chunk by chunk, what is worth building before committing each phase.

---

## 1. Guiding constraints

1. **Don't break the existing structure.** The production review experience is a mature, canvas-based grid (`FolderDataGrid.tsx`, ~148 KB) plus a detail view (`RecordDetailView.tsx`, ~60 KB) and a publish modal (`PublishChangesModal.tsx`, ~72 KB). New surfaces are layered in **additively** and behind a flag where they replace something; we reach parity before removing anything.
2. **Layer over multiple MRs.** Each phase is independently shippable and independently revertible. A half-landed redesign must still leave the app fully usable.
3. **Reuse the foundations that already exist** (see §3). The design was authored directly on the desktop app's own tokens and primitives, so most of the work is *composition and grouping*, not building diff/colors/state from scratch.
4. **Server-first only where required.** This work is almost entirely renderer-side. The review-state ladder (published → approved → local) and its CLI/IPC calls already exist; no new server endpoint is anticipated for the core review surface. Flag any phase that turns out to need a server change so it lands as a separate, earlier MR.

---

## 2. What already exists vs. what's new

The single most important planning fact: **the new design is ~75% restyle/recompose of surfaces that already exist, and ~25% genuinely new capability.** Mapping the three design surfaces onto today's code:

### App shell (top bar + sidebar) — *mostly already exists*
- **Top bar** — `WorkspaceHeader.tsx` already renders the workspace name, **Open in…**, **Pull all**, **Publish all · N** (carries the approved-pending count, `approvedPendingPublishCount`), and the **"N to review" pill** gated on `unreviewedCount` (DEV-10449/DEV-10615 lineage). The "Re-download files" action and exact pill styling are the only deltas.
- **Sidebar** — `WorkspaceSidebar.tsx` + `FolderTree.tsx` already render the connector/folder tree with per-folder **needs-review (blue) / approved (gray) dots** (fed by `useReviewStats` → `ReviewStat`), the "N total files" footer, and the secondary nav (Connections / Validation / Publish History / Workspace Settings / user row).
- **Verdict:** Treat the shell as **out of primary scope**. Pick up only the small restyle deltas if/when we want pixel parity (see optional Phase 5).

### Review surface — *Table view exists; By-type view is new*
- **Table view** ≈ today's `FolderDataGrid`. It already has: the **changed-cell wash** (`--modified-needs-review-bg`), **inline word diffs** (`getWordDiffSegments` in `shared/word-diff.ts`, drawn on canvas via `drawWordDiffText`), **created/deleted row tints** (`--create-*` / `--delete-*` tokens), **status dots**, **filter pills** (`GridFilter`: `needs-review` / `approved` / `has-problems`, global + per-column scope in `workspace-ui-store`), and **bulk approve / reject / discard** (`acceptGridFieldChanges`, `rejectAllChanges`, `discardAllChanges`, with a confirm modal). The design's Table view is a **restyle + a couple of additions** (per-change-type filter chips like *price / description / inventory / new / removed* with live counts; status pills), not a rebuild. The in-cell diff *rendering* itself — inline diffs for every field size (incl. long text), solid change-type fills, diff-aware column widths, and **dropping** the diff popover + Unified diff view — is reworked in **Phase 4** (the one phase that touches the canvas draw loop, flag-gated).
- **By-type view** — **net new.** No grouped-by-change-type surface exists anywhere today. This is the headline new capability: group pending changes by *what changed* (a field, a create, a delete), with per-group summary pills and **"Approve all N"** bulk actions.

### Detail diff drawer — *new drawer in progress (DEV-10616); description minimap still new*
- `RecordDetailView.tsx` provides the full per-record detail with **prev/next stepping** (`onSelectIndex`), **per-field diffs**, **per-field and per-record approve / reject / discard**, and the published/approved/local model. It renders **inline, replacing the grid** (driven by `selectedRecordFilename`).
- **In progress:** rather than re-housing `RecordDetailView`, a **new `RecordChangesDrawer`** (right-side overlay) has been built as a fast review-and-act surface that coexists with the inline view (see §4 Phase 1). Single-click a changed row → drawer; double-click → inline editor. Shared diff helpers were extracted to `record-diff-helpers.ts` so both consume one model.
- **Still new / ahead:** the **description block's "Changes only" vs "Full + map" toggle and the minimap rail** (tick marks at changed paragraphs + a scroll-tracking viewport box) — the most novel piece, prototyped in `reference/Post Diff Review v2.dc.html`. Not in the drawer yet (Phase 3 / chunk K).

---

## 3. Shared foundations (build/confirm once, reuse everywhere)

These already exist in the codebase and are what makes the redesign tractable. Confirm and, where noted, extend them **before** the surface phases.

| Foundation | Status today | Notes for the redesign |
| --- | --- | --- |
| **Review-state tokens** (`--modified/create/delete-needs-review-{bg,stroke}`, `--highlight-fill/border`) | ✅ Defined in `src/renderer/src/theme/globals.css` | The design references these exact vars. No new palette needed. |
| **Word-diff engine** (`getWordDiffSegments`) | ✅ `scratch-git-2`-shared `shared/word-diff.ts` | Powers inline `del`/`ins` cells. The design's "deleted precedes inserted" convention matches our segment model. |
| **Review stats / counts** (`ReviewStat { unreviewed, approved }`, `useReviewStats`, `buildApprovedPublishBreakdown`) | ✅ `hooks/use-review-stats.ts`, `pages/workspace/review-publish-breakdown.ts` | Per-folder pending/approved counts arrive over IPC and refresh on a debounced "review-stats-may-have-changed" event. The design's live pending/approved counters bind to these. **Gap:** per-*change-type* counts (price vs description vs new vs removed) are **not** computed today — the By-type view needs a new client-side grouping derived from the already-loaded diff rows (no server change). |
| **Review-state ladder actions** (accept / reject / discard, per-field / per-record / bulk) | ✅ Wired through `window.scratchDesktop.*` IPC → `scratchmd` CLI | All new bulk affordances ("Approve all N", "Discard all") reuse these. Respect the ladder ([REVIEW_MODEL](/scratch-git-2/docs/REVIEW_MODEL.md)) — a "reject" touches only the working tree, never the approved set. |
| **Filter state** (`GridFilter`, `activeFilters` in `workspace-ui-store`) | ✅ Global + per-column scope | The design's filter chips extend this with *change-type* facets. Add new `FilterKind`s (or a parallel facet) rather than forking a second filter system. |
| **Detail stepping + per-field diff** (`RecordDetailView`, `RecordFieldsGrid`, `diff-renderers.tsx`, `unified-diff-cell.ts`) | ✅ | The drawer reuses this wholesale; only the *housing* (drawer vs inline) and the *description minimap* are new. |
| **Non-production design reference** (`components/base/ds/screens/*`) | ℹ️ Storybook `/design-sync` reproductions, **not** shipped UI | `WorkspaceShell.tsx`, `RecordDetailView.tsx` (ds), `PublishReviewModal.tsx` here are *mirrors* built so Claude Design had an accurate picture. Use them as a styling reference and a Storybook harness; **do not** wire them into the app. |

**Net:** there is **no new diff algorithm, no new color system, and no new review-state backend** to build. The new work is grouping, a new view, a drawer housing, and one novel minimap component.

---

## 4. Phased plan (each phase → one Linear child issue → one MR)

Phases are ordered to **lead with the most independent net-new surfaces** (the detail drawer, already in flight; then the By-type view and the description minimap) and to **defer every change that touches the Table view's header/chrome to the end** — and to **leave the app shell alone entirely** for now (moved to Future Work). Pick which phases to build from the Work Chunk Catalog in §5.

> **Deliberate ordering decision (2026-06-29):** the Table-view changes — the **cell-body diff rendering (Phase 4)** and the **header/chrome (Phase 5)** (context banner, subbar, status pills, **and** change-type filter chips) — are intentionally sequenced **last**, *after* the drawer, By-type view, and minimap. Phase 5 stays *off* the canvas draw loop (it wraps the grid); **Phase 4 is the one deliberate exception that edits the `drawCell` loop** — flag-gated (`desktop-review-surface-v2`) so it ships dark. The app shell (top bar + sidebar) is **not** in scope right now and lives under Future Work. This keeps the early phases off the mature `FolderDataGrid` chrome and the app shell, lowering the risk of regressing surfaces users rely on today.

### Phase 0 — Foundations & feature-flag scaffold *(small, do first)* — [DEV-10617](https://linear.app/whalesync/issue/DEV-10617)
- Add a feature flag (OpenFeature/PostHog, per repo convention) — e.g. `desktop-review-surface-v2` — that gates the new surfaces so phases can ship dark and be toggled per-user.
- Stand up a **client-side change-type grouping selector**: a pure function over the already-loaded diff rows that buckets each pending change into `{ field-modified (per column), created, deleted }` with counts. This is the data backbone the **By-type view (Phase 2)** and the **filter chips (Phase 5)** both consume. No server/IPC change.
- Add Storybook stories for the new primitives as they land (the `base/ds` harness already exists).
- **Risk:** low. **Touches:** new `pages/workspace/review-surface/*` module, `workspace-ui-store` (flag-scoped UI state), a new `*.ts` grouping helper + test.

### Phase 1 — Detail drawer (`RecordChangesDrawer`) *(IN PROGRESS — DEV-10616)*
**Started first because it is the most independent chunk** — a new component beside the grid that doesn't depend on the Table restyle, filter chips, or By-type view. Branch `dev-10616-record-changes-panel` (worktree `beirut`).

**Built so far** (uncommitted on the branch):
- New `pages/workspace/RecordChangesDrawer.tsx` (~509 lines) — a **right-side drawer overlay** (`Portal` → `#portal`, fixed scrim `rgba(33,37,41,.28)`, 640 px / max 92vw panel with the design's `-12px 0 40px` shadow). Faithful to the design: **header** ("← All changes" back chip, ↑/↓ stepper showing "i / N", close X), **title block** (record name + a state badge keyed exhaustively by `__rowStatus` → NEW/MODIFIED/REMOVED with the matching `--create/modified/delete-*` tokens, plus a session ✓ approved / ✕ rejected marker), **changed-fields-only body** (per-field `from → to` redline for modified, value-only for created, explanatory copy for deleted/invalid), and **footer** (Reject / "Keep record" for deletes, and **Approve · next →** auto-advance).
- New `pages/workspace/record-diff-helpers.ts` — extracted the shared diff types/helpers (`DiffRecordData`, `DiffRow`, `DiffRowStatus`, `getRecordName`, `toDisplayString`, `rowHasUnreviewedChanges`) **out of** `RecordDetailView.tsx` so the drawer and the inline view share one source of truth (a `.ts`, not `.tsx`, to satisfy `react-refresh/only-export-components`).
- `FolderDataGrid.tsx` wiring — a **single-click on a changed row** opens the drawer (after a 250 ms delay so a deliberate double-click still opens the inline editor); the stepper set is the page's **changed records only** (`changedRecordFilenames`), mutually exclusive with the inline `RecordDetailView` (opening one closes the other); drawer closes on folder change or when its record leaves the changed set.
- `posthog.ts` — `trackOpenRecordChangesDrawer`.

**Design choices that differ from the original plan assumption (worth noting):**
- It is a **purpose-built drawer**, *not* a re-housing of `RecordDetailView`. The inline `RecordDetailView` stays as-is for the full per-field edit/inspect experience; the drawer is the fast review-and-act surface. They coexist.
- The drawer currently does **record-level** approve/reject only — it does **not** yet include per-field inline editing or the description "Changes only / Full + map" minimap (that is Phase 3 / chunk K, still ahead).

**Remaining for this phase (decide what's in DEV-10616 vs. a follow-up):**
- Stepper scoping to the *filtered/grouped* set once the By-type view (Phase 2) and filter chips (Phase 5) land (today it's the page's changed set — fine as a standalone).
- Feature-flag gate (if we want it dark until the rest of v2 catches up) — currently it's a live behavior change to row-click.
- Keyboard ↑/↓ stepping + Esc to close (the footer hints "↑ ↓ to step"); confirm wired.
- QA per `/qa-desktop-app` against the live test backend before committing (client-only change, real UI).
- **Risk:** low–medium — additive new component, but it changes single-click row behavior app-wide; gate or confirm that's desired. **Touches:** `RecordChangesDrawer.tsx` (new), `record-diff-helpers.ts` (new), `FolderDataGrid.tsx`, `RecordDetailView.tsx` (helper extraction), `posthog.ts`.

### Phase 2 — By-type grouped review view *(NEW capability, large)* ⭐ — [DEV-10618](https://linear.app/whalesync/issue/DEV-10618)
- The headline net-new surface. Add the **"Table / By-type" view toggle** and the grouped view: one block per change type (each modified field, New, Removed), with a **group header** (color dot, name, count, optional summary pill such as "avg −10% · mostly lowered" for numeric fields), a right-aligned **"Approve all N"** bulk action (flips to "All approved ✓"), and **group rows** (status glyph, name, a compact diff/preview cell, trailing value). Row click opens the **drawer from Phase 1**, scoped to that group.
- Built as a **sibling view** to the canvas grid (DOM, not canvas) selected by the view toggle — the grid stays the default; By-type is opt-in. Bulk actions reuse the existing accept/reject ladder and the Phase 0 grouping selector.
- The **summary pill** computations (e.g. average % change, "mostly lowered") are per-field-type and may be scoped down to a first set (numeric % for price-like fields) with others added later — call this out in the issue as a sub-decision (chunk H).
- **Risk:** medium — additive (new view), but it's the largest single chunk and introduces a second rendering path for the same data. *Mitigation:* consume the **one** Phase 0 grouping selector and reuse the Phase 1 drawer for the act-on-it step. **Touches:** new `review-surface/ByTypeView.tsx` + group/row components, `workspace-ui-store` (view mode), the grouping helper. **Does not touch the canvas grid's draw loop or the app shell.**

### Phase 3 — Description "Changes only / Full + map" minimap *(NEW capability, large)* ⭐ — [DEV-10619](https://linear.app/whalesync/issue/DEV-10619)
- The most novel component. Inside the **drawer's** description block (Phase 1), add the segmented **"Changes only" ⇄ "Full + map"** toggle:
  - *Changes only* — render only changed paragraphs (inline redline), collapsing runs of unchanged paragraphs into a "▾ N unchanged paragraph(s)" divider. No background wash (everything shown is a change).
  - *Full + map* — the full description in a scroll pane beside a **minimap rail** that draws a tick at each changed paragraph's true position (`offsetTop / scrollHeight`) plus a live **viewport box** that tracks the reader's scroll.
- Self-contained component; reuses the word-diff engine for the inline redline. The scroll-position math is the non-trivial part (recompute on scroll + after layout), prototyped in `reference/Post Diff Review v2.dc.html`.
- Slots into the drawer once Phase 1 lands; could also drop into the inline `RecordDetailView` as a standalone improvement.
- **Risk:** medium (isolated component, but real interaction/measurement logic). **Touches:** new `DescriptionDiffWithMap.tsx`, hook into `RecordChangesDrawer` (and optionally `RecordDetailView`) field rendering.

### Phase 4 — Table-view diff cell rendering (inline diffs, solid change fills, diff-aware widths) *(deferred; the one draw-loop exception)* — [DEV-10649](https://linear.app/whalesync/issue/DEV-10649)
> **Also deferred to the end, and the single deliberate exception to "don't touch the draw loop."** Where Phase 5 restyles the chrome *around* the grid, Phase 4 reworks how the canvas grid *body* paints changed cells — so it edits `FolderDataGrid.tsx`'s `getCellContent`/`drawCell` directly. **Gated behind `desktop-review-surface-v2`**: with the flag off, today's popover + unified-diff behavior is unchanged.
- **Inline-only diffs in the grid.** Always paint the change in the cell as deleted→inserted (`del old` before `ins new`, per the design), for **every** field size — extend the existing `drawWordDiffText` path (today limited to XS/S text fields) to M/L too.
- **Drop the diff popover.** With the flag on, don't open the `FieldValuePanel` popover on cell click/hover; the inline diff makes it redundant.
- **Hide the Unified diff view.** With the flag on, remove the `unifiedDiffMode` toggle and the 68px stacked before/after path (`drawUnifiedDiffCell`); inline diffs replace it.
- **Solid change-type cell fills.** Fill the whole cell with the **existing** review-state `-bg` tokens applied as solid fills — modified `--modified-needs-review-bg`, created `--create-needs-review-bg`, removed `--delete-needs-review-bg` (+ their `-approved` variants for approved/unpublished). Consistent across modified/created/removed (today created/deleted use lower-opacity row tints). No new palette.
- **Inline diff for long-form text.** Longer fields (e.g. description) render a one-line truncated token diff in the cell (reuse `getWordDiffSegments`) instead of falling through to plain rendering.
- **Diff-aware column widths.** Widen a column when its cells carry diffs (the inline `del + ins` is wider than a single value) — hook the width calc (`FolderDataGrid.tsx` ~2006–2032) to bump width when a column has any `diffKind !== null` cell.
- **Risk:** medium–high — the only phase that edits the mature canvas draw loop (`FolderDataGrid.tsx`, ~4.3k lines). *Mitigation:* flag-gated (ships dark); reuses the existing review-state tokens, `getWordDiffSegments`/`drawWordDiffText`, and `getCellDiffState` — this is rewiring, not new diff/color algorithms. **Touches:** `FolderDataGrid.tsx` (`getCellContent`, `drawCell`, column-width calc, popover trigger, `unifiedDiffMode` toggle), `unified-diff-cell.ts` + `FieldValuePanel.tsx` (gated off when flag on), `theme/globals.css` (only if a fill needs a token tweak). QA per `/qa-desktop-app` against the live test backend before committing.

### Phase 5 — Table-view header & chrome (banner, subbar, status pills, filter chips) *(restyle + chips, deferred to last)* — [DEV-10620](https://linear.app/whalesync/issue/DEV-10620)
> **Intentionally last.** Per the ordering decision in §4, every change to the Table view's header/chrome is sequenced after the drawer, By-type view, and minimap, so the early phases stay off the mature `FolderDataGrid` chrome. Build only what's still wanted once the net-new surfaces have landed.
- **Restyle the review chrome** to match the design: the **context banner** ("Review before publishing to … · N pending · M approved", with **Discard all**), the **subbar** (the Table/By-type toggle's home, live approved/pending counts), and **status pills** (modified / created / removed). Keep the canvas grid body untouched (wrap it; don't reach into the draw loop).
- **Change-type filter chips** (All / one per changed field type / new / removed) with a 6 px color dot and a **live count**, wired into the existing `activeFilters` system via new change-type facets (reusing Phase 0's grouping selector for counts/membership). Selecting a chip narrows the grid rows and **scopes the drawer's stepper** (closes chunk J's remaining piece).
- **Risk:** medium — extends `GridFilter`/`FilterKind` and wraps `FolderDataGrid` chrome; must not regress the existing needs-review/approved/problems pills. **Touches:** `FolderDataGrid.tsx` surrounding chrome (or a new wrapper), `WorkspaceContent.tsx`, `workspace-ui-store.ts` filter facets, new banner/subbar/chip components.

### Future work — App shell (top bar + sidebar) parity *(out of scope for now)*
- **Not being touched right now** (explicit decision, 2026-06-29). If we later want full top-bar/sidebar parity with the design: the "N to review" / "Publish all · N" exact pill styling, the kebab menu, the "Re-download files" action, and the ~6 px rounded top-bar corners (the design's documented override of the DS square default).
- The shell already covers the substance today (workspace name, Open in / Pull all / Publish all · N, the "N to review" pill, the folder tree with review dots, total-files footer, secondary nav), so this is pure cosmetic parity — deferred until the review surface itself is settled. **Would touch** `WorkspaceHeader.tsx`, `WorkspaceSidebar.tsx`.

---

## 5. Work Chunk Catalog (decide what's worth building)

Use this to green-light or cut chunks before each phase issue is written. Effort is rough (S/M/L/XL). "New vs restyle" tells you how much is genuinely new code.

Rows are grouped by the phase that delivers them (see §4). Effort is rough (S/M/L/XL). "New vs restyle" tells you how much is genuinely new code.

| # | Chunk | Phase | Surface | New vs restyle | Maps to today | Effort | Optional? |
| --- | --- | --- | --- | --- | --- | --- | --- |
| A | Feature-flag scaffold + change-type grouping selector | 0 | cross-cutting | new (small) | nothing (grouping); flags exist | S | no — foundation |
| I | Detail drawer (scrim + right panel + header/footer chrome) | 1 | detail-drawer | new | ✅ **built** — `RecordChangesDrawer.tsx` (DEV-10616) | M | **in progress** |
| J | Drawer stepper scoped to changed set | 1 | detail-drawer | new | ✅ **built** — page changed set; filtered/grouped scoping in Phase 5 | S | **partly done** (DEV-10616) |
| F | **By-type grouped view** (groups + group headers + group rows) | 2 | review-bytype | **new** | nothing | L | **decide** |
| G | "Approve all N" / "All approved ✓" per-group bulk action | 2 | review-bytype | mixed | reuses `acceptGridFieldChanges` ladder | M | **decide** |
| H | Summary pills (e.g. "avg −10% · mostly lowered") | 2 | review-bytype | new | nothing | M | **likely cut / phase later** |
| K | **Description "Changes only / Full + map" + minimap rail** | 3 | description-diff | **new** | word-diff exists; minimap is new | L | **decide** |
| M | Inline-only in-cell diffs (all field sizes) + drop popover + hide Unified view | 4 | review-table | mixed | `drawWordDiffText`/`getWordDiffSegments` exist; popover + unified exist to gate off | M | **greenlit** |
| N | Inline diff for long-form text (one-line truncated token diff) | 4 | review-table | mixed | reuses word-diff; long text is plain/unified today | S | **greenlit** |
| O | Solid change-type cell fills (modified/created/removed + approved variants) | 4 | review-table | restyle | `--*-needs-review-bg` tokens exist | S | **greenlit** |
| P | Diff-aware column widening | 4 | review-table | new | width calc exists, not diff-aware | S | **greenlit** |
| B | Context banner ("N pending · M approved" + Discard all) | 5 | review-table | restyle | `review-publish-breakdown.ts`, `useReviewStats`, `discardAllChanges` | S | **decide** |
| C | Subbar with live approved/pending counts + view-toggle control | 5 | review-table | restyle | header counts already computed | S | **decide** |
| D | Status pills (modified / created / removed) on rows | 5 | review-table | restyle | row `__rowStatus` already exists | S | yes |
| E | Change-type filter chips (per-field / new / removed, live counts) | 5 | review-table | mixed | extends `GridFilter`/`activeFilters` | M | **decide** |
| L | App-shell parity + "Re-download files" + kebab | Future | app-shell | restyle | `WorkspaceHeader`/`Sidebar` | S | **deferred — not now** |

**Recommended minimum viable redesign:** A → I (in flight) → F → G (the net-new By-type view + a drawer to act on it, on the Phase 0 foundation). K (minimap), the Phase 5 table-chrome chunks (B/C/D/E), H (summary pills), and L (app shell) are the "decide later / deferred" set — with B–E intentionally sequenced last and L out of scope for now.

**Phase 4 (chunks M–P)** is greenlit and grouped with the deferred Table-view work — built alongside/after Phase 5, and the one phase that reaches into the canvas draw loop (flag-gated).

---

## 6. Risks & mitigations

- **Two rendering paths for the same data.** The By-type view (Phase 2) and the canvas grid render the same pending changes differently; they can drift. *Mitigation:* both consume the **one** Phase 0 grouping selector and the **one** review-state ladder — no duplicated diff/state logic.
- **The grid is canvas, not DOM.** `FolderDataGrid` draws cells on a `<canvas>` (glide-data-grid). New chrome (banner, subbar, chips, By-type, drawer) is **DOM around / beside** the canvas — don't try to render the new surfaces *inside* the canvas. The chrome phases wrap the grid; they don't reach into its draw loop. **Exception — Phase 4** deliberately edits the `drawCell`/`getCellContent` loop to restyle changed cells (inline diffs, solid fills, diff-aware widths) and to drop the popover + Unified diff view — the *only* phase that does. Kept safe by the `desktop-review-surface-v2` flag (ships dark) and by reusing the existing word-diff engine + review-state tokens instead of new drawing primitives.
- **New detail surface coexists with the inline view.** Phase 1 adds the `RecordChangesDrawer` *beside* the inline `RecordDetailView` (single-click → drawer, double-click → inline) rather than replacing it — but it does change single-click row behavior app-wide. *Mitigation:* confirm that single-click default is desired (or flag-gate it), and keep the inline path as the full-edit fallback.
- **Filter-system fork.** Adding change-type facets (Phase 5) risks a parallel, divergent filter system. *Mitigation:* extend `GridFilter`/`FilterKind` in `workspace-ui-store`, don't fork.
- **Publish gate assumption.** Publish is UI-gated on zero unreviewed changes; the review surface must keep that invariant visible (the "N to review" pill blocks "Publish all"). Don't let a new bulk action approve something the ladder wouldn't.
- **Scope creep from the prototype.** The `.dc.html` files include ideas (some summary pills, concepts in `Bulk Diff Concepts.dc.html`) that may not be worth porting. The catalog flags these as optional/cut; confirm per phase.

---

## 7. Open decisions (resolve while writing the phase issues)

1. **Which chunks ship?** Confirm the §5 catalog selection — especially F/G (By-type), K (minimap), and the deferred Phase 5 table-chrome chunks B/C/D/E (filter chips et al.). H (summary pills) and L (app shell) are presumed cut/deferred unless you say otherwise.
2. **Default view.** Does the redesign make **By-type** the default review view, or keep the **Table/grid** as default with By-type opt-in? (Plan assumes grid-default, By-type opt-in, lowest risk.)
3. **Drawer vs inline.** Is the **drawer** the new universal detail housing, or only used from the new review surfaces (leaving the inline panel elsewhere)?
4. **Summary-pill scope (H).** If built, which field types get summary pills first (numeric % only, or more)?
5. **Flag lifetime.** One umbrella flag for the whole v2 surface, or per-phase flags for finer rollout control?
6. **Server changes.** Confirm the assumption that **no server MR is required** for the review surface (all counts/grouping are client-side over already-loaded diff data). If any chunk needs server-side grouping/counts, split it into an earlier server MR per the repo's server-first rule.

---

## 8. Linear issue plan (generated on approval)

All child issues live under **DEV-10615** and are assigned to Chris Hoefgen. Created 2026-06-29; build order top-to-bottom:

| Phase | Issue | Chunks | Size | Status |
| --- | --- | --- | --- | --- |
| 0 — Foundations (flag + grouping selector) | [DEV-10617](https://linear.app/whalesync/issue/DEV-10617) | A | S | Backlog |
| 1 — Detail drawer (`RecordChangesDrawer`) | [DEV-10616](https://linear.app/whalesync/issue/DEV-10616) | I, J | — | In Progress |
| 2 — By-type grouped view + per-group bulk approve | [DEV-10618](https://linear.app/whalesync/issue/DEV-10618) | F, G, H? | L | Backlog |
| 3 — Description "Changes only / Full + map" minimap | [DEV-10619](https://linear.app/whalesync/issue/DEV-10619) | K | L | Backlog |
| 4 — Table-view diff cell rendering (inline diffs, solid fills, diff-aware widths) | [DEV-10649](https://linear.app/whalesync/issue/DEV-10649) | M, N, O, P | M | Backlog *(deferred; gated by `desktop-review-surface-v2`)* |
| 5 — Table-view header & chrome (banner, subbar, status pills, filter chips) | [DEV-10620](https://linear.app/whalesync/issue/DEV-10620) | B, C, D, E | M | Backlog *(deferred to last)* |
| Future — App-shell parity | *(none — out of scope for now)* | L | S | — |

Each issue links back to this plan and notes its feature-flag gate and the chunks it covers.

> **Sequencing note:** Phase 1's drawer steps through the *changed set* today. The *filtered/grouped*-set scoping (chunk J's remaining piece) is folded into **Phase 5** (filter chips) and the By-type view (**Phase 2**) — once those define a narrowed set, feed it into the drawer's stepper so "↑/↓ within this filter/group" works. The drawer landed first and the later phases extend it, not the reverse.
