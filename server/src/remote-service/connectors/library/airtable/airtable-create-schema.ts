/**
 * Pure field-mapping for the create-schema API (DEV-10379).
 *
 * Maps the connector-agnostic logical field types (`CreateFieldType`) to native
 * Airtable create-field requests. Nothing here makes an HTTP call — the connector
 * (`airtable-connector.ts`) supplies the target `baseId` as context and sends the
 * built requests. Keeping the mapping pure means the full logical-kind → Airtable
 * translation is assertable without touching the live API.
 *
 * Unlike the Postgres reference (`pg-create-schema.ts`), Airtable needs no live
 * introspection to build a foreign key: a record link only needs the linked
 * table's id (the second element of the resolved `[baseId, tableId]` remote id)
 * and a same-base check — both computable here. Fields that can't be created are
 * surfaced as a per-field `{ skip }` reason rather than being silently dropped.
 */
import {
  CREATE_FIELD_KINDS,
  type CreateFieldKind,
  type CreateFieldType,
  type SchemaCreationCapabilities,
} from '@spinner/shared-types';
import { assertUnreachable } from 'src/utils/asserts';
import { type ResolvedCreateFieldSpec } from '../../schema-creation.types';
import {
  airtableFirstColumnIncompatibleTypes,
  type AirtableApiCreateField,
  type AirtableApiCreateFieldCommon,
  type AirtableApiCreateFieldTypeAndOptions,
  type AirtableNumberPrecisios,
} from './airtable-types';

/** Airtable's table- and field-name length limit. */
export const AIRTABLE_MAX_NAME_LENGTH = 255;

/** Airtable number/currency `precision` is constrained to 0–8. */
export const AIRTABLE_MAX_NUMBER_PRECISION = 8;

/** Default decimal places when a `number` (plain/decimal) field omits a precision. */
export const DEFAULT_NUMBER_PRECISION = 2;

/** Default decimal places for a `currency` field when the caller omits a precision. */
export const DEFAULT_CURRENCY_PRECISION = 2;

/**
 * Representative native Airtable field type for each logical kind. Used both to
 * compute `primaryFieldKinds` (a kind is primary-eligible iff its native type is
 * not in `airtableFirstColumnIncompatibleTypes`) and to validate a designated
 * primary field's type in the connector — so the two can never drift.
 */
export function mapKindToNativeType(kind: CreateFieldKind): AirtableApiCreateFieldTypeAndOptions['type'] {
  switch (kind) {
    case 'text':
      return 'singleLineText';
    case 'longText':
      return 'multilineText';
    case 'number':
      return 'number';
    case 'boolean':
      return 'checkbox';
    case 'date':
      return 'date';
    case 'select':
      return 'singleSelect';
    case 'multiSelect':
      return 'multipleSelects';
    case 'url':
      return 'url';
    case 'email':
      return 'email';
    case 'phone':
      return 'phoneNumber';
    case 'currency':
      return 'currency';
    case 'foreignKey':
      return 'multipleRecordLinks';
    default:
      return assertUnreachable(kind);
  }
}

/** Whether a logical kind may be a table's primary field (Airtable's `fields[0]`). */
export function isAirtablePrimaryEligibleKind(kind: CreateFieldKind): boolean {
  return !airtableFirstColumnIncompatibleTypes.includes(mapKindToNativeType(kind));
}

/**
 * Connector-declared capabilities consumed by the generic create-schema
 * validator. Airtable can represent every logical kind, but (unlike Postgres) it
 * mandates a primary field as `fields[0]`, and that field's type cannot be one of
 * `airtableFirstColumnIncompatibleTypes` — so `requiresPrimaryField` is true and
 * `primaryFieldKinds` is the set of primary-eligible kinds.
 */
export const AIRTABLE_SCHEMA_CREATION_CAPABILITIES: SchemaCreationCapabilities = {
  supportedFieldKinds: [...CREATE_FIELD_KINDS],
  requiresPrimaryField: true,
  primaryFieldKinds: CREATE_FIELD_KINDS.filter(isAirtablePrimaryEligibleKind),
  maxTableNameLength: AIRTABLE_MAX_NAME_LENGTH,
  maxFieldNameLength: AIRTABLE_MAX_NAME_LENGTH,
};

/**
 * ISO-4217 alphabetic code → display symbol for Airtable's currency `symbol`
 * option. Airtable accepts an arbitrary string, so an unknown code falls back to
 * the code itself (always valid) rather than failing the field.
 */
const CURRENCY_SYMBOLS: Record<string, string> = {
  USD: '$',
  CAD: '$',
  AUD: '$',
  NZD: '$',
  MXN: '$',
  SGD: '$',
  HKD: '$',
  EUR: '€',
  GBP: '£',
  JPY: '¥',
  CNY: '¥',
  INR: '₹',
  BRL: 'R$',
  CHF: 'CHF',
  SEK: 'kr',
  NOK: 'kr',
  DKK: 'kr',
  ZAR: 'R',
  RUB: '₽',
  KRW: '₩',
};

/** Airtable currency `symbol` for an ISO-4217 code, falling back to the code itself. */
export function currencySymbolFor(currencyCode: string): string {
  return CURRENCY_SYMBOLS[currencyCode] ?? currencyCode;
}

