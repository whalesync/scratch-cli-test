# Port Publish History to the Desktop App

## Goal

The Publish History feature (list of plans, plan detail page, per-record diff + operations modal) currently lives in the Next.js web app at `client/src/app/workbook/[id]/publish-history/` and `client/src/app/workbook/[id]/publish-plan/[planId]/`. The web client is winding down — desktop is the primary surface going forward. This plan ports the feature to the Electron app at `scratch-desktop/`, gated by the **same** `ENABLE_PUBLISH_HISTORY` PostHog flag.

Outcome: a new sidebar button on the workspace page that opens a list of publish plans, with the same drill-in detail page and per-record diff modal as on web — visually and behaviorally identical from the user's POV.

## Inputs already verified

- **Server / API**: No changes. Desktop hits the same NestJS on port 3010 via the existing axios client at `scratch-desktop/src/renderer/src/lib/api.ts` (with `Authorization: API-Token <token>`).
- **Feature flag**: `ENABLE_PUBLISH_HISTORY` already exists server-side and on the web client. Desktop user type already supports `experimentalFlags` via `isExperimentEnabled()` in `scratch-desktop/src/renderer/src/types/user.ts`.
- **SWR**: Desktop already uses `swr@2.4.1` and wraps `App.tsx` in `<SWRConfig>`. The web hooks port without refactoring.
- **Mantine v8.3.5**: Same major as web. Components port cleanly.
- **CSS variables**: All eight referenced web variables (`--fg-divider`, `--bg-panel`, `--bg-selected`, `--fg-primary`, `--fg-secondary`, `--fg-muted`, `--bg-base`) are defined in `scratch-desktop/src/renderer/src/theme/globals.css`. No theme fixes needed.
- **Diff renderer**: Desktop already has `scratch-desktop/src/renderer/src/pages/workspace/diff-renderers.tsx` with a `SideBySideDiff` component using the `diff` npm package's `diffWordsWithSpace()`. **We reuse this** instead of importing `@codemirror/merge`. No new diff dependency.
- **Date / time**: Desktop has a `relativeTime(iso)` helper using native `Intl.RelativeTimeFormat` in `DataFolderInfoModal.tsx`. Extract it to a shared util; format absolute dates with `new Date(iso).toLocaleString()`. **No `dayjs` dependency added.**

## Slices

### Slice 1 — Plumbing (no UI surfaces yet)

- Add `ENABLE_PUBLISH_HISTORY: boolean` to `scratch-desktop/src/renderer/src/types/user.ts` `UserExperimentFlags`.
- Create `scratch-desktop/src/renderer/src/lib/date-format.ts` exporting `relativeTime(iso)` and `absoluteDate(iso, opts?)`. Move logic from `DataFolderInfoModal.tsx` and have it import from the new util to avoid duplication.
- Extend `scratch-desktop/src/renderer/src/lib/publish-api.ts` with: `listPublishPlans`, `getPublishPlan`, `listPublishPlanRecords`, `listPublishPlanOperations`, `getRepoFile`. Endpoints mirror `client/src/lib/api/workbook.ts`. Types from `@spinner/shared-types`.
- Add hooks at `scratch-desktop/src/renderer/src/hooks/`:
  - `use-publish-plans.ts` → `listPublishPlans`
  - `use-publish-plan.ts` → `getPublishPlan`
  - `use-publish-plan-records.ts` → records list
  - `use-publish-plan-record-diff.ts` → `getRepoFile` against `main_pre_plan_{id}` and `dirty_plan_{id}` / `main_plan_{id}` (parameterized by `PlanRecordDiffMode`)
  - `use-publish-plan-operation.ts` → single operation by (filePath, phase)

**Exit criteria**: `yarn build` + `yarn lint` clean. No UI visible to the user. Hooks importable.

### Slice 2 — List page + sidebar entry

- New page `scratch-desktop/src/renderer/src/pages/PublishHistoryPage.tsx`. Renders the plans table.
- New shared component `scratch-desktop/src/renderer/src/pages/workspace/PublishPlansList.tsx`. Ported from web's `PublishPlansList.tsx`. Substitutions:
  - `next/link` → `react-router-dom` `Link`.
  - `useScratchPadUser` → `useCurrentUser`.
  - `dayjs(p.createdAt).format(...)` → `absoluteDate(p.createdAt)`; `dayjs(...).fromNow()` → `relativeTime(p.createdAt)`.
  - URL paths `/workbook/${id}/publish-plan/${planId}` → `/workspace/${id}/publish-plan/${planId}`.
