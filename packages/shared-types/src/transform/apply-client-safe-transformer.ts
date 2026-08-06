import type {
  ClientSafeTransformer,
  JSONPathOptions,
  MapArrayOptions,
  SerialDateOptions,
  TransformerConfig,
  ValueMapOptions,
  WrapObjectOptions,
} from '../sync-mapping';
import { applyJsonPath } from './apply-jsonpath';
import { isoStringToSerialDateNumber, serialDateNumberToIsoString } from './serial-date';

/**
 * Result of packing a value with a client-safe transformer. FAIL-CLOSED: any
 * shape the applier can't cleanly handle — a malformed config, a server-only arm
 * that slipped into a nested `map_array` element, a runtime throw — returns
 * `{ ok: false }` so the caller can refuse the write rather than persist garbage.
 */
export type ClientSafeTransformResult = { ok: true; value: unknown } | { ok: false };

/**
 * Execute a {@link ClientSafeTransformer} on the CLIENT (web / desktop / CLI) —
 * the pack half of a View column's `codec` (`CoreValue → native`) run at cell-edit
 * time, so an edited value round-trips back into the connector's native shape.
 *
 * This is the client-shippable sibling of the server's `applyTransformerPipeline`
 * (`server/src/sync/transformers/`). The server applier can't ship to a frontend:
 * it drags in `BaseJsonTableSpec`, `LookupTools`, the DB, and a registry filled by
 * side-effect imports. So this file re-implements ONLY the pure, `value → value`
 * arms a `codec` actually uses today — `jsonpath`, `wrap_object`, `map_array` — as
 * standalone functions with no registry and no server context. The server-only
 * FK/asset/lookup arms are absent from {@link ClientSafeTransformer} by
 * construction, and any that sneak into a nested `map_array` element (typed as the
 * full `TransformerConfig`) fall through to the fail-closed default. Add a new arm
 * here only for a PURE transformer, keeping it byte-for-byte in step with the
 * matching server implementation so the grid edit and a sync agree.
 */
export function applyClientSafeTransformer(config: ClientSafeTransformer, value: unknown): ClientSafeTransformResult {
  return applyAnyTransformer(config, value);
}

/**
 * Internal dispatcher over the FULL {@link TransformerConfig} union, so
 * `map_array` can recurse into its nested `elementTransformer` (typed as the full
 * union, not the client-safe subset) and still fail closed on a server-only arm.
 * Wrapped so any throw fails closed.
 */
function applyAnyTransformer(config: TransformerConfig, value: unknown): ClientSafeTransformResult {
  try {
    switch (config.type) {
      case 'jsonpath':
        return applyJsonPathArm(config.options, value);
      case 'wrap_object':
        return { ok: true, value: applyWrapObject(config.options, value) };
      case 'map_array':
        return applyMapArray(config.options, value);
      case 'value_map':
        return { ok: true, value: applyValueMap(config.options, value) };
      case 'serial_date_to_iso':
        return applySerialDateToIso(config.options, value);
      case 'iso_to_serial_date':
        return applyIsoToSerialDate(value);
      default:
        // Server-only arms (FK / asset / lookup) and any arm not (yet) ported to
        // the client fall through here — the caller refuses the write.
        return { ok: false };
    }
  } catch {
    return { ok: false };
  }
}

/** `jsonpath` — extract via the client-safe RFC 9535 evaluator (mirrors the server arm). */
function applyJsonPathArm(options: JSONPathOptions, value: unknown): ClientSafeTransformResult {
  const arrayHandling = options.arrayHandling ?? 'first';
  const result = applyJsonPath(value, options.expression, arrayHandling);
  return result.ok ? { ok: true, value: result.value } : { ok: false };
}

/**
 * `wrap_object` — substitute `"$value"` in the template with the source value.
 * Faithful port of `server/src/sync/transformers/implementations/wrap-object.transformer.ts`
 * (its `applyTemplate`), including the empty-source → `emptyTemplate ?? null` rule.
 */
function applyWrapObject(options: WrapObjectOptions, value: unknown): unknown {
  const { template, emptyTemplate } = options;
  if (value === null || value === undefined || value === '') {
    return emptyTemplate ? applyTemplate(emptyTemplate, null) : null;
  }
  if (!template || typeof template !== 'object') {
    throw new Error('wrap_object requires a "template" option (object)');
  }
  return applyTemplate(template, value);
}

