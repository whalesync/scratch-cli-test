/**
 * Change-type filter chips — the subbar chip model + the client-side table filter behind it
 * (DEV-10656, Phase 9 of review surface v2). Closes chunk E (chips) and the remainder of chunk J
 * (drawer-stepper filter scoping).
 *
 * The chips are a thin view over the By-type groups the host already builds
 * ({@link buildByTypeGroupModel}), so a chip's count equals its By-type group's record count BY
 * CONSTRUCTION and each chip already knows its members' filenames — the same list that both narrows
 * the table and scopes the drawer stepper. Filtering is CLIENT-SIDE over the already-loaded
 * folder-wide pending set (cap 1000, `byTypeDiffData`); no new server/main-process `FilterKind`.
 *
 * Pure, no I/O — lives in a plain `.ts` module (no component export) per
 * `react-refresh/only-export-components`.
 */

import type { DiffGridResult } from '../diff-grid-types';
import { byTypeGroupKey, type ByTypeGroupModel } from './build-by-type-group-model';

/** One subbar chip: a label, a live count, and a color dot, keyed by its By-type group. */
export interface ChangeTypeChipModel {
  /** Stable id — equals `byTypeGroupKey(group)`, the value stored in the `change-type` `GridFilter`. */
  changeTypeGroupKey: string;
  /** Chip label — the group's title (a column display name, or "New" / "Removed" / "Needs attention"). */
  label: string;
  /** Records in this group — equals the By-type group header's record count. */
  count: number;
  /** CSS custom-property reference for the chip's 6px dot, e.g. `var(--modified-needs-review-stroke)`. */
  dotColorVar: string;
}

/**
 * One chip per By-type group, in the groups' order (field columns in view order, then New, Removed,
 * Needs attention). There is no dedicated "All" chip — the unfiltered state is "no chip active"
 * (`activeChangeTypeGroupKey === null`), reached by toggling the active chip off.
 */
export function buildChangeTypeChips(groups: readonly ByTypeGroupModel[]): ChangeTypeChipModel[] {
  return groups.map((group) => ({
    changeTypeGroupKey: byTypeGroupKey(group),
    label: group.title,
    count: group.rows.length,
    dotColorVar: group.dotColorVar,
  }));
}

/** The By-type group a chip key selects, or null for the "All" chip (`changeTypeGroupKey === null`). */
export function findChangeTypeGroup(
  groups: readonly ByTypeGroupModel[],
  changeTypeGroupKey: string | null,
): ByTypeGroupModel | null {
  if (changeTypeGroupKey === null) return null;
  return groups.find((group) => byTypeGroupKey(group) === changeTypeGroupKey) ?? null;
}

/**
 * Narrow the folder-wide pending diff to just the records in a change-type group — the table's data
 * source while that chip is active. Keeps the source result's columns / reference labels / validation
 * map (the grid renders these rows exactly like the paged set); only `rows` and `total` change.
 */
export function buildChangeTypeFilteredDiffData(
  folderWidePendingDiffData: DiffGridResult,
  group: ByTypeGroupModel,
): DiffGridResult {
  const groupRecordFilenameSet = new Set(group.recordFilenames);
  const rowsInGroup = folderWidePendingDiffData.rows.filter((row) => groupRecordFilenameSet.has(row.__filename));
  return {
    ...folderWidePendingDiffData,
    rows: rowsInGroup,
    total: rowsInGroup.length,
  };
}
