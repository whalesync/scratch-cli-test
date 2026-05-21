/**
 * Shared type definitions and constants for field-value rendering in the record detail view
 * and cell popovers. Extracted into a plain `.ts` module (no components) to satisfy the
 * react-refresh rule that `.tsx` files exporting components must not also export non-components.
 */

export type FieldValueDiffKind = 'unreviewed' | 'unpublished' | null;
export type FieldValueDisplayMode = 'diff' | 'current';
export type FieldValueDiffViewMode = 'side-by-side' | 'inline-words';

export const DIFF_WORKING_BG = 'var(--modified-needs-review-bg)';
export const DIFF_UNPUBLISHED_BG = 'var(--modified-approved-bg)';
export const DIFF_REMOVED_BG = '#fee2e2'; // red-100
export const DIFF_REMOVED_FG = '#dc2626'; // red-600

export const DIFF_TEXT_STYLE: React.CSSProperties = {
  fontFamily: 'monospace',
  fontSize: 13,
  lineHeight: 1.5,
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
};

export function getAddedBg(diffKind: FieldValueDiffKind): string {
  return diffKind === 'unreviewed' ? DIFF_WORKING_BG : DIFF_UNPUBLISHED_BG;
}