/** Replace every `"$value"` in the template — at any depth — with the source value. */
function applyTemplate(template: unknown, value: unknown): unknown {
  if (template === '$value') return value;
  if (Array.isArray(template)) return template.map((entry) => applyTemplate(entry, value));
  if (template !== null && typeof template === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, templateValue] of Object.entries(template as Record<string, unknown>)) {
      result[key] = applyTemplate(templateValue, value);
    }
    return result;
  }
  return template;
}

/**
 * `value_map` — replace a scalar with its dictionary entry, keyed by the value's string form.
 * Faithful port of `server/src/sync/transformers/implementations/value-map.transformer.ts`:
 * empty (null/undefined/"") maps to `null`; an unmapped scalar passes through as its string form
 * (or maps to `null` under `onUnmapped: 'null'`); a non-scalar throws (fail-closed above) — wrap
 * in `map_array` to map an array's elements.
 */
function applyValueMap(options: ValueMapOptions, value: unknown): unknown {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
    throw new Error('value_map requires a scalar source value; wrap it in map_array for arrays');
  }
  const mappingKey = String(value);
  const mappedValue = options.mapping[mappingKey];
  if (mappedValue !== undefined) return mappedValue;
  return options.onUnmapped === 'null' ? null : mappingKey;
}

/**
 * `serial_date_to_iso` — spreadsheet serial number → ISO wall-clock string. Faithful port of
 * `server/src/sync/transformers/implementations/serial-date-to-iso.transformer.ts`: empty
 * (null/undefined/'') maps to `null`; a numeric string is accepted; an unconvertible value
 * fails closed.
 */
function applySerialDateToIso(options: SerialDateOptions | undefined, value: unknown): ClientSafeTransformResult {
  // Whitespace-only counts as empty — Number('  ') is 0, which would otherwise
  // silently become the 1899-12-30 epoch.
  if (value === null || value === undefined || (typeof value === 'string' && value.trim() === '')) {
    return { ok: true, value: null };
  }
  const serialValue = typeof value === 'string' ? Number(value) : value;
  if (typeof serialValue !== 'number' || !Number.isFinite(serialValue)) return { ok: false };
  const isoString = serialDateNumberToIsoString(serialValue, options?.isoShape ?? 'auto');
  return isoString === null ? { ok: false } : { ok: true, value: isoString };
}

/**
 * `iso_to_serial_date` — ISO date / date-time string → spreadsheet serial number. Faithful
 * port of `server/src/sync/transformers/implementations/iso-to-serial-date.transformer.ts`:
 * empty maps to `null`; an already-numeric value (a serial) passes through; an unparseable
 * string fails closed.
 */
function applyIsoToSerialDate(value: unknown): ClientSafeTransformResult {
  if (value === null || value === undefined || (typeof value === 'string' && value.trim() === '')) {
    return { ok: true, value: null };
  }
  if (typeof value === 'number' && Number.isFinite(value)) return { ok: true, value };
  if (typeof value !== 'string') return { ok: false };
  const serialValue = isoStringToSerialDateNumber(value);
  return serialValue === null ? { ok: false } : { ok: true, value: serialValue };
}

/**
 * `map_array` — apply `elementTransformer` to each element, producing a new array.
 * Port of `server/src/sync/transformers/implementations/map-array.transformer.ts`,
 * dispatching through {@link applyAnyTransformer} instead of the server registry
 * (so a nested server-only element transformer fails the whole array closed).
 */
function applyMapArray(options: MapArrayOptions, value: unknown): ClientSafeTransformResult {
  if (value === null || value === undefined) return { ok: true, value: null };
  if (!Array.isArray(value)) return { ok: false };

  const elementTransformer = options.elementTransformer;
  if (!elementTransformer || !elementTransformer.type) return { ok: false };

  const results: unknown[] = [];
  for (const element of value) {
    const elementResult = applyAnyTransformer(elementTransformer, element);
    if (!elementResult.ok) return { ok: false };
    results.push(elementResult.value);
  }
  return { ok: true, value: results };
}