- Add a new route in `scratch-desktop/src/renderer/src/App.tsx`:
  ```tsx
  <Route path="/workspace/:id/publish-history" element={<PublishHistoryPage />} />
  ```
- Add a sidebar button in `scratch-desktop/src/renderer/src/pages/workspace/WorkspaceSidebar.tsx` — **same visual style** as the existing buttons in that file. Flag-gated via `isExperimentEnabled('ENABLE_PUBLISH_HISTORY', user)`. Icon: `ScrollTextIcon` from `lucide-react`. On click: `navigate('/workspace/${workspace.id}/publish-history')`.
- Update `mapWebWorkbookPathToDesktopRoute()` in `scratch-desktop/src/renderer/src/lib/deep-link-routes.ts` to map web's `/workbook/:id/publish-history` → `/workspace/:id/publish-history`.

**Exit criteria**: Sidebar entry visible for flagged users. Click opens list page. List renders plans + author + status + counts. "View" button on a row navigates to a 404-ish placeholder detail page.

### Slice 3 — Detail page + per-record diff + operation modal

- New page `scratch-desktop/src/renderer/src/pages/PublishPlanDetailPage.tsx`. Ports `client/src/app/workbook/[id]/publish-plan/[planId]/page.tsx`. Left card with Operation types / per-table mini tables, Created/Updated, expandable Advanced section with copy-on-click SHAs. Right card with the records list.
- New component `scratch-desktop/src/renderer/src/pages/workspace/PublishPlanRecordsList.tsx`. Ports the web file. Substitutions as in Slice 2, plus:
  - **Drop `MergeEditor` / `unifiedMergeView`**. Replace `DiffView` internals with `SideBySideDiff` from `scratch-desktop/src/renderer/src/pages/workspace/diff-renderers.tsx`. Drop the unified/side-by-side toggle — `SideBySideDiff` is side-by-side only. (See "Open questions" below.)
  - Keep the "No manual edits" banner with `(?)` popover.
  - Keep the diff-source Select (Old vs Edits / Old vs New) and the operation badges that open the existing operation modal.
- Add the route in `App.tsx`:
  ```tsx
  <Route path="/workspace/:id/publish-plan/:planId" element={<PublishPlanDetailPage />} />
  ```
- Update `mapWebWorkbookPathToDesktopRoute()` to also map `/workbook/:id/publish-plan/:planId`.

**Exit criteria**: Click "View" on a row → detail page renders. Click an operation badge → operation modal stacks on top with `zIndex={1100}`. Expand a record → diff renders. Click "Expand full diff" → full-screen diff modal. All round-trips against a real plan match the web app's behavior.

## Cross-slice rules

- **Do not** rebuild `MergeEditor`. The `diff` package is already on desktop and `SideBySideDiff` is good enough for the publish-history dogfood pass.
- **Do not** add `dayjs`. Use the new `date-format.ts` util everywhere.
- **Do not** introduce a desktop-only feature flag. Reuse the existing `ENABLE_PUBLISH_HISTORY`.
- **Leave the web Publish History UI in place** for at least one publish cycle after the desktop ports lands, in case we hit data shape parity issues. Tear-down is a separate follow-up.
- **`useParams<{id, planId}>()`** on each new page. No global active-workbook store.

## Open questions

1. **Unified diff mode dropped?** Web has a "Unified" segmented control that uses `unifiedMergeView`. Desktop's `SideBySideDiff` is side-by-side only. Recommendation: drop the toggle on desktop and ship side-by-side only. Re-add later if users miss it. If we want unified on desktop, we have to either (a) add `@codemirror/merge` (the dep we're trying to avoid) or (b) build a simple inline diff with the existing `diff` package + `<pre>` rendering.
2. **`SideBySideDiff` props compatibility.** Its signature takes `(fromValue, value, diffKind, classification)`. Our publish-plan diff has two strings and no `diffKind`. We may need a wrapper that synthesizes `diffKind = 'modified'` for both sides. Confirm the component renders correctly when both sides are populated.
3. **Sidebar button affordance.** "Manage Connections" opens the web app externally; "Connections (local UI)" opens a drawer. Neither is a route navigation. Adding a new route-navigation button is a third style. Recommendation: do it anyway — desktop is the future, so route-nav from the sidebar should become the norm.

## Risk register

