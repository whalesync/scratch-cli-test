import type { JSONPathOptions } from '../sync-mapping';
import { applyJsonPath } from './apply-jsonpath';

/**
 * The narrow set of transformers a renderer may run on a value to derive its
 * DISPLAY string. Deliberately NOT the full sync `TransformerConfig` union —
 * that union carries server-only arms (lookup / foreign-key / asset matching)
 * whose options reference `DataFolderId` / `Service` / `LookupTools`, which the
 * desktop cannot execute and must not receive on a serialized view column.
 *
 * Extend this union only with transformers that are pure (value -> value) and
 * safe to run client-side (e.g. trim, slugify) when a real column needs them.
 */
export type DisplayTransformerConfig = { type: 'jsonpath'; options: JSONPathOptions };

export type DisplayResult = { ok: true; value: string } | { ok: false };

/**
 * Apply a column's `displayTransformer` to a cell value, producing a display
 * STRING. Display-only: the caller feeds the result to the rendered cell, never
 * to the edit / copy / persisted value.
 *
 * FAIL-CLOSED. Any shape the transformer can't cleanly turn into text returns
 * `{ ok: false }` so the caller falls back to showing the raw value verbatim.
 * This is the key difference from the sync transformer's `concat`, which fails
 * OPEN — it silently drops array positions whose key is missing and stringifies
 * `null` to the literal `"null"`. For a Notion rich-text array
 * (`[{plain_text}, ...]`) flattened with `$[*].plain_text`, we require that
 * every element contributed exactly one string match:
 *   - a span missing `plain_text`  -> dropped -> match count < input length -> {ok:false}
 *   - a span with `plain_text:null` -> non-string match            -> {ok:false}
 *   - an empty array                -> '' (an empty field shows blank)
 * honoring the product principle *Surface failures, never silently succeed*.
 *
 * `arrayHandling: 'first'` (e.g. an Attio value array `[{value: X, ...}]` keyed
 * with `$[0].value`) extracts a single scalar: a string is shown verbatim, a
 * number / boolean is rendered as its display string, an empty array shows
 * blank, and anything else (object / array / missing key) fails closed.
 */
export function applyDisplayTransformer(config: DisplayTransformerConfig, value: unknown): DisplayResult {
  if (value === null || value === undefined) return { ok: false };

  switch (config.type) {
    case 'jsonpath': {
      const { expression, arrayHandling = 'first' } = config.options;
      // Always fetch the raw matches so we can validate before joining, rather
      // than trusting the (fail-open) concat reduction.
      const result = applyJsonPath(value, expression, 'array');
      if (!result.ok || !Array.isArray(result.value)) return { ok: false };
      // `Array.isArray` narrows `unknown` to `any[]`; re-type as `unknown[]` so
      // element handling stays type-safe (no implicit `any`).
      const matches = result.value as unknown[];

      switch (arrayHandling) {
        case 'first': {
          // An empty array input (e.g. an unset Attio field stored as `[]`) has
          // nothing to extract — show blank, mirroring the empty-array handling
          // in the join branches below. A *non-empty* array whose key is missing
          // still falls through to fail closed (raw value shown), so a genuinely
          // malformed value surfaces rather than silently blanking.
          if (Array.isArray(value) && value.length === 0) return { ok: true, value: '' };
          const first = matches[0];
          if (typeof first === 'string') return { ok: true, value: first };
          // Scalar number / boolean first-matches (e.g. an Attio number, currency,
          // rating, or checkbox value) render as their decimal / `true|false`
          // string. Objects / arrays / null / undefined still fail closed so the
          // caller falls back to showing the raw value verbatim.
          if (typeof first === 'number' || typeof first === 'boolean') return { ok: true, value: String(first) };
          return { ok: false };
        }
        case 'concat':
        case 'join_space':
        case 'join_comma': {
          // Flatten-and-join only makes sense over an array input.
          if (!Array.isArray(value)) return { ok: false };
          // No silently dropped positions: every element must have contributed
          // exactly one match (a missing key drops a position -> count mismatch).
          if (matches.length !== value.length) return { ok: false };
          if (matches.length === 0) return { ok: true, value: '' };
          // Every match must be a string (a null/number plain_text fails closed).
          if (!matches.every((match): match is string => typeof match === 'string')) return { ok: false };
          const delimiter = arrayHandling === 'join_space' ? ' ' : arrayHandling === 'join_comma' ? ', ' : '';
          return { ok: true, value: matches.join(delimiter) };
        }
        default:
          // 'array' (and any future non-string reduction) is not a display string.
          return { ok: false };
      }
    }
    default:
      return { ok: false };
  }
}
