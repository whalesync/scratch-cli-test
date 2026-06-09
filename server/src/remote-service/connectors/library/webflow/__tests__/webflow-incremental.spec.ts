import { IncrementalPullSupport } from '@spinner/shared-types';
import {
  buildWebflowLastUpdatedFilter,
  isWebflowCollectionItemsTable,
  WEBFLOW_INCREMENTAL_CLOCK_SKEW_MS,
  webflowIncrementalPullSupport,
} from '../webflow-incremental';
import { WEBFLOW_ASSETS_TABLE_ID_PREFIX } from '../webflow-json-schema';
import { WEBFLOW_PAGES_TABLE_ID_PREFIX } from '../webflow-types';

describe('WEBFLOW_INCREMENTAL_CLOCK_SKEW_MS', () => {
  it('is 60s — the watermark is client-side while `lastUpdated` is server-side', () => {
    expect(WEBFLOW_INCREMENTAL_CLOCK_SKEW_MS).toBe(60_000);
  });
});

describe('buildWebflowLastUpdatedFilter', () => {
  it('renders the clock-skewed watermark as a full millisecond-precision ISO-8601 UTC string', () => {
    const since = new Date('2026-05-14T12:00:00.000Z');
    expect(buildWebflowLastUpdatedFilter(since)).toBe('2026-05-14T11:59:00.000Z');
  });

  it('subtracts exactly WEBFLOW_INCREMENTAL_CLOCK_SKEW_MS from the watermark', () => {
    const since = new Date('2026-01-01T00:00:00.000Z');
    const expected = new Date(since.getTime() - WEBFLOW_INCREMENTAL_CLOCK_SKEW_MS).toISOString();
    expect(buildWebflowLastUpdatedFilter(since)).toBe(expected);
  });

  it('keeps milliseconds (Webflow itself emits millisecond-precision lastUpdated)', () => {
    const since = new Date('2026-05-14T12:00:00.123Z');
    const value = buildWebflowLastUpdatedFilter(since);
    expect(value).toBe('2026-05-14T11:59:00.123Z');
    expect(value).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });
});

describe('isWebflowCollectionItemsTable', () => {
  it('is true for a real CMS collection remote id', () => {
    expect(isWebflowCollectionItemsTable('580e63fc8c9a982ac9b8b745')).toBe(true);
  });

  it('is false for the Assets and Pages synthetic table ids', () => {
    expect(isWebflowCollectionItemsTable(`${WEBFLOW_ASSETS_TABLE_ID_PREFIX}site-1`)).toBe(false);
    expect(isWebflowCollectionItemsTable(`${WEBFLOW_PAGES_TABLE_ID_PREFIX}site-1`)).toBe(false);
  });
});

describe('webflowIncrementalPullSupport', () => {
  it('SUPPORTED for CMS collections, NOT_SUPPORTED for Assets/Pages tables', () => {
    expect(webflowIncrementalPullSupport('580e63fc8c9a982ac9b8b745')).toBe(IncrementalPullSupport.SUPPORTED);
    expect(webflowIncrementalPullSupport(`${WEBFLOW_ASSETS_TABLE_ID_PREFIX}site-1`)).toBe(
      IncrementalPullSupport.NOT_SUPPORTED,
    );
    expect(webflowIncrementalPullSupport(`${WEBFLOW_PAGES_TABLE_ID_PREFIX}site-1`)).toBe(
      IncrementalPullSupport.NOT_SUPPORTED,
    );
  });
});