| Risk | Likelihood | Mitigation |
| --- | --- | --- |
| `SideBySideDiff` doesn't handle large records well (>50KB JSON) | medium | Add a max-height + scroll; chunk if needed. Most records are small. |
| `relativeTime` from `DataFolderInfoModal.tsx` has subtle differences from `dayjs.fromNow()` (e.g., rounding) | low | Cosmetic only. Acceptable. |
| Sidebar layout shifts when the new button appears for flagged users | low | Keep the button at the bottom of the existing list. |
| Deep-links from web Open-button land on workspace root instead of the new pages | low (gated by URL update) | Update `deep-link-routes.ts` in the same slice that adds each route. |
| User has stale SWR cache after switching workbooks | low | SWR keys are keyed by workbookId already. |
| `MergeEditor`-specific props on `DiffView` are referenced elsewhere | very low | Confined to the one component we own. |

## Out of scope

- Removing the Publish History tab from the web app.
- Rewriting `SideBySideDiff` to add a unified mode.
- Adding rollback functionality (separate planned feature).
- Renaming "Author" → anything else.

## Touched files

**New (13):**
- `lib/date-format.ts` — `relativeTime(iso)` + `absoluteDate(iso, opts?)`
- `lib/publish-plan-icons.ts` — `PHASE_ICONS` map + `PhaseIcon` helper (extracted from web duplication)
- `lib/publish-api.ts` — extended with 5 new methods
- `components/base/CopyableCode.tsx` — extracted from web's inline helper
- 5 hook files
- `pages/PublishHistoryPage.tsx`
- `pages/PublishPlanDetailPage.tsx`
- `pages/workspace/PublishPlansList.tsx`
- `pages/workspace/PublishPlanRecordsList.tsx`

**Modified (4):**
- `types/user.ts` — add `ENABLE_PUBLISH_HISTORY`
- `App.tsx` — add two routes
- `pages/workspace/WorkspaceSidebar.tsx` — add flag-gated button (do not render until `user` is loaded, to avoid flicker)
- `lib/deep-link-routes.ts` — map web's `/workbook/:id/publish-history` and `/publish-plan/:planId`
- `pages/workspace/DataFolderInfoModal.tsx` — migrate inline `relativeTime` to import from `lib/date-format.ts`

Unchanged: server, shared-types, web client.

## Decisions captured during review

| # | Decision | Resolution |
| --- | --- | --- |
| D1 | Scope: full port or thinner v1 | **Full port** — all 3 slices |
| D2 | Whole-file diff fidelity vs SideBySideDiff limits | **Ship as-is**, iterate later |
| D3 | `PHASE_ICONS` duplication | **Extract** to `lib/publish-plan-icons.ts` |
| D4 | `CopyableCode` inline vs shared | **Extract** to `components/base/CopyableCode.tsx` |
| D5 | Unit test coverage | **Skip all tests** — manual QA only. Explicit override of "well-tested code is non-negotiable" preference for the migration. |
| D6 | Capture follow-up TODOs in TODOS.md | **Skip** — no follow-ups captured |

## Failure modes accounted for

- **Sidebar button flicker** during `useCurrentUser` load — render `null` until `user` is loaded, then evaluate flag.
- **`main_pre_plan_*` tag missing on old plans** — diff hook handles `null` original side gracefully (treated as add).
- **Plan deleted between list and detail click** — detail page null-checks `publishPlan` and renders "Plan not found."

## Unresolved tensions

- **D5 (skip all tests) contradicts your stated "well-tested code is non-negotiable" preference.** Captured as a deliberate override for migration velocity. Worth revisiting after the feature stabilizes — at minimum, `deep-link-routes.ts` extensions are high-leverage to test (silent wrong-page bug is invisible to QA).

## Parallelization

Sequential. Slice 2 depends on Slice 1 (uses the hooks); Slice 3 depends on Slice 2 (uses the route to navigate to). No worktree split worth doing.

## NOT in scope

- Removing the web Publish History tab/page.
- Adding unified diff mode on desktop.
- Adding line numbers / collapse-unchanged to `SideBySideDiff`.
- Component/integration test infrastructure on desktop.
- Rollback functionality (separate planned feature).

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | — |
| Codex Review | `/codex review` | Independent 2nd opinion | 0 | — | — |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | CLEAR (PLAN) | 3 issues, 0 critical gaps, 1 unresolved tension (D5: tests skipped) |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — | — |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | — | — |

- **UNRESOLVED:** 1 — skipped-test decision is a deliberate override of stated preference; revisit after feature stabilizes.
- **VERDICT:** ENG CLEARED — ready to implement.
