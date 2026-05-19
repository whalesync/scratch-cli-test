import { GenericApiEndpointOverrides } from '@spinner/shared-types';
import { ApigetSettings } from '../apiget';
import { applyOverridesToSettings, buildStrategyFromOverrides, resolvePageSize } from '../apply-overrides';

const baseSettings: ApigetSettings = {
  url: 'https://api.example.com/v1/items',
  method: 'GET',
  headers: [],
  body: undefined,
};

describe('resolvePageSize', () => {
  it('returns 100 when both are unset', () => {
    expect(resolvePageSize(undefined, undefined)).toBe(100);
  });

  it('uses maxPageSize when runtime is unset', () => {
    expect(resolvePageSize(undefined, 50)).toBe(50);
  });

  it('uses runtime when maxPageSize is unset', () => {
    expect(resolvePageSize(25, undefined)).toBe(25);
  });

  it('uses runtime when within max', () => {
    expect(resolvePageSize(25, 50)).toBe(25);
  });

  it('clamps runtime to maxPageSize when over', () => {
    expect(resolvePageSize(9999, 50)).toBe(50);
  });
});

describe('buildStrategyFromOverrides', () => {
  it('returns undefined when no overrides are set', () => {
    expect(buildStrategyFromOverrides({})).toBeUndefined();
  });

  it('returns null when paginationType is explicitly "none"', () => {
    expect(buildStrategyFromOverrides({ paginationType: 'none' })).toBeNull();
  });

  it('builds a cursor strategy from response.cursorPath alone', () => {
    const s = buildStrategyFromOverrides({ response: { cursorPath: 'response_metadata.next_cursor' } });
    expect(s).toEqual({
      type: 'cursor',
      cursorPath: 'response_metadata.next_cursor',
      dataPath: undefined,
      cursorParam: 'cursor',
      limit: undefined,
      limitParam: 'limit',
    });
  });

  it('builds a Slack-style cursor strategy from nested request+response overrides', () => {
    const s = buildStrategyFromOverrides({
      request: { cursorParam: 'cursor' },
      response: { cursorPath: 'response_metadata.next_cursor', dataPath: 'members' },
    });
    expect(s).toEqual({
      type: 'cursor',
      cursorPath: 'response_metadata.next_cursor',
      dataPath: 'members',
      cursorParam: 'cursor',
      limit: undefined,
      limitParam: 'limit',
    });
  });

  it('cursor strategy carries an optional limit when maxPageSize is set', () => {
    const s = buildStrategyFromOverrides({
      paginationType: 'cursor',
      request: { maxPageSize: 200 },
    });
    expect(s?.type).toBe('cursor');
    expect(s?.limit).toBe(200);
  });

  it('cursor strategy honors runtime.pageSize, clamped to maxPageSize', () => {
    const s = buildStrategyFromOverrides({ paginationType: 'cursor', request: { maxPageSize: 200 } }, 50);
    expect(s?.limit).toBe(50);
    const s2 = buildStrategyFromOverrides({ paginationType: 'cursor', request: { maxPageSize: 200 } }, 9999);
    expect(s2?.limit).toBe(200);
  });

  it('builds an offset strategy with maxPageSize as the default limit', () => {
    const s = buildStrategyFromOverrides({
      paginationType: 'offset',
      request: { maxPageSize: 50 },
    });
    expect(s).toEqual({ type: 'offset', dataPath: undefined, offsetParam: 'offset', limitParam: 'limit', limit: 50 });
  });

  it('uses runtimePageSize when supplied, clamped to maxPageSize', () => {
    const s = buildStrategyFromOverrides({ paginationType: 'offset', request: { maxPageSize: 50 } }, 9999);
    expect(s?.limit).toBe(50);
    const s2 = buildStrategyFromOverrides({ paginationType: 'offset', request: { maxPageSize: 50 } }, 10);
    expect(s2?.limit).toBe(10);
  });

  it('falls back to 100 when nothing tells it otherwise', () => {
    const s = buildStrategyFromOverrides({ paginationType: 'offset' });
    expect(s?.limit).toBe(100);
  });

  it('honors explicit paginationType=graphql with default cursorParam "after"', () => {
    const s = buildStrategyFromOverrides({
      paginationType: 'graphql',
      response: { cursorPath: 'data.issues.pageInfo.endCursor' },
    });
    expect(s).toEqual({
      type: 'graphql',
      cursorPath: 'data.issues.pageInfo.endCursor',
      dataPath: undefined,
      cursorParam: 'after',
    });
  });

  it('honors explicit paginationType=link-header', () => {
    expect(buildStrategyFromOverrides({ paginationType: 'link-header' })).toEqual({ type: 'link-header' });
  });

  it('treats dataPath alone as a cursor override', () => {
    const s = buildStrategyFromOverrides({ response: { dataPath: 'items' } });
    expect(s?.type).toBe('cursor');
    expect(s?.dataPath).toBe('items');
  });

  it('explicit paginationType wins over inference', () => {
    const s = buildStrategyFromOverrides({
      paginationType: 'offset',
      response: { cursorPath: 'whatever' },
      request: { maxPageSize: 50 },
    });
    expect(s?.type).toBe('offset');
    expect(s?.limit).toBe(50);
  });

  it('infers offset pagination when only maxPageSize is set', () => {
    const s = buildStrategyFromOverrides({ request: { maxPageSize: 25 } });
    expect(s?.type).toBe('offset');
    expect(s?.limit).toBe(25);
  });
});

