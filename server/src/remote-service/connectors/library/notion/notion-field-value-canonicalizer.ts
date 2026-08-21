import { X_SCRATCH_CONNECTOR_DATA_TYPE } from '@spinner/shared-types';
import type {
  FieldValueCanonicalizer,
  FieldValueCanonicalizerContext,
} from 'src/remote-service/connectors/field-value-canonicalization';
import {
  composeCanonicalizers,
  emptyAsNull,
  isoInstantTruncatedTo,
  numberRoundedToSignificantDigits,
  pickedAndCanonicalized,
  unpackedWithClientSafeTransformer,
} from 'src/remote-service/connectors/field-value-canonicalizers';

/**
 * Notion's field-value canonicalizers (DEV-10556).
 *
 * A Notion property is stored verbatim as its pull envelope `{ id, type, <type>: value }`,
 * and Notion decorates what it reads back well beyond what a write sends: every
 * rich-text span gains `annotations`, `href`, `plain_text` and `text.link`; a
 * `select`/`status`/`multi_select` option gains `id` and `color`; a `date` gains
 * `end`/`time_zone` and is re-rendered (`Z` → `+00:00`, seconds dropped); a
 * `relation` gains `has_more`. The sync's pack (see `notionInboundPackTransformer`)
 * writes only the minimal write shape, so structurally the two never match and every
 * record re-published on every run.
 *
 * Each canonicalizer here reduces a property envelope to the plain value Notion
 * itself treats as the property's content — the same plain value the declared
 * outbound unpack (`x-scratch-suggested-transformer`) and record matching use — so
 * the minimal write shape and the decorated read shape compare EQUAL while a real
 * content change still compares different.
 *
 * Deliberately lossy, and documented as such: a rich-text canonical form is its
 * concatenated plain text, so a raw-JSON edit that only changes bold/italic/link
 * formatting is treated as "no change". Read-only property types (formula, rollup,
 * created_time/last_edited_*, people, unique_id, …) and `files` (expiring URLs)
 * declare nothing and keep the structural compare.
 */

/**
 * Precision Notion stores for a date-time `date` property. Notion's API renders
 * `date.start`/`date.end` with millisecond precision (`2026-07-23T21:12:27.000+00:00`),
 * but the UI and the stored value are minute-granular; DEV-10556's audits saw
 * seconds dropped on read-back. Compared at minute precision so a source
 * timestamp with seconds and Notion's minute-truncated echo agree.
 */
export const NOTION_DATE_TIME_COMPARE_PRECISION = 'minute' as const;

/** Reads the typed payload of a Notion property envelope: `{ type: 'select', select: X }` → `X`. */
function notionPropertyPayload(notionType: string): FieldValueCanonicalizer {
  return (value) => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return value;
    return (value as Record<string, unknown>)[notionType];
  };
}

/** `[{ id, name, color }]` (multi_select) / `[{ id }]` (relation) → `[name…]` / `[id…]`, order kept. */
function arrayOfKey(key: string): FieldValueCanonicalizer {
  return (value) =>
    Array.isArray(value) ? value.map((item) => (item as Record<string, unknown> | null)?.[key]) : value;
}

/** `{ id, name, color } | null` (select/status option) → `name | null`. */
const optionName: FieldValueCanonicalizer = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>).name
    : value;

/**
 * Concatenated plain text of a rich-text / title span array — the SAME reduction as
 * the declared outbound unpack (`$.<type>[*].plain_text`, `concat`) so diffing and
 * record matching agree on what a Notion text property "is".
 */
function richTextPlainText(notionType: 'title' | 'rich_text'): FieldValueCanonicalizer {
  return composeCanonicalizers(
    unpackedWithClientSafeTransformer({
      type: 'jsonpath',
      options: { expression: `$.${notionType}[*].plain_text`, arrayHandling: 'concat' },
    }),
    emptyAsNull(),
  );
}

const notionDateInstant = composeCanonicalizers(
  isoInstantTruncatedTo(NOTION_DATE_TIME_COMPARE_PRECISION),
  emptyAsNull(),
);

/**
 * The canonicalizer for a Notion property of `notionType`, or `undefined` for a
 * type that should compare structurally. Exposed for tests; the registry hook
 * below resolves the type from the field's schema node.
 */
export function notionFieldValueCanonicalizerForPropertyType(notionType: string): FieldValueCanonicalizer | undefined {
  switch (notionType) {
    case 'title':
    case 'rich_text':
      return richTextPlainText(notionType);
    case 'select':
    case 'status':
      return composeCanonicalizers(notionPropertyPayload(notionType), optionName, emptyAsNull());
    case 'multi_select':
      return composeCanonicalizers(notionPropertyPayload(notionType), arrayOfKey('name'));
    case 'relation':
      return composeCanonicalizers(notionPropertyPayload(notionType), arrayOfKey('id'));
    case 'number':
      return composeCanonicalizers(
        notionPropertyPayload(notionType),
        numberRoundedToSignificantDigits(15),
        emptyAsNull(),
      );
    case 'checkbox':
      return notionPropertyPayload(notionType);
    case 'url':
    case 'email':
    case 'phone_number':
      return composeCanonicalizers(notionPropertyPayload(notionType), emptyAsNull());
    case 'date':
      return composeCanonicalizers(
        notionPropertyPayload(notionType),
        pickedAndCanonicalized({ start: notionDateInstant, end: notionDateInstant, time_zone: emptyAsNull() }),
        // A cleared date (`date: null`) and an absent date agree.
        emptyAsNull(),
      );
    default:
      // people, files, formula, rollup, created_time, last_edited_time, created_by,
      // last_edited_by, unique_id, verification, button, … — structural compare.
      return undefined;
  }
}

/**
 * Registry hook (`resolveFieldValueCanonicalizer`): a canonicalizer for each
 * Notion property the pull schema annotates with its Notion type
 * (`x-scratch-connector-data-type`, set in `notion-json-schema.ts`). Page-level
 * envelope fields (`id`, `created_time`, `properties`, …) carry no such annotation
 * and compare structurally.
 */
export function resolveNotionFieldValueCanonicalizer(
  context: FieldValueCanonicalizerContext,
): FieldValueCanonicalizer | undefined {
  const notionType = context.fieldSchema?.[X_SCRATCH_CONNECTOR_DATA_TYPE] as unknown;
  if (typeof notionType !== 'string') return undefined;
  return notionFieldValueCanonicalizerForPropertyType(notionType);
}
