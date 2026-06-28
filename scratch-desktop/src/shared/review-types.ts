/**
 * Per-folder review-state counts surfaced by `scratchmd files get-review-stats`
 * (and its in-process napi sibling, `scratchmd-native::getReviewStats`).
 *
 * Powers the desktop sidebar's "Needs review" (blue) and "Approved" (gray)
 * folder-tree dots — see
 * `docs/plans/resolved/2026-05-31-folder-tree-review-approved-dots/2026-05-31-folder-tree-review-approved-dots.md`.
 *
 * Field naming is snake_case to mirror `ValidationStat` so consumers can key
 * both maps off the same `${connection}/${folder_path}` string.
 */
export type ReviewStat = {
  connection: string;
  folder_path: string;
  /** Files where the working copy differs from the approved (post-patch) version. */
  unreviewed: number;
  /** Files with an entry in accepted-patches.json (approved but not yet published). */
  approved: number;
};
