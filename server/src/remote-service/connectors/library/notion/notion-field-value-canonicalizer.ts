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
 * formatting is treated as "no change"; a `people` value is its user ids (Notion
 * decorates each user with `name`/`avatar_url`/`person`/`bot` on read); a `files`
 * value is each file's stable identity — an external file's URL, a Notion-hosted
 * file's name — never the hosted file's signed `file.url`, which rotates on every
 * read. Read-only property types (formula, rollup, created_time/last_edited_*,
 * unique_id, …) declare nothing and keep the structural compare — they are never
 * written, so their envelope decorations (the property-level `id`) never diff.
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

/**
 * A Notion checkbox is never empty on read — an unset checkbox comes back as
 * `{ checkbox: false }` — so a `null`/absent value (a cleared destination, or a
 * source with no boolean to give) means "unchecked". Treat it as `false` so a
 * write of "no value" and the `false` Notion reads back compare EQUAL instead
 * of re-publishing every run.
 */
function absentAsFalse(): FieldValueCanonicalizer {
  return (value) => (value === null || value === undefined ? false : value);
}

/** `[{ id, name, color }]` (multi_select) / `[{ id }]` (relation) → `[name…]` / `[id…]`, order kept. */
function arrayOfKey(key: string): FieldValueCanonicalizer {
  return (value) =>
    Array.isArray(value) ? value.map((item) => (item as Record<string, unknown> | null)?.[key]) : value;
}

/**
 * `[{ name, type: 'external', external: { url } } | { name, type: 'file', file: { url, expiry_time } }]`
 * (files) → one stable identity per file, order kept: an external file's URL (the sync's
 * pack names an external file after its URL, and Notion echoes that name back), a
 * Notion-hosted file's `name` — its `file.url` is a signed URL that rotates on every
 * read and `expiry_time` with it, so neither can take part in the compare.
 */
const fileIdentities: FieldValueCanonicalizer = (value) =>
  Array.isArray(value)
    ? (value as unknown[]).map((item: unknown) => {
        if (item === null || typeof item !== 'object') return item;
        const file = item as { name?: unknown; external?: { url?: unknown } | null };
        const externalUrl = file.external?.url;
        return typeof externalUrl === 'string' ? externalUrl : file.name;
      })
    : value;

/** `{ id, name, color } | null` (select/status option) → `name | null`. */
const optionName: FieldValueCanonicalizer = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>).name
    : value;

/**
 * Characters Notion silently DROPS from text on write, so a value carrying them
 * never reads back byte-equal: U+200B ZERO WIDTH SPACE and U+FEFF BOM. Verified
 * against a live Attio → Notion export whose seeded `zero\u200bwidth` description
 * came back as `zerowidth` and re-published on every run. Deliberately NOT the
 * whole zero-width family: U+200D ZERO WIDTH JOINER is load-bearing inside emoji
 * sequences (👨‍👩‍👧), so stripping it would hide a real content change; extend this
 * only with characters Notion is observed to drop.
 */
const CHARACTERS_NOTION_DROPS_ON_WRITE = /[\u200B\uFEFF]/g;

/** Strips {@link CHARACTERS_NOTION_DROPS_ON_WRITE} from a string; anything else passes through. */
const withoutCharactersNotionDropsOnWrite: FieldValueCanonicalizer = (value) =>
  typeof value === 'string' ? value.replace(CHARACTERS_NOTION_DROPS_ON_WRITE, '') : value;

/**
 * Concatenated plain text of a rich-text / title span array — the SAME reduction as
 * the declared outbound unpack (`$.<type>[*].plain_text`, `concat`) so diffing and
 * record matching agree on what a Notion text property "is" — minus the characters
 * Notion drops on write, so the text we would send and the text Notion keeps agree.
 */
function richTextPlainText(notionType: 'title' | 'rich_text'): FieldValueCanonicalizer {
  return composeCanonicalizers(
    unpackedWithClientSafeTransformer({
      type: 'jsonpath',
      options: { expression: `$.${notionType}[*].plain_text`, arrayHandling: 'concat' },
    }),
    withoutCharactersNotionDropsOnWrite,
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
    case 'people':
      // `[{ id }]` (relation) / `[{ object: 'user', id, name, avatar_url, … }]` (people) → `[id…]`.
      return composeCanonicalizers(notionPropertyPayload(notionType), arrayOfKey('id'));
    case 'files':
      return composeCanonicalizers(notionPropertyPayload(notionType), fileIdentities);
    case 'number':
      return composeCanonicalizers(
        notionPropertyPayload(notionType),
        numberRoundedToSignificantDigits(15),
        emptyAsNull(),
      );
    case 'checkbox':
      return composeCanonicalizers(notionPropertyPayload(notionType), absentAsFalse());
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
      // formula, rollup, created_time, last_edited_time, created_by, last_edited_by,
      // unique_id, verification, button, … — read-only, structural compare.
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