/** Clamp a requested precision into Airtable's allowed 0–8 range. */
export function clampPrecision(precision: number): AirtableNumberPrecisios {
  const clamped = Math.min(AIRTABLE_MAX_NUMBER_PRECISION, Math.max(0, Math.round(precision)));
  // Safe: `clamped` is an integer in [0, 8], exactly the AirtableNumberPrecisios union.
  return clamped as AirtableNumberPrecisios;
}

/** Result of mapping one logical field: a ready-to-send Airtable field, or a skip reason. */
export type BuiltAirtableField = { field: AirtableApiCreateField } | { skip: string };

/**
 * Map one logical field spec to an Airtable create-field request, or return a
 * per-field `{ skip }` reason (a cross-base foreign key, or — defensively — a
 * foreign key whose target the server failed to resolve). `ctx.baseId` is the
 * base the table is being created in; record links must stay within it.
 */
export function buildAirtableCreateField(spec: ResolvedCreateFieldSpec, ctx: { baseId: string }): BuiltAirtableField {
  const common: AirtableApiCreateFieldCommon =
    spec.description !== undefined ? { name: spec.name, description: spec.description } : { name: spec.name };

  const fieldType = spec.fieldType;
  switch (fieldType.kind) {
    case 'text':
      return { field: { ...common, type: 'singleLineText' } };
    case 'longText':
      // Plain multiline text, not richText — richText would route pulled values
      // through the AirMark↔HTML converters, changing the stored shape.
      return { field: { ...common, type: 'multilineText' } };
    case 'url':
      return { field: { ...common, type: 'url' } };
    case 'email':
      return { field: { ...common, type: 'email' } };
    case 'phone':
      return { field: { ...common, type: 'phoneNumber' } };
    case 'boolean':
      return { field: { ...common, type: 'checkbox', options: { color: 'greenBright', icon: 'check' } } };
    case 'number':
      return { field: { ...common, ...buildNumberTypeAndOptions(fieldType) } };
    case 'currency':
      return {
        field: {
          ...common,
          type: 'currency',
          options: {
            precision: clampPrecision(fieldType.precision ?? DEFAULT_CURRENCY_PRECISION),
            symbol: currencySymbolFor(fieldType.currencyCode),
          },
        },
      };
    case 'date':
      return fieldType.includesTime
        ? {
            field: {
              ...common,
              type: 'dateTime',
              options: {
                timeZone: 'utc',
                dateFormat: { name: 'local' },
                timeFormat: { format: 'HH:mm', name: '24hour' },
              },
            },
          }
        : { field: { ...common, type: 'date', options: { dateFormat: { name: 'local' } } } };
    case 'select':
      return {
        field: {
          ...common,
          type: 'singleSelect',
          options: { choices: fieldType.options.map((o) => ({ name: o.name })) },
        },
      };
    case 'multiSelect':
      return {
        field: {
          ...common,
          type: 'multipleSelects',
          options: { choices: fieldType.options.map((o) => ({ name: o.name })) },
        },
      };
    case 'foreignKey':
      return buildForeignKeyField(common, fieldType, ctx);
    default:
      return assertUnreachable(fieldType);
  }
}

/** Map a logical `number` field to an Airtable number/percent type + precision options. */
function buildNumberTypeAndOptions(
  fieldType: Extract<CreateFieldType, { kind: 'number' }>,
):
  | { type: 'number'; options: { precision: AirtableNumberPrecisios } }
  | { type: 'percent'; options: { precision: AirtableNumberPrecisios } } {
  const format = fieldType.format ?? 'plain';
  if (format === 'percent') {
    return { type: 'percent', options: { precision: clampPrecision(fieldType.precision ?? DEFAULT_NUMBER_PRECISION) } };
  }
  const precision = format === 'integer' ? 0 : clampPrecision(fieldType.precision ?? DEFAULT_NUMBER_PRECISION);
  return { type: 'number', options: { precision } };
}

/**
 * Map a logical `foreignKey` to an Airtable record-link field, or skip it.
 * Airtable links are intra-base only and inherently multi-valued, so a cross-base
 * target is skipped and `allowMultiple` is a no-op (the single-link preference is
 * a UI-only hint). The `{ ref }` form is resolved server-side before dispatch, so
 * an unresolved target here is a server bug we surface rather than crash on.
 */
function buildForeignKeyField(
  common: AirtableApiCreateFieldCommon,
  fieldType: Extract<CreateFieldType, { kind: 'foreignKey' }>,
  ctx: { baseId: string },
): BuiltAirtableField {
  const target = fieldType.target;
  if (!('existingRemoteTableId' in target)) {
    return { skip: `foreign key "${common.name}" target was not resolved to an existing table` };
  }
  const [targetBaseId, targetTableId] = target.existingRemoteTableId;
  if (!targetTableId) {
    return { skip: `foreign key "${common.name}" target is missing an Airtable table id` };
  }
  if (targetBaseId !== ctx.baseId) {
    return {
      skip: `foreign key "${common.name}" links to a table in a different base ("${targetBaseId}"); Airtable record links must stay within the same base`,
    };
  }
  return { field: { ...common, type: 'multipleRecordLinks', options: { linkedTableId: targetTableId } } };
}