describe('applyOverridesToSettings', () => {
  it('returns the original settings when overrides is undefined', () => {
    const out = applyOverridesToSettings(baseSettings, undefined);
    expect(out).toBe(baseSettings);
  });

  it('returns the original settings when overrides is empty', () => {
    const out = applyOverridesToSettings(baseSettings, {});
    expect(out.pagination).toBeUndefined();
    expect(out.maxPages).toBeUndefined();
    expect(out.enrich).toBeUndefined();
  });

  it('sets settings.pagination from response + request overrides', () => {
    const out = applyOverridesToSettings(baseSettings, {
      request: { cursorParam: 'cursor' },
      response: { cursorPath: 'response_metadata.next_cursor', dataPath: 'members' },
    });
    expect(out.pagination?.type).toBe('cursor');
    expect(out.pagination?.dataPath).toBe('members');
    expect(out.pagination?.cursorPath).toBe('response_metadata.next_cursor');
  });

  it('clears pagination when paginationType=none', () => {
    const settingsWithPagination: ApigetSettings = {
      ...baseSettings,
      pagination: { type: 'cursor', cursorPath: 'old', dataPath: 'old', cursorParam: 'old' },
    };
    const out = applyOverridesToSettings(settingsWithPagination, { paginationType: 'none' });
    expect(out.pagination).toBeUndefined();
  });

  it('passes through overrides.maxPages as settings.maxPages', () => {
    const out = applyOverridesToSettings(baseSettings, { maxPages: 50 });
    expect(out.maxPages).toBe(50);
  });

  it('ignores maxPages when 0 or negative', () => {
    expect(applyOverridesToSettings(baseSettings, { maxPages: 0 }).maxPages).toBeUndefined();
    expect(applyOverridesToSettings(baseSettings, { maxPages: -1 as number }).maxPages).toBeUndefined();
  });

  it('enables enrichment when enrichUrl is set', () => {
    const out = applyOverridesToSettings(baseSettings, { enrichUrl: '/v1/items/{id}' });
    expect(out.enrich).toEqual({ enabled: true, urlPattern: '/v1/items/{id}' });
  });

  it('flows runtime.pageSize into the offset strategy limit', () => {
    const out = applyOverridesToSettings(
      baseSettings,
      { paginationType: 'offset', request: { maxPageSize: 100 } },
      { pageSize: 2 },
    );
    expect(out.pagination?.limit).toBe(2);
  });

  it('clamps runtime.pageSize to maxPageSize when over', () => {
    const out = applyOverridesToSettings(
      baseSettings,
      { paginationType: 'offset', request: { maxPageSize: 100 } },
      { pageSize: 9999 },
    );
    expect(out.pagination?.limit).toBe(100);
  });

  it('combines pagination + maxPages + enrich overrides on one endpoint', () => {
    const adv: GenericApiEndpointOverrides = {
      response: { cursorPath: 'next', dataPath: 'items' },
      maxPages: 10,
      enrichUrl: '/v1/items/{id}',
    };
    const out = applyOverridesToSettings(baseSettings, adv);
    expect(out.pagination?.type).toBe('cursor');
    expect(out.maxPages).toBe(10);
    expect(out.enrich?.enabled).toBe(true);
  });
});
