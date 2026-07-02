import { diffArrays } from 'diff';

/**
 * Paragraph-level diff for long-form text fields, used by `ContentDiffWithMap`.
 *
 * Lives in a plain `.ts` module (no component exports) so it satisfies
 * `react-refresh/only-export-components` and stays unit-testable like
 * `src/shared/word-diff.ts`. Connector-agnostic: it reasons purely about the
 * *shape* of the text, never about which service or field produced it.
 */

export type ParagraphChangeKind = 'unchanged' | 'modified' | 'created' | 'deleted';

export interface ParagraphDiffEntry {
  kind: ParagraphChangeKind;
  /** The "before" paragraph text. Empty string for `created`. For `unchanged` runs, the joined run text. */
  from: string;
  /** The "after" paragraph text. Empty string for `deleted`. For `unchanged` runs, the joined run text. */
  to: string;
  /**
   * 1-based index in document order, assigned ONLY to changed entries
   * (modified | created | deleted). Used as the stable key for paragraph refs,
   * the minimap tick id, and any "Change N / M" affordance. `undefined` for
   * unchanged runs.
   */
  changeIndex?: number;
  /**
   * Number of source paragraphs collapsed into this run. Present ONLY on
   * `unchanged` entries — drives the "▾ N unchanged paragraph(s)" divider label.
   */
  unchangedCount?: number;
}

export interface ParagraphDiffResult {
  entries: ParagraphDiffEntry[];
  /** Total number of changed entries (equals the largest `changeIndex`). */
  changeCount: number;
  counts: { modified: number; created: number; deleted: number };
}

/** A run of one-or-more blank lines separates paragraphs in CMS-style prose. */
const PARAGRAPH_BOUNDARY = /\n\s*\n/;

interface SplitResult {
  paragraphs: string[];
  /** The separator to re-join paragraphs with when reconstructing an unchanged run for display. */
  separator: string;
}

/**
 * Split text into paragraphs by content shape.
 *
 * Primary rule: split on blank-line boundaries — CMS bodies (Webflow, WordPress,
 * Notion) delimit paragraphs that way, and a lone `\n` is usually a soft break
 * *within* a paragraph, so splitting on it would over-fragment the diff.
 *
 * Fallback: a body that has hard line breaks but no blank lines (plain-text
 * notes) still reads better diffed line-by-line than as one giant paragraph, so
 * when the blank-line split yields a single block that still contains `\n`, split
 * that block on single newlines instead. Text with no newlines stays one paragraph.
 */
function splitIntoParagraphs(text: string): SplitResult {
  const byBlankLine = text
    .split(PARAGRAPH_BOUNDARY)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph.length > 0);

  if (byBlankLine.length > 1) {
    return { paragraphs: byBlankLine, separator: '\n\n' };
  }

  if (byBlankLine.length === 1 && byBlankLine[0].includes('\n')) {
    const byLine = byBlankLine[0]
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    if (byLine.length > 1) {
      return { paragraphs: byLine, separator: '\n' };
    }
  }

  return { paragraphs: byBlankLine, separator: '\n\n' };
}

/**
 * Diff two long-form text values at the paragraph level.
 *
 * The text is split into paragraphs and run through the `diff` package's
 * `diffArrays` (Myers diff over paragraph tokens — cheap even for hundreds of
 * paragraphs). Each adjacent removed-run is then paired element-wise with the
 * following added-run to produce `modified` paragraphs (which the renderer
 * word-diffs inline); any leftover removed paragraphs become `deleted` and any
 * leftover added paragraphs become `created`. Common runs collapse to a single
 * `unchanged` entry carrying the run's paragraph count.
 *
 * Unchanged paragraphs anchor the alignment, so a mis-pairing is bounded to a
 * single edited region — and the per-paragraph redline always reproduces the
 * true before/after regardless.
 */
