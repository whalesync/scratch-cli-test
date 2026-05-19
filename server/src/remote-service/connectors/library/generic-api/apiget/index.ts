/**
 * apiget public surface — what the GENERIC_API connector imports.
 *
 * Internal modules (internal-helpers.ts) are intentionally NOT re-exported;
 * they're implementation detail.
 */

// Runner — the HTTP loop
export { apiget, apigetStream } from './fetch';

// Pagination primitives — exported for tests and for the connector's
// per-endpoint probe override flow
export {
  COMMON_CURSOR_FIELDS,
  COMMON_CURSOR_PARAMS,
  COMMON_DATA_FIELDS,
  buildNextURL,
  detectStrategy,
  detectStrategyFromResponse,
  extractData,
  extractNextCursor,
  hasMorePages,
  parseNextLink,
} from './pagination';

// Enrich primitives — exported for the connector's pullRecordFilesByIds flow
export { COMMON_ID_FIELDS, enrichRecords, findIdField, inferDetailURL } from './enrich';

// Expand primitives — exported for the connector's expansion config
export { buildChildrenURL, expandNested } from './expander';

// Types
export type {
  ApigetOpts,
  ApigetProgress,
  ApigetResult,
  ApigetSettings,
  ApigetStreamYield,
  EnrichConfig,
  ExpanderConfig,
  FetchFn,
  FetchRequest,
  FetchResponse,
  Header,
  Strategy,
} from './types';

export { HttpStatusError, MaxPagesReachedError, NonJsonResponseError, PaginationLoopError } from './types';
