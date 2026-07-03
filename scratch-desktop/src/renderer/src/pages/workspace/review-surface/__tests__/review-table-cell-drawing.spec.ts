import { describe, expect, it } from 'vitest';
import type { RowStatus } from '../../diff-grid-types';
import {
  __clearWordDiffCacheForTest,
  getStatusDotVar,
  getWordDiffSegmentsCached,
  STATUS_CELL_STROKE_VAR,
  STATUS_CELL_TINT_VAR,
  STATUS_DOT_VAR,
  wordDiffCacheKey,
} from '../review-table-cell-drawing';

describe('getWordDiffSegmentsCached', () => {
  it('returns the same segment array reference for a repeated key (memoized)', () => {
    __clearWordDiffCacheForTest();
    const first = getWordDiffSegmentsCached('k', 'alpha beta', 'alpha gamma');
    const second = getWordDiffSegmentsCached('k', 'alpha beta', 'alpha gamma');
    expect(second).toBe(first);
  });

  it('recomputes (new reference) after the cache is cleared', () => {
    __clearWordDiffCacheForTest();
    const before = getWordDiffSegmentsCached('k', 'a', 'b');
    __clearWordDiffCacheForTest();
    const after = getWordDiffSegmentsCached('k', 'a', 'b');
    expect(after).not.toBe(before);
    expect(after).toEqual(before);
  });

  it('evicts the whole cache once it exceeds its bound', () => {
    __clearWordDiffCacheForTest();
    const anchor = getWordDiffSegmentsCached('anchor', 'a', 'b');
    // Add enough distinct keys to guarantee the wholesale clear-on-overflow fires.
    for (let i = 0; i < 2100; i++) {
      getWordDiffSegmentsCached(`key-${i}`, `from-${i}`, `to-${i}`);
    }
    const anchorAgain = getWordDiffSegmentsCached('anchor', 'a', 'b');
    expect(anchorAgain).not.toBe(anchor);
  });
});

describe('wordDiffCacheKey', () => {
  it('changes when any of filename / column / from / to changes', () => {
    const base = wordDiffCacheKey('a.json', 'title', 'old', 'new');
    expect(wordDiffCacheKey('a.json', 'title', 'old', 'new')).toBe(base);
    expect(wordDiffCacheKey('b.json', 'title', 'old', 'new')).not.toBe(base);
    expect(wordDiffCacheKey('a.json', 'price', 'old', 'new')).not.toBe(base);
    expect(wordDiffCacheKey('a.json', 'title', 'OLD', 'new')).not.toBe(base);
    expect(wordDiffCacheKey('a.json', 'title', 'old', 'NEW')).not.toBe(base);
  });
});

describe('getStatusDotVar', () => {
  it('maps each change type to its stroke token, with muted -approved variants and no dot for unchanged/invalid', () => {
    const expected: Record<RowStatus, string | null> = {
      added: '--create-needs-review-stroke',
      addedUnpublished: '--create-approved-stroke',
      modified: '--modified-needs-review-stroke',
      unpublished: '--modified-approved-stroke',
      deleted: '--delete-needs-review-stroke',
      deletedUnpublished: '--delete-approved-stroke',
      unchanged: null,
      invalidJson: null,
    };
    expect(STATUS_DOT_VAR).toEqual(expected);
    for (const status of Object.keys(expected) as RowStatus[]) {
      expect(getStatusDotVar(status)).toBe(expected[status]);
    }
  });
});

describe('status cell token maps', () => {
  it('tints created/deleted/invalid rows and leaves modified/unchanged untinted', () => {
    const expected: Record<RowStatus, string | null> = {
      added: '--create-needs-review-bg',
      addedUnpublished: '--create-approved-bg',
      modified: null,
      unpublished: null,
      deleted: '--delete-needs-review-bg',
      deletedUnpublished: '--delete-approved-bg',
      unchanged: null,
      invalidJson: '#fff7ed',
    };
    expect(STATUS_CELL_TINT_VAR).toEqual(expected);
  });

  it('colours created/deleted row text and leaves the rest default', () => {
    const expected: Record<RowStatus, string | null> = {
      added: '--create-needs-review-stroke',
      addedUnpublished: '--create-needs-review-stroke',
      modified: null,
      unpublished: null,
      deleted: '--delete-needs-review-stroke',
      deletedUnpublished: '--delete-needs-review-stroke',
      unchanged: null,
      invalidJson: null,
    };
    expect(STATUS_CELL_STROKE_VAR).toEqual(expected);
  });
});
