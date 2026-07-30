import type { EpochToIsoOptions, JSONPathOptions } from '../sync-mapping';
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
export type DisplayTransformerConfig =
  | { type: 'jsonpath'; options: JSONPathOptions }
  | { type: 'computed-field'; options: ComputedFieldOptions }
  | { type: 'epoch_to_iso'; options?: EpochToIsoOptions };

/**
 * Options for the `computed-field` display transformer — a generic flattener for
 * a service-COMPUTED cell whose stored value may be a bare scalar, a
 * value-wrapper object, an error/special-value wrapper object, or an array of
 * any of those. Introduced for Airtable's aiText (`{ state, value, isStale }`)
 * and formula/rollup/lookup error (`{ error }` / `{ specialValue }`) shapes, but
 * carries no connector-specific knowledge — a connector supplies the key names.
 */
export interface ComputedFieldOptions {
  /**
   * Keys tried IN ORDER to read a displayable scalar out of a wrapper object —
   * the first key the object owns wins. Covers both Airtable aiText's `value`
   * and the numeric special-value wrapper's `specialValue` (`1/0` →
   * `{ specialValue: "Infinity" }`, `0/0` → `{ specialValue: "NaN" }`), which are
   * legitimate results to SHOW, not errors. A wrapper whose winning key holds
   * null / an empty state renders blank.
   */
  valueKeys: string[];
  /**
   * Object keys whose mere presence marks the cell as a genuine error to render
   * blank rather than as raw JSON (e.g. Airtable's `error` → `{ error: "#ERROR!" }`).
   */
  blankOnKeys: string[];
}

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
 *
 * A `displayTransformer` is DATA baked into a view at pull time, so a renderer
 * can always meet a config whose shape it doesn't expect (a view pulled by an
 * older or newer server, a malformed option). The whole body is wrapped so ANY
 * throw fails closed to `{ ok: false }` — a display transformer must never crash
 * the grid; the worst case is the raw value shown verbatim.
 */
export function applyDisplayTransformer(config: DisplayTransformerConfig, value: unknown): DisplayResult {
  if (value === null || value === undefined) return { ok: false };

  try {
    return applyDisplayTransformerUnsafe(config, value);
  } catch {
    return { ok: false };
  }
}

function applyDisplayTransformerUnsafe(config: DisplayTransformerConfig, value: unknown): DisplayResult {
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
    case 'computed-field':
      return applyComputedFieldTransformer(config.options, value);
    case 'epoch_to_iso':
      return applyEpochToIsoTransformer(config.options?.unit ?? 'seconds', value);
    default:
      return { ok: false };
  }
}

/**
 * Milliseconds either side of the epoch that `new Date(ms)` can represent; beyond this the Date
 * is Invalid and `toISOString()` throws.
 */
const MAX_REPRESENTABLE_EPOCH_MILLISECONDS = 8.64e15;

/**
 * Render a Unix-epoch NUMBER as an ISO-8601 string, so a grid shows a date where the raw value is
 * an integer (Stripe/Intercom timestamps). Mirrors the `epoch_to_iso` sync transformer, keeping the
 * cell and the exported value in step. Fails closed — the raw number is then shown verbatim — for
 * anything that isn't a finite, representable epoch.
 */
function applyEpochToIsoTransformer(unit: 'seconds' | 'milliseconds', value: unknown): DisplayResult {
  const epochValue = typeof value === 'string' ? Number(value) : value;
  if (typeof epochValue !== 'number' || !Number.isFinite(epochValue)) return { ok: false };

  const epochMilliseconds = unit === 'seconds' ? epochValue * 1000 : epochValue;
  if (Math.abs(epochMilliseconds) > MAX_REPRESENTABLE_EPOCH_MILLISECONDS) return { ok: false };

  return { ok: true, value: new Date(epochMilliseconds).toISOString() };
}

/**
 * The outcome of flattening a single computed-field element: a display string, a
 * deliberate blank (an empty aiText value or an error wrapper), or a fail-closed
 * shape the transformer can't cleanly render (so the caller shows the raw value).
 */