export function getParagraphDiff(fromText: string, toText: string): ParagraphDiffResult {
  const fromParagraphs = splitIntoParagraphs(fromText).paragraphs;
  const toSplit = splitIntoParagraphs(toText);
  const toParagraphs = toSplit.paragraphs;
  const unchangedRunSeparator = toSplit.separator;

  const runs = diffArrays(fromParagraphs, toParagraphs);

  const entries: ParagraphDiffEntry[] = [];
  const counts = { modified: 0, created: 0, deleted: 0 };
  let changeCounter = 0;

  const pushModified = (fromParagraph: string, toParagraph: string): void => {
    changeCounter += 1;
    counts.modified += 1;
    entries.push({ kind: 'modified', from: fromParagraph, to: toParagraph, changeIndex: changeCounter });
  };
  const pushCreated = (toParagraph: string): void => {
    changeCounter += 1;
    counts.created += 1;
    entries.push({ kind: 'created', from: '', to: toParagraph, changeIndex: changeCounter });
  };
  const pushDeleted = (fromParagraph: string): void => {
    changeCounter += 1;
    counts.deleted += 1;
    entries.push({ kind: 'deleted', from: fromParagraph, to: '', changeIndex: changeCounter });
  };

  let pendingRemovedParagraphs: string[] | null = null;
  const flushPendingRemovedAsDeleted = (): void => {
    if (pendingRemovedParagraphs) {
      for (const removedParagraph of pendingRemovedParagraphs) pushDeleted(removedParagraph);
      pendingRemovedParagraphs = null;
    }
  };

  for (const run of runs) {
    const runParagraphs = run.value;
    if (run.removed) {
      // Two removed runs back-to-back can't happen (diffArrays coalesces), but if a
      // prior removed run was never paired with an added run, flush it before tracking this one.
      flushPendingRemovedAsDeleted();
      pendingRemovedParagraphs = runParagraphs;
    } else if (run.added) {
      if (pendingRemovedParagraphs) {
        const removedParagraphs = pendingRemovedParagraphs;
        pendingRemovedParagraphs = null;
        const pairedCount = Math.min(removedParagraphs.length, runParagraphs.length);
        for (let index = 0; index < pairedCount; index += 1) {
          pushModified(removedParagraphs[index], runParagraphs[index]);
        }
        for (let index = pairedCount; index < removedParagraphs.length; index += 1) {
          pushDeleted(removedParagraphs[index]);
        }
        for (let index = pairedCount; index < runParagraphs.length; index += 1) {
          pushCreated(runParagraphs[index]);
        }
      } else {
        for (const addedParagraph of runParagraphs) pushCreated(addedParagraph);
      }
    } else {
      flushPendingRemovedAsDeleted();
      const runText = runParagraphs.join(unchangedRunSeparator);
      entries.push({ kind: 'unchanged', from: runText, to: runText, unchangedCount: runParagraphs.length });
    }
  }
  flushPendingRemovedAsDeleted();

  return { entries, changeCount: changeCounter, counts };
}

const LONGFORM_MIN_CHARS = 300;
const LONGFORM_MIN_WORDS = 50;

/**
 * Decide, by content shape alone, whether a field's change should render as a
 * long-form `ContentDiffWithMap` rather than the compact `ChangedFieldBlock`.
 *
 * Deliberately connector-agnostic — it never looks at the field name (no
 * `if (field === 'description')`), only at length and word count, so a long body
 * from any service lights up the rich diff while titles, slugs, and short
 * taglines stay on the compact renderer. The two gates together mean "more than a
 * couple of sentences of real prose"; a long single-paragraph description still
 * qualifies (the component renders a single paragraph fine), and neither a long
 * machine token (few words, many chars) nor a many-token-but-tiny value slips through.
 */
export function isLongFormContent(fromValue: string, toValue: string): boolean {
  // Use the longer side so a near-empty `from` (created) or `to` (deleted) still qualifies.
  const text = toValue.length >= fromValue.length ? toValue : fromValue;
  if (text.length < LONGFORM_MIN_CHARS) return false;
  const wordCount = text.trim().split(/\s+/).filter(Boolean).length;
  return wordCount >= LONGFORM_MIN_WORDS;
}
