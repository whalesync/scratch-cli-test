/**
 * Apply per-endpoint `overrides` to apiget settings.
 *
 * The user-facing config carries an optional `overrides` block on each
 * endpoint (see `GenericApiEndpointOverrides`). Top-level fields:
 *   - `paginationType`, `maxPages`, `enrichUrl`
 * Plus two nested groups:
 *   - `request` — query-param names + page-size value we SEND
 *   - `response` — JSON paths into the response body
 *
 * apiget itself only understands a pre-built `Strategy` object plus a few
 * top-level settings, so this module is the translation layer.
 *
 * Used in two places that MUST stay in lockstep:
 *   - GenericApiConnector.composeSettings (production pull path)
 *   - scripts/apiget-driver.ts (iteration tool)
 *
 * Both call sites construct an ApigetSettings, then pipe it through
 * `applyOverridesToSettings(settings, endpoint.overrides)` before invoking
 * apigetStream.
 *
 * Note: `response.idPath` is NOT applied here — it's read by the connector's
 * `pullRecordFiles` (a per-record concern, not an apiget input). Callers
 * that respect that override should consult `endpoint.overrides.response.idPath`
 * directly when they extract IDs from records.
 */

import { GenericApiEndpointOverrides } from '@spinner/shared-types';
import { ApigetSettings, Strategy } from './apiget';

/**
 * Returns a new ApigetSettings with `overrides` folded in.
 *
 * If `overrides` is undefined or empty, returns the input unchanged. If any
 * pagination-related override is set, a `Strategy` is built and assigned to
 * `settings.pagination` — apigetStream skips auto-detection when this is
 * present, so the overrides take precedence over whatever the API response
 * looks like.
 *
 * `runtime.pageSize` is the *caller's* runtime preference for how many records
 * to ask for per page (default = the endpoint's `maxPageSize` from overrides,
 * else 100). It's clamped to `maxPageSize` to prevent blowing past the
 * server's hard cap. Stays out of the static overrides spec so fixtures only
 * describe the API contract, not transient runtime choices.
 */
export function applyOverridesToSettings(
  settings: ApigetSettings,
  overrides: GenericApiEndpointOverrides | undefined,
  runtime?: { pageSize?: number },
): ApigetSettings {
  if (!overrides && !runtime?.pageSize) return settings;

  const next: ApigetSettings = { ...settings };

  if (overrides) {
    const strategy = buildStrategyFromOverrides(overrides, runtime?.pageSize);
    if (strategy !== undefined) {
      next.pagination = strategy ?? undefined;
    }
    if (overrides.maxPages !== undefined && overrides.maxPages > 0) {
      next.maxPages = overrides.maxPages;
    }
    if (overrides.enrichUrl) {
      next.enrich = { enabled: true, urlPattern: overrides.enrichUrl };
    }
  }

  return next;
}

/**
 * Build a Strategy from the user's overrides.
 *
 * Returns:
 *   - `undefined` — no pagination overrides supplied (caller should keep
 *     auto-detection)
 *   - `null` — the user set `paginationType: 'none'` explicitly, meaning
 *     "this endpoint is single-page; don't try to paginate"
 *   - `Strategy` — a pre-built strategy that apiget should use as-is
 *
 * The split between `undefined` and `null` matches apigetStream's behavior:
 *   `settings.pagination ?? detectStrategyFromResponse(...)`
 * So returning undefined preserves auto-detection; returning null disables
 * pagination entirely.
 */
export function buildStrategyFromOverrides(
  overrides: GenericApiEndpointOverrides,
  runtimePageSize?: number,
): Strategy | null | undefined {
  const { paginationType, request, response } = overrides;
  const cursorPath = response?.cursorPath;
  const dataPath = response?.dataPath;
  const cursorParam = request?.cursorParam;
  const offsetParam = request?.offsetParam;
  const pageParam = request?.pageParam;
  const limitParam = request?.limitParam;

  // Explicit "none" — caller wants pagination disabled.
  if (paginationType === 'none') return null;

  // Explicit pagination type wins; otherwise infer from which fields are set.
  const type = paginationType ?? inferPaginationType(overrides);
  if (!type) return undefined; // no overrides → fall through to auto-detect

  switch (type) {
    case 'cursor':
      return {
        type: 'cursor',
        cursorPath,
        dataPath,
        cursorParam: cursorParam ?? 'cursor',
        // Optional for cursor — apiget only sets ?limit when supplied. APIs like
        // Slack/OpenPhone tolerate the cursor without a limit (server uses its
        // own default).
        limit: resolveOptionalPageSize(runtimePageSize, request?.maxPageSize),
        limitParam: limitParam ?? 'limit',
      };
    case 'offset':
      return {
        type: 'offset',
        dataPath,
        offsetParam: offsetParam ?? 'offset',
        limitParam: limitParam ?? 'limit',
        // Required for offset — apiget needs a limit to compute the next-page
        // offset and to decide "is this page full" termination.
        limit: resolvePageSize(runtimePageSize, request?.maxPageSize),
      };
    case 'graphql':
      return {
        type: 'graphql',
        cursorPath,
        dataPath,
        cursorParam: cursorParam ?? 'after',
      };
    case 'link-header':
      return { type: 'link-header' };
    case 'page':
      return {
        type: 'page',
        dataPath,
        pageParam: pageParam ?? 'page',
        limitParam: limitParam ?? 'per_page',
        // Required for page — apiget needs a limit to send `?per_page=N` on
        // subsequent requests and to keep page size consistent across pages.
        limit: resolvePageSize(runtimePageSize, request?.maxPageSize),
      };
  }
}

/**
 * Like `resolvePageSize` but returns undefined when neither value is set —
 * caller skips sending the param entirely (used for cursor strategies where
 * the limit is optional).
 */
export function resolveOptionalPageSize(
  runtimePageSize: number | undefined,
  maxPageSize: number | undefined,
): number | undefined {
  if (runtimePageSize === undefined && maxPageSize === undefined) return undefined;
  return resolvePageSize(runtimePageSize, maxPageSize);
}

/**
 * Compute the effective limit value to send.
 *   - If runtimePageSize is unset → default to maxPageSize, falling back to 100.
 *   - If runtimePageSize is set   → clamp to maxPageSize when defined.
 *
 * Keeps a clean separation: `maxPageSize` is the API constraint (fixture-side
 * fact), `runtimePageSize` is the caller's choice for THIS run (driver flag,
 * future memory-aware logic, etc.).
 */
export function resolvePageSize(runtimePageSize: number | undefined, maxPageSize: number | undefined): number {
  const requested = runtimePageSize ?? maxPageSize ?? 100;
  if (maxPageSize !== undefined && requested > maxPageSize) return maxPageSize;
  return requested;
}

/** Infer pagination type from which override fields are populated. */
function inferPaginationType(overrides: GenericApiEndpointOverrides): Strategy['type'] | undefined {
  const { request, response } = overrides;
  if (response?.cursorPath !== undefined || request?.cursorParam !== undefined) {
    return 'cursor';
  }
  if (request?.pageParam !== undefined) {
    return 'page';
  }
  if (request?.offsetParam !== undefined || request?.limitParam !== undefined || request?.maxPageSize !== undefined) {
    return 'offset';
  }
  // dataPath alone — treat as cursor (most common manual override case).
  if (response?.dataPath !== undefined) {
    return 'cursor';
  }
  return undefined;
}