type ComputedFieldElementResult = { kind: 'string'; value: string } | { kind: 'blank' } | { kind: 'fail' };

/**
 * Flatten ONE computed-field element to a display outcome. Handles the shapes a
 * service-computed value takes:
 *   - a bare scalar (a plain formula/rollup/lookup result)       -> its string
 *   - null / undefined (an empty computed cell)                  -> blank
 *   - a value-wrapper object (`{ [valueKey]: scalar | null }`)   -> the scalar (aiText `value`,
 *     or the special-value string `{ specialValue: "Infinity" }`), or blank when null/empty
 *   - a genuine error wrapper (`{ error: "#ERROR!" }`)           -> blank
 * Anything else (a nested array, or a wrapper owning none of the keys) fails closed.
 */
function flattenComputedFieldElement(
  valueKeys: string[],
  blankOnKeys: string[],
  element: unknown,
): ComputedFieldElementResult {
  if (element === null || element === undefined) return { kind: 'blank' };
  if (typeof element === 'string') return { kind: 'string', value: element };
  if (typeof element === 'number' || typeof element === 'boolean') return { kind: 'string', value: String(element) };
  if (Array.isArray(element)) return { kind: 'fail' };
  if (typeof element === 'object') {
    const objectElement = element as Record<string, unknown>;
    // A genuine error wrapper renders blank rather than as raw JSON.
    if (blankOnKeys.some((key) => Object.prototype.hasOwnProperty.call(objectElement, key))) {
      return { kind: 'blank' };
    }
    // First value-bearing key the wrapper owns wins (aiText `value`, then the
    // numeric `specialValue`), so Infinity / NaN render as their string.
    for (const valueKey of valueKeys) {
      if (Object.prototype.hasOwnProperty.call(objectElement, valueKey)) {
        const inner = objectElement[valueKey];
        if (inner === null || inner === undefined) return { kind: 'blank' };
        if (typeof inner === 'string') return { kind: 'string', value: inner };
        if (typeof inner === 'number' || typeof inner === 'boolean') return { kind: 'string', value: String(inner) };
        return { kind: 'fail' };
      }
    }
    return { kind: 'fail' };
  }
  return { kind: 'fail' };
}

/**
 * Apply the `computed-field` transformer. A top-level array (e.g. an Airtable
 * `multipleLookupValues` array of per-item results) flattens each element and
 * joins the non-blank display strings with ', '; an empty array shows blank. A
 * single value flattens directly. Any element the transformer can't cleanly
 * render fails the whole cell closed so the caller falls back to the raw value.
 */
function applyComputedFieldTransformer(options: ComputedFieldOptions, value: unknown): DisplayResult {
  // Coerce the key lists to arrays: a config baked into a view before this
  // option shape existed (or otherwise malformed) must fail closed to the raw
  // value, never throw. `valueKeys: []` means no object shape can be unwrapped,
  // so wrappers fall through to fail-closed.
  const valueKeys = Array.isArray(options.valueKeys) ? options.valueKeys : [];
  const blankOnKeys = Array.isArray(options.blankOnKeys) ? options.blankOnKeys : [];

  if (Array.isArray(value)) {
    if (value.length === 0) return { ok: true, value: '' };
    const renderedParts: string[] = [];
    for (const element of value) {
      const elementResult = flattenComputedFieldElement(valueKeys, blankOnKeys, element);
      if (elementResult.kind === 'fail') return { ok: false };
      if (elementResult.kind === 'string') renderedParts.push(elementResult.value);
      // 'blank' elements (empty aiText / errors) are dropped from the joined display.
    }
    return { ok: true, value: renderedParts.join(', ') };
  }

  const singleResult = flattenComputedFieldElement(valueKeys, blankOnKeys, value);
  if (singleResult.kind === 'fail') return { ok: false };
  if (singleResult.kind === 'blank') return { ok: true, value: '' };
  return { ok: true, value: singleResult.value };
}
