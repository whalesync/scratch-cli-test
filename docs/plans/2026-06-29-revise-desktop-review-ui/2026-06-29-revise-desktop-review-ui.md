# Revise Desktop Review UI — Phased Implementation Strategy

- **Status:** In Progress — all numbered Phases 0–9 and the Playwright coverage (DEV-10626) have landed on `master` (see §4, §8). Only the out-of-scope **Future work** (app-shell parity, retiring `FolderDataGrid`, chunk H summary pills) remains, so the folder stays here rather than moving to `resolved/`.
- **Created:** 2026-06-29
- **Revised:** 2026-07-02 — Phases 0–3 complete; the Table-view strategy (old Phases 4/5) is replaced by the sibling-surface strategy in §0. · 2026-07-13 — Phases 4–9 and the Playwright coverage (DEV-10626) all landed on `master`; doc brought current to the shipped state (see §4, §8).
- **Author:** Chris Hoefgen
- **Parent issue:** [DEV-10615 — [MAJOR] Revise desktop review UI](https://linear.app/whalesync/issue/DEV-10615/major-revise-desktop-review-ui)
- **Child issues (all assigned to Chris Hoefgen):** Phase 0 [DEV-10617](https://linear.app/whalesync/issue/DEV-10617) ✅ · Phase 1 [DEV-10616](https://linear.app/whalesync/issue/DEV-10616) ✅ · Phase 2 [DEV-10618](https://linear.app/whalesync/issue/DEV-10618) ✅ · Phase 3 [DEV-10619](https://linear.app/whalesync/issue/DEV-10619) ✅ · Phases 4+5 [DEV-10649](https://linear.app/whalesync/issue/DEV-10649) ✅ (re-scoped 2026-07-02, done together) · Phase 6 [DEV-10620](https://linear.app/whalesync/issue/DEV-10620) ✅ (re-scoped 2026-07-02) · Phase 7 [DEV-10654](https://linear.app/whalesync/issue/DEV-10654) ✅ · Phase 8 [DEV-10655](https://linear.app/whalesync/issue/DEV-10655) ✅ · Phase 9 [DEV-10656](https://linear.app/whalesync/issue/DEV-10656) ✅ · [DEV-10626](https://linear.app/whalesync/issue/DEV-10626) ✅ (Playwright coverage). See §8 for the build order.
- **Design source:** [`new-review-designs/README.md`](./new-review-designs/README.md) and the `.dc.html` prototypes alongside it (flagship: `Whalesync App.dc.html`).
- **Scope note:** This plan focuses **mostly on the dedicated review surface** — the screen the user lives on while reviewing pending changes (Table view, By-type view, filter chips, and the detail drawer). The app shell (top bar + sidebar) is covered only where it needs touching. Implementation happens in **other sessions**, one merge request per phase.

---

## 0. Strategy revision (2026-07-02)

**What changed:** the original Phases 4 and 5 planned to rework the Table view **inside `FolderDataGrid.tsx`** — flag-gating new cell rendering in its canvas draw loop (old Phase 4) and wrapping/restyling its chrome (old Phase 5). That strategy was attempted twice and abandoned: flag-gating new behavior inside the mature ~4,300-line component created numerous side effects and made the code very complex. The latest attempt is preserved, unmerged, on branch `before-after-diff-not-showing` (commit `b07d6d224`) — its shared `word-diff.ts` work is salvaged in Phase 4 below, and its draw-loop logic is reference material for the new grid.

**The new strategy — a sibling surface:**

1. **A new top-level component, `FolderReviewSurface`,** is rendered **instead of** `FolderDataGrid`. The choice lives in the parent — `WorkspaceContent.tsx`'s data-view branch — on the existing `DESKTOP_REVIEW_SURFACE_V2` flag (`useReviewSurfaceV2Enabled()`): flag on → `FolderReviewSurface`, flag off → `FolderDataGrid` untouched. Revert = flip one branch.
2. **The new surface owns the entire new review UI:** the header chrome (context banner, subbar with view toggle / filter pills / live counters) and a **new, purpose-built canvas grid** (`ReviewTableGrid`, its own glide-data-grid instance). `FolderDataGrid`'s grid internals are used as *inspiration/reference* — its draw patterns, diff classification, and tokens — not forked wholesale.
3. **`RecordReviewDrawer` and the By-type view become exclusive to the new surface.** All v2 wiring currently inside `FolderDataGrid` (the flag read, drawer single-click open, by-type data load, Table/By-type toggle, per-group bulk approve) moves into `FolderReviewSurface`, and `FolderDataGrid` is stripped back to pre-v2 behavior.
4. **Scope of the new grid:** review-first **plus filters and inline cell editing** — rendering for all field types, review-state visualization, status pills, approve/reject/drawer integration, the existing filter pills, glide overlay editing, sort, and column resize. **Dropped by design:** the `FieldValuePanel` diff popover and the unified-diff mode (inline diffs replace both). **Deferred until dogfooding demands them:** columns show/hide picker, validation-gutter visuals, `targetRecord` search jump.

`FolderDataGrid` is on a **deprecation path**: once the flag graduates, it (and its v1-only chrome — unified diff, `FieldValuePanel`) can be deleted. Until then the two surfaces coexist, kept from drifting by shared extracted modules (§3).

---

## 1. Guiding constraints

1. **Never modify `FolderDataGrid` for v2.** The lesson of the failed attempts: the flag switch lives **above** it (in `WorkspaceContent`), the new UI is a **parallel sibling surface**, and `FolderDataGrid` returns to — and stays at — pre-v2 behavior. Flag-off users must see zero change through the entire sequence.
2. **Layer over multiple MRs.** Each phase is independently shippable and independently revertible. New-surface phases ship **dark** (built, tested, unmounted) until the single cutover MR; a half-landed redesign must still leave the app fully usable.
3. **Reuse the foundations that already exist** (see §3), and **extract shared modules rather than fork logic**: diff classification, row/result types, word-diff, tokens. The two grids may differ in draw code (that's the point) but never in what counts as a change.
4. **Server-first only where required.** This work is entirely renderer-side. The review-state ladder (published → approved → local) and its CLI/IPC calls already exist; no new server endpoint is anticipated. Flag any phase that turns out to need a server change so it lands as a separate, earlier MR.

---

## 2. What already exists vs. what's new

### Landed (Phases 0–3, all on `master`)

- **Foundations** ✅ (`c714ab206`, DEV-10617) — the `DESKTOP_REVIEW_SURFACE_V2` per-user flag (`hooks/use-review-surface-v2.ts`, declared in shared-types `UserExperimentFlags` + server `UserFlag`) and the change-type grouping selectors (`review-surface/group-pending-changes-by-change-type.ts`, `review-surface/build-by-type-group-model.ts`, with tests).
- **Detail drawer** ✅ (`ec656b846`, DEV-10616) — `RecordReviewDrawer.tsx` (shipped renamed from the planned `RecordChangesDrawer.tsx`), the right-side review-and-act overlay (header stepper, changed-fields-only body, Approve · next → footer), plus `record-diff-helpers.ts` shared with the inline `RecordDetailView`. Self-loading via `readDiffRecordData`; approve/reject via `acceptRecord`/`rejectRecord`.
- **By-type grouped view** ✅ (`535981b01`, DEV-10618) — `review-surface/ByTypeView.tsx` + `ByTypeGroupBlock` + `ByTypeGroupRow` (+ stories), one block per change type with "Approve all N" bulk actions; `reviewSurfaceViewMode: 'table' | 'by-type'` in `workspace-ui-store`.
- **Description minimap** ✅ (`6416415c1`, DEV-10619) — `ContentDiffWithMap.tsx`, the "Changes only" ⇄ "Full + map" toggle with the tick-mark minimap rail, used by the drawer for long-form fields.

Phases 0–3 originally shipped **hosted inside `FolderDataGrid`** (flag-gated); Phase 7 re-homed the drawer and By-type view into `FolderReviewSurface`, and Phase 8 stripped that hosting back out of `FolderDataGrid`.

### Landed (the new Phases 4–9, all on `master`)

- **`ReviewTableGrid`** ✅ (`b34302b3b`, DEV-10649) — the new canvas Table view: inline `del → ins` diffs at **every** field size, solid change-type cell fills, a status-pill column, diff-aware column widths, editing/sort/resize. Not a restyle of `FolderDataGrid` — a new, much smaller grid built to the v2 design directly, salvaging the abandoned `b07d6d224` draw logic. Shipped with the word-diff segment kinds and the `diff-grid-types.ts` / `grid-cell-diff-state.ts` shared extractions.
- **`FolderReviewSurface`** ✅ (`2391cf906`, DEV-10620) — the top-level host: header chrome (`ReviewContextBanner`, `ReviewSubbar`), data hooks (`use-review-surface-data.ts`, `use-review-ladder-actions.ts`), drawer/By-type housing, bulk actions. Made live at the Phase 7 cutover (`6e40e908f`, refined `4f07f8992`); `FolderDataGrid` stripped to pre-v2 at Phase 8 (`be83e2db7`, kept — not deleted).
- **Change-type filter chips** ✅ (`89dc0c04d`, DEV-10656) — `review-surface/change-type-chips.ts` + the `ReviewSubbar` chip strip, live counts, client-side filtering of the folder-wide pending set, drawer-stepper scoping. Landed alongside drawer-stepper advance (`97006c07c`) and counts / long-form windowing / approved-state polish (`24d892366`).
- **Playwright coverage** ✅ (`c338700b0`, DEV-10626) — `e2e/review-surface-v2-cutover.spec.ts`, `-drawer.spec.ts`, `-grid-data.spec.ts` plus the `review-surface/__tests__/` unit specs.

---

## 3. Shared foundations (build/confirm once, reuse everywhere)

| Foundation | Status | Notes |
| --- | --- | --- |
| **Review-state tokens** (`--modified/create/delete-needs-review-{bg,stroke}`, `-approved` variants) | ✅ `theme/globals.css` | The new grid's solid fills use these exact vars. No new palette. |
| **Word-diff engine** (`getWordDiffSegments`, `src/shared/word-diff.ts`) | ✅ · **Phase 4 extends** | Segment model gains `kind: 'unchanged' \| 'added' \| 'removed'` (salvaged from `b07d6d224` with tests) so the new grid can draw `del → ins`. Only production consumer today is `FolderDataGrid.drawWordDiffText` (mechanical adaptation, behavior identical). |
| **Cell diff classification** (`getCellDiffState` + friends) | ✅ **extracted (Phase 5)** → `pages/workspace/grid-cell-diff-state.ts` | Pure functions, zero component-state entanglement. Both grids import **one** implementation of "is this cell changed and what's the from-value" — the highest-value anti-drift extraction. |
| **Diff grid types** (`DiffRow`, `DiffGridResult`, `CellValidationEntry`) | ✅ **extracted (Phase 5)** → `pages/workspace/diff-grid-types.ts` | Type-only move; pins both surfaces to the one `readDiffGridData` IPC contract. |
| **Review stats / counts** (`useReviewStats`, `buildApprovedPublishBreakdown`) | ✅ | The context banner's pending/approved counters bind to these + `DiffGridResult.filterCounts`. |
| **Review-state ladder actions** (accept / reject / discard, per-field / per-record / bulk, via `window.scratchDesktop.*` IPC) | ✅ | All new-surface actions reuse these (moved call sites, not new IPC). Respect the ladder ([REVIEW_MODEL](/scratch-git-2/docs/REVIEW_MODEL.md)). |
| **Filter state** (`GridFilter`, `activeFilters`, `reviewSurfaceViewMode` in `workspace-ui-store`) | ✅ | Store slices are shared; only one surface renders at a time. Change-type chips (Phase 9) extend `GridFilter`, never fork it. |
| **Grouping selectors** (`group-pending-changes-by-change-type.ts`, `build-by-type-group-model.ts`) | ✅ | Feed the By-type view today and the Phase 9 chip counts tomorrow. |
| **Drawer + minimap** (`RecordReviewDrawer`, `ContentDiffWithMap`, `record-diff-helpers.ts`) | ✅ | Re-housed (not rewritten) into the new surface. `record-diff-helpers.ts` **stays put** — `RecordDetailView` (v1) imports it too. |

**Net:** still no new diff algorithm, color system, or review-state backend. The new work is one purpose-built grid, one host component, two header components, and the extractions that keep the two grids honest.

---

## 4. Phased plan (each phase → one Linear issue → one MR)

> **Ordering invariant:** the flag-on dogfooder (drawer + By-type working inside `FolderDataGrid` today) never regresses mid-sequence, and flag-off users never see any change. Phases 4–6 ship **dark**; Phase 7 is the **single atomic cutover**; Phase 8 is pure deletion of then-dead code.

### Phase 0 — Foundations ✅ *(landed `c714ab206`, DEV-10617)*
Flag + grouping selectors. See §2.

### Phase 1 — Detail drawer ✅ *(landed `ec656b846`, DEV-10616)*
`RecordReviewDrawer` (planned as `RecordChangesDrawer`) + `record-diff-helpers.ts`, wired into `FolderDataGrid` behind the flag (single-click on a changed row, 250 ms double-click disambiguation). The hosting moves in Phase 7; the remaining stepper-scoping work is folded into Phase 9.

### Phase 2 — By-type grouped review view ✅ *(landed `535981b01`, DEV-10618)*
`ByTypeView` + group components, Table/By-type toggle, folder-wide pending load (cap 1000), per-group bulk approve. Hosting moves in Phase 7.

### Phase 3 — Description minimap ✅ *(landed `6416415c1`, DEV-10619)*
`ContentDiffWithMap` ("Changes only" ⇄ "Full + map"), rendered by the drawer for long-form fields. Unaffected by the strategy revision — it lives inside the drawer.

### Phase 4 — word-diff segment kinds ✅ *(landed with Phase 5 in `b34302b3b`, DEV-10649)*
- Cherry-pick `scratch-desktop/src/shared/word-diff.ts` + `word-diff.test.ts` from `b07d6d224`: the segment model changes from `changed: boolean` to `kind: 'unchanged' | 'added' | 'removed'` (today deletions are dropped entirely — the new grid needs them to draw `del → ins`).
- Mechanically adapt `FolderDataGrid.drawWordDiffText` (~10 lines; its only production consumer) with **identical behavior**: skip `removed` segments, `added` = accent, exactly as today. Tests pin both old and new behavior.
- **Why its own MR:** touches a shared module + its tests, and unblocks Phase 5 without dragging grid code along.
- **Risk:** near-zero. **Touches:** `src/shared/word-diff.ts`, `word-diff.test.ts`, `FolderDataGrid.tsx` (mechanical). **Verify:** `yarn build && yarn lint && yarn test` from repo root.

### Phase 5 — shared extractions + `ReviewTableGrid` ✅ *(landed `b34302b3b`, DEV-10649)*
- **Extract shared modules** (mechanical; `FolderDataGrid` switches to importing them, zero behavior change):
  - `pages/workspace/diff-grid-types.ts` — `DiffRow` / `DiffGridResult` / `CellValidationEntry` (+ the optimistic-update helpers `applyAcceptedFieldChangeToFolderDiffData` et al., which the new grid's editing needs).
  - `pages/workspace/grid-cell-diff-state.ts` — `getCellDiffState`, `resolveEffectivePath`, the readonly/write-once predicates.
- **Build the new grid** under `pages/workspace/review-surface/`:
  - `ReviewTableGrid.tsx` — own `DataEditor` with its own `getCellContent`/`drawCell`. Inline `del → ins` at every field size (long-form renders a one-line truncated token diff), solid change-type fills (incl. `-approved` variants), status-pill first column, diff-aware widths, glide built-in overlay editing, header-click sort, column resize, frozen title column, FK `referenceLabels` display, row-click → drawer (keep the 250 ms defer so double-click still edits). **No** popover, **no** unified-diff mode, **no** validation gutter, **no** columns picker. Target well under 1,000 lines.
  - `review-table-cell-drawing.ts` — pure canvas helpers lifted from `b07d6d224`: the v2 `drawWordDiffText` (kind-aware, `showRemoved`, `wholeValue`, strike-through), status-pill drawing, solid-fill token resolution. Memoize `getWordDiffSegments` results keyed by `filename + columnId + values` — long-form diffs at paint time need it.
  - `build-review-table-columns.ts` — pure column-model builder: TableView cols → `GridColumn[]` + label/path maps, default widths, `DIFF_COLUMN_WIDTH_MULTIPLIER` (1.6) widening from a `diffCarryingColumnIdSet` (lifted from `b07d6d224`), user `columnWidths` overrides (same store slice as v1, so resized widths stay consistent across surfaces).
  - `use-folder-schema-and-table-view.ts` — `getFolderMetadata` load + `onConnectionFileChanged` hot-reload.
- Storybook stories with fixture rows for **every cell state** (modified/created/removed × needs-review/approved, whole-value vs word-level, FK labels, readonly) — this is where canvas fidelity/perf risk gets drained before cutover.
- **Risk:** low (unmounted). **Touches:** new files + `FolderDataGrid` import swaps only. **Verify:** `yarn build && yarn lint && yarn test`; Storybook review.

### Phase 6 — `FolderReviewSurface` host + banner + subbar + hooks ✅ *(landed `2391cf906`, DEV-10620)*
- `FolderReviewSurface.tsx` — the top-level host, **same props interface as `FolderDataGrid`** (makes the Phase 7 switch a ternary and revert a one-liner). Owns the body switch (`reviewSurfaceViewMode` → `ReviewTableGrid` | `ByTypeView`), pagination footer, bulk approve/reject/discard + confirm modal, and (from Phase 7) the drawer + `RecordDetailView` overlay housing.
- `ReviewContextBanner.tsx` — "Review before publishing to {connector} · {folder}" + "N pending · M approved" + **Discard all**. The connector name is the banner's one new data need — derive from the folder path's first segment + the workspace connections already loaded in `WorkspaceContent`.
- `ReviewSubbar.tsx` — Table/By-type toggle (bound to the existing store), the existing three filter pills (needs-review / approved / problems) driving the same `GridFilter` state, right-aligned live counters. Change-type chips join in Phase 9.
- `use-review-surface-data.ts` — the shared data hook: (a) paged `readDiffGridData` for the table, (b) the folder-wide unreviewed load for By-type/chips (cap 1000) — one shared invalidation (`bumpReviewDataVersion`) so approve/reject/edit refresh both consistently. (They can't share one IPC result — the table pages at 100 with sort/filters; by-type is folder-wide — so we share *invalidation and types*, not bytes.)
- `use-review-ladder-actions.ts` — all review IPC in one place: per-record approve/reject (drawer callbacks), per-group bulk, discard/reject-all, cell edit (`acceptFieldEditFromInputText` + coercion + optimistic apply).
- Not mounted anywhere. May merge with Phase 5 into one MR if review size stays acceptable; keeping them split keeps each under ~1,200 new lines.
- **Risk:** low (unmounted). **Verify:** `yarn build && yarn lint && yarn test`; stories for banner/subbar.

### Phase 7 — cutover ✅ *(landed `6e40e908f`; UI refine `4f07f8992`, DEV-10654)*
- `WorkspaceContent.tsx` data-view branch: `useReviewSurfaceV2Enabled() ? <FolderReviewSurface …/> : <FolderDataGrid …/>`.
- Move into `FolderReviewSurface`, **largely verbatim from `FolderDataGrid`**: the drawer state machine + stepper + open/close effects; `handleRecordChangeReviewed`; the by-type load + group model + per-group bulk approve + `ByTypeView` render; the `RecordDetailView` overlay housing (so Record/Field deep-editing and ValidationPanel `showField` navigation keep working flag-on); `activateGlobalFilter` handling (the header "N to review" pill must keep filtering the new surface).
- **Honor the prop contract**: `onIndexingProgress` (reindex-blocking UX) and `onPublishFile` must flow through the new hooks, or workspace-level behavior silently disappears for flag-on users.
- **`FolderDataGrid` is untouched in this MR** — its v2 branches simply become unreachable (flag-on users no longer render it). That keeps this MR additive + one-line-switch, and revert trivially restores today's behavior.
- **Accepted deltas at cutover** (confirm before merging): popover + unified-diff dropped by design; columns picker, validation-gutter visuals, `targetRecord` search jump deferred to Phase 9. If search jump turns out to be load-bearing for daily dogfooding, pull it forward into this MR (~80 lines: `findRecordOffset` → page jump + row highlight).
- **Risk:** medium; revert = flip the one branch. **Verify:** `yarn build && yarn lint`; `/qa-desktop-app` **twice** — flag **ON** (new surface renders data; pills filter; single-click opens drawer; approve/reject advances + refreshes counts; By-type groups + "Approve all N" work; inline edit round-trips; publish gate "N to review" → Publish all intact) and flag **OFF** (FolderDataGrid behavior identical, no drawer, no toggle).

### Phase 8 — strip `FolderDataGrid` to pre-v2 ✅ *(landed `be83e2db7`, DEV-10655 — stripped, not deleted)*
- Remove the now-unreachable v2 tendrils. Checklist (line refs at `1aac2b5bf`): the v2 imports (flag hook, drawer, By-type components/model, v2 posthog trackers, `SegmentedControl`, `rowHasUnreviewedChanges`); constants `BY_TYPE_MAX_PENDING_RECORDS` + `RECORD_CHANGES_DRAWER_CLICK_DELAY_MS`; the flag/view-mode state block (~L928–949); the entire drawer block (L1550–1669); the by-type memos + load pipeline (L1917–1982); `handleRecordChangeReviewed` + per-group bulk approve (L2217–2329); the drawer-timer edits in `onCellClicked`/`onCellActivated` (restoring the literal pre-v2 handler bodies); the render branches — `showByTypeBody` guards, Table/By-type toggle (L3347–3364), the `!isByTypeReviewMode` columns-picker gate, the `ByTypeView` body (L3510–3528), the drawer portal (L3854–3875).
- **Keep** (v1 or shared): `unifiedDiffMode` + `drawUnifiedDiffCell`, `FieldValuePanel`, validation gutter, columns picker, `record-diff-helpers.ts`, the `reviewSurfaceViewMode` store slice, the flag hook + declarations, everything under `review-surface/`.
- Optionally `git mv` `RecordReviewDrawer.tsx` + `ContentDiffWithMap.tsx` into `review-surface/` now that they're v2-exclusive.
- **Verify:** `grep -c "ReviewSurfaceV2\|ByType\|byType\|RecordReviewDrawer\|by-type" FolderDataGrid.tsx` → 0; `yarn build && yarn lint`; `/qa-desktop-app` flag-**OFF** regression pass (single-click = select + popover, double-click = editor, pills/kebab/unified-diffs/bulk actions/word-diff highlights/validation gutter all unchanged, exactly one `readDiffGridData` per page load) + flag-**ON** sanity (new surface unaffected).
- **Risk:** low — everything deleted is dead after Phase 7. Kept separate so the cutover MR reads as additive and this one as subtractive.

### Phase 9 — change-type filter chips + stepper scoping + dogfood parity ✅ *(chips `89dc0c04d`; stepper `97006c07c`; polish `24d892366`, DEV-10656)*
- **Chips** (All / per-changed-field / new / removed, 6 px color dot, live count) in the subbar, counts from `groupPendingChangesByChangeType` over the folder-wide pending set. Selecting a chip narrows the table and **scopes the drawer's stepper** (closes old chunks E and J).
- **Filtering mechanism:** recommend **client-side** — an active chip renders the table from the folder-wide pending set filtered to the group (cap 1000, matching By-type's existing truncation semantics) — over adding new server/main-process `FilterKind`s. Decide when writing the issue.
- **Dogfood-driven parity**, scoped from Phase 7 feedback: `targetRecord` search jump, columns show/hide, a per-cell problem indicator if the gutter is missed, session ✓/✕ row markers from the design, keyboard polish.
- **Risk:** low–medium. **Verify:** `yarn build && yarn lint`; `/qa-desktop-app` flag-on.

### Future work — App shell (top bar + sidebar) parity *(out of scope, unchanged)*
Pure cosmetic parity (pill styling, kebab, "Re-download files", rounded top-bar corners) — deferred until the review surface is settled. Would touch `WorkspaceHeader.tsx`, `WorkspaceSidebar.tsx`.

### Future work — retire `FolderDataGrid`
When the flag graduates to everyone: delete `FolderDataGrid` and its v1-only chrome (unified-diff mode, `FieldValuePanel`), un-fork any remaining duplication. Recorded here so the two-grid fork is understood as **temporary**.

---

## 5. Work Chunk Catalog

| # | Chunk | Phase | New vs restyle | Status |
| --- | --- | --- | --- | --- |
| A | Feature-flag scaffold + change-type grouping selector | 0 | new (small) | ✅ done |
| I | Detail drawer (scrim + right panel + chrome) | 1 | new | ✅ done |
| J | Drawer stepper scoped to changed set | 1 | new | ✅ done (filter scoping landed in Phase 9) |
| F | By-type grouped view | 2 | new | ✅ done |
| G | "Approve all N" per-group bulk action | 2 | mixed | ✅ done |
| K | Description "Changes only / Full + map" + minimap rail | 3 | new | ✅ done |
| — | word-diff segment kinds (salvage `b07d6d224`) | 4 | new (tiny) | ✅ done |
| M | Inline-only in-cell diffs (all field sizes); popover + unified view simply don't exist in the new grid | 5 | new grid | ✅ done — in `ReviewTableGrid` |
| N | Inline diff for long-form text (one-line truncated token diff) | 5 | new grid | ✅ done |
| O | Solid change-type cell fills (+ approved variants) | 5 | new grid | ✅ done |
| P | Diff-aware column widening | 5 | new grid | ✅ done |
| D | Status pills (modified / created / removed) on rows | 5 | new grid | ✅ done — the new grid's first column |
| B | Context banner ("N pending · M approved" + Discard all) | 6 | new | ✅ done |
| C | Subbar with live counts + view-toggle | 6 | new | ✅ done |
| E | Change-type filter chips (live counts) | 9 | mixed | ✅ done (client-side, DEV-10656) |
| H | Summary pills (e.g. "avg −10% · mostly lowered") | — | new | **cut / later** |
| L | App-shell parity + "Re-download files" + kebab | Future | restyle | deferred |

**Recommended path:** Phases 4 → 5 → 6 → 7 → 8 form the core sequence (7 and 8 are not optional once 5–6 exist — dark code that never mounts is worse than no code). Phase 9's chips (E) and the parity items are decided from dogfood feedback; H and L remain cut/deferred.

---

## 6. Risks & mitigations

- **Two grids coexisting can drift.** `ReviewTableGrid` and `FolderDataGrid` render the same rows with different draw code. *Mitigation:* the semantics live in shared modules after Phases 4–5 (`grid-cell-diff-state.ts`, `diff-grid-types.ts`, `word-diff.ts`, `shared/schema-columns`, `shared/cell-value-coercion`); only DataEditor config + draw code differ (deliberately). The fork is temporary — see "retire `FolderDataGrid`" in §4.
- **Cutover feature gaps for flag-on users.** At Phase 7 the dogfooder loses: popover + unified-diff (by design), columns picker, validation-gutter visuals, search jump (deferred). *Mitigation:* the list is explicit and confirmed before the cutover MR merges; anything load-bearing gets pulled forward (search jump is the likely candidate).
- **Canvas perf with all-size diffs.** The abandoned attempt computed word-diff segments inside every paint — fine for short text, not for long-form at 100 rows. *Mitigation:* memoize segments keyed by `filename + columnId + values` in `review-table-cell-drawing.ts`; validate on a 100-row long-text page during Phase 5 Storybook work.
- **Prop-contract regressions at the switch.** `onIndexingProgress`, `onPublishFile`, and `activateGlobalFilter` (the header "N to review" pill) must be honored by the new surface from day one or workspace-level behavior silently disappears flag-on. *Mitigation:* `FolderReviewSurface` keeps `FolderDataGrid`'s exact props interface; Phase 7's QA checklist covers all three.
- **Filter-system fork.** Change-type chips (Phase 9) extend `GridFilter`/`activeFilters` in `workspace-ui-store` — never a parallel filter system.
- **Publish gate assumption.** Publish stays UI-gated on zero unreviewed changes; no new bulk action may approve something the ladder wouldn't. A "reject" touches only the working tree, never the approved set.

---

## 7. Open decisions

**Resolved (2026-07-02):**
1. ~~Table-view strategy~~ — sibling surface (`FolderReviewSurface`), never in-place inside `FolderDataGrid` (§0).
2. ~~New grid technology~~ — own canvas glide-data-grid instance, salvaging `b07d6d224`.
3. ~~New grid scope~~ — review-first **plus** filter pills and inline cell editing.
4. ~~Flag~~ — the existing `DESKTOP_REVIEW_SURFACE_V2` (one umbrella flag; the switch just moves up to `WorkspaceContent`).
5. ~~Server changes~~ — none required; all counts/grouping stay client-side.

**Resolved (2026-07-13, by how it shipped):**
1. ~~Cutover gap acceptance (Phase 7)~~ — shipped with the accepted deltas; the columns picker was ported to the subbar, and the deferred parity items landed in Phase 9.
2. ~~Chip filtering mechanism (Phase 9)~~ — **client-side** over the folder-wide pending set (`change-type-chips.ts`), no new main-process `FilterKind`.
3. ~~Phase 5/6 MR split~~ — shipped as **separate MRs** (`b34302b3b` Phases 4+5, `2391cf906` Phase 6).

**Still open:**
1. **Flag retirement timing:** when the new surface graduates to everyone, schedule the `FolderDataGrid` deletion (§4 future work).

---

## 8. Linear issue plan

All child issues live under **DEV-10615**, assigned to Chris Hoefgen. Re-scoped/created 2026-07-02: DEV-10649 now tracks **Phases 4+5 together** (done together; Phase 4 still recommended as its own tiny MR), DEV-10620 tracks Phase 6, DEV-10654/10655/10656 track Phases 7/8/9 (each blocked by its predecessor in Linear), and DEV-10626 (Playwright coverage) was updated for the sibling-surface architecture.

| Phase | Issue | Size | Status |
| --- | --- | --- | --- |
| 0 — Foundations | [DEV-10617](https://linear.app/whalesync/issue/DEV-10617) | S | ✅ Done (`c714ab206`) |
| 1 — Detail drawer | [DEV-10616](https://linear.app/whalesync/issue/DEV-10616) | M | ✅ Done (`ec656b846`) |
| 2 — By-type view | [DEV-10618](https://linear.app/whalesync/issue/DEV-10618) | L | ✅ Done (`535981b01`) |
| 3 — Description minimap | [DEV-10619](https://linear.app/whalesync/issue/DEV-10619) | L | ✅ Done (`6416415c1`) |
| 4 — word-diff segment kinds | [DEV-10649](https://linear.app/whalesync/issue/DEV-10649) *(tracked with Phase 5)* | XS | ✅ Done (`b34302b3b`) |
| 5 — shared extractions + `ReviewTableGrid` | [DEV-10649](https://linear.app/whalesync/issue/DEV-10649) *(re-scoped 2026-07-02)* | L | ✅ Done (`b34302b3b`) |
| 6 — `FolderReviewSurface` host + banner + subbar + hooks | [DEV-10620](https://linear.app/whalesync/issue/DEV-10620) *(re-scoped 2026-07-02)* | M | ✅ Done (`2391cf906`) |
| 7 — cutover | [DEV-10654](https://linear.app/whalesync/issue/DEV-10654) | M | ✅ Done (`6e40e908f`, refine `4f07f8992`) |
| 8 — strip `FolderDataGrid` | [DEV-10655](https://linear.app/whalesync/issue/DEV-10655) | S | ✅ Done (`be83e2db7`) |
| 9 — chips + stepper scoping + parity | [DEV-10656](https://linear.app/whalesync/issue/DEV-10656) | M | ✅ Done (`89dc0c04d`, `97006c07c`, `24d892366`) |
| Tests — desktop Playwright coverage (post-cutover) | [DEV-10626](https://linear.app/whalesync/issue/DEV-10626) *(updated 2026-07-02)* | XS | ✅ Done (`c338700b0`) |
| Future — app-shell parity · retire `FolderDataGrid` | *(none — out of scope for now)* | — | — |

> **Sequencing note:** Phases 4–6 ship dark and are safe to land in any adjacent order (4 before 5; 5 before or with 6). Phase 7 is the only MR that changes what any user sees, and only for flag-on users; Phase 8 must follow promptly so the dead drawer/By-type copy inside `FolderDataGrid` never drifts from the live one. The drawer's stepper gains filter/group scoping in Phase 9, fed by whatever narrowed set the chips define.
