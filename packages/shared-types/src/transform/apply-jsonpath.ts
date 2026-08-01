import { type JsonValue, query } from 'jsonpath-rfc9535';
import type { JSONPathArrayHandling } from '../sync-mapping';

/**
 * Result of a pure JSONPath evaluation. `ok:false` carries a reason but no
 * fallback policy — callers decide what to do (the sync transformer maps it to
 * a `useOriginal:false` failure; the display applier falls back to raw).
 */
export type JsonPathEvalResult = { ok: true; value: unknown } | { ok: false; reason: string };

/**
 * Evaluate an RFC 9535 JSONPath expression against an already-parsed value and
 * reduce the matched nodes per `arrayHandling`.
 *
 * PURE: no I/O, no string-source parsing, no null/undefined policy, no fallback
 * decision. This is the single piece shared between the server sync transformer
 * (which wraps it in its own null-check / string-JSON-parse / `useOriginal`
 * adapter) and the desktop display applier (which fetches raw matches via the
 * `'array'` mode and applies its own fail-closed validation). Keeping only this
 * shared avoids leaking sync-pipeline semantics into the display path.
 */
export function applyJsonPath(
  value: unknown,
  expression: string,
  arrayHandling: JSONPathArrayHandling = 'first',
): JsonPathEvalResult {
  // RFC 9535 requires a leading '$'.
  const expr = expression.startsWith('$') ? expression : `$.${expression}`;

  let results: JsonValue[];
  try {
    results = query(value as JsonValue, expr);
  } catch (err) {
    return { ok: false, reason: `Invalid JSONPath expression: ${err instanceof Error ? err.message : String(err)}` };
  }

  switch (arrayHandling) {
    case 'array':
      return { ok: true, value: results };
    case 'join_space':
    case 'join_matches_space':
    case 'join_comma':
    case 'concat': {
      if (results.some((r) => typeof r === 'object' && r !== null)) {
        return { ok: false, reason: 'JSONPath results contain objects that cannot be joined into a string' };
      }
      const delimiter =
        arrayHandling === 'join_space' || arrayHandling === 'join_matches_space'
          ? ' '
          : arrayHandling === 'join_comma'
            ? ', '
            : '';
      return { ok: true, value: results.map(String).join(delimiter) };
    }
    case 'first':
    default:
      return { ok: true, value: results[0] };
  }
}
