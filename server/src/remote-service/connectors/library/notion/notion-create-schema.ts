/**
 * Pure mapping for the create-schema API (DEV-10382) — Notion side.
 *
 * Maps the connector-agnostic logical field types (`CreateFieldType`) to native
 * Notion data-source *property configurations* and builds the `properties` map
 * sent to `POST /v1/databases` (`initial_data_source.properties`) and
 * `PATCH /v1/data_sources/{id}` (`properties`). Nothing here touches the network
 * — the connector resolves foreign-key targets and issues the API calls — so the
 * generated property configs are fully assertable without a Notion workspace.
 *
 * Mirrors the Postgres create-schema builder (`pg-create-schema.ts`): map each
 * logical kind to a native type, and surface a per-field skip reason rather than
 * silently dropping a property.
 */
import { type CreateDatabaseParameters } from '@notionhq/client';
import { CREATE_FIELD_KINDS, type SchemaCreationCapabilities } from '@spinner/shared-types';
import { assertUnreachable } from 'src/utils/asserts';
import { type ResolvedCreateFieldSpec } from '../../schema-creation.types';

/**
 * The Notion property-configuration request shape, derived from the SDK's
 * exported `CreateDatabaseParameters` (the `PropertyConfigurationRequest` alias
 * itself is not re-exported by `@notionhq/client`). One of these per property,
 * e.g. `{ rich_text: {} }`, `{ number: { format } }`, `{ select: { options } }`.
 */
export type NotionPropertyConfig = NonNullable<
  NonNullable<CreateDatabaseParameters['initial_data_source']>['properties']
>[string];

/** The `properties` map for create-database / update-data-source, keyed by property name. */
export type NotionPropertiesMap = Record<string, NotionPropertyConfig>;

/**
 * Connector-declared capabilities consumed by the generic create-schema
 * validator. Notion can represent every logical kind as a property, and every
 * data source MUST have exactly one `title` property — so `primaryField` is set
 * and the primary field (mapped to Notion's `title`) must be text-like.
 */
export const NOTION_SCHEMA_CREATION_CAPABILITIES: SchemaCreationCapabilities = {
  supportedFieldKinds: [...CREATE_FIELD_KINDS],
  primaryField: {
    displayName: 'Title',
    description: 'Notion requires a title property. It names each record and appears at the top of every page.',
    kinds: ['text', 'longText'],
  },
  // Notion relation properties hold a list of linked records, so it can represent a two-way N→N link.
  supportsManyToManyForeignKeys: true,
};

/**
 * The server resolves every foreignKey `target` to a concrete existing table
 * before dispatch, but the referenced Notion *data source id* only the connector
 * knows (a folder's remoteId is `[databaseId, dataSourceId]`; older folders carry
 * just `[databaseId]` and need a lookup). The connector computes one of these per
 * foreignKey field and hands it to the pure mapper.
 */
export type NotionForeignKeyResolution =
  | { kind: 'resolved'; targetDataSourceId: string }
  | { kind: 'unresolvable'; reason: string };

/** foreignKey resolutions keyed by `CreateFieldSpec.name`. */
export type NotionForeignKeyResolutions = Map<string, NotionForeignKeyResolution>;

/** Notion's fixed palette of select / multi-select option colors. */
const NOTION_SELECT_COLORS = [
  'default',
  'gray',
  'brown',
  'orange',
  'yellow',
  'green',
  'blue',
  'purple',
  'pink',
  'red',
] as const;
type NotionSelectColor = (typeof NOTION_SELECT_COLORS)[number];

/**
 * Map an optional Scratch color hint to a Notion select color. Scratch colors are
 * free-form UI hints, so anything Notion doesn't recognize is dropped (Notion
 * then assigns its own color) rather than failing the whole property.
 */
export function normalizeSelectColor(color: string | undefined): NotionSelectColor | undefined {
  if (color === undefined) return undefined;
  const lower = color.trim().toLowerCase();
  return (NOTION_SELECT_COLORS as readonly string[]).includes(lower) ? (lower as NotionSelectColor) : undefined;
}

/**
 * ISO-4217 currency code → Notion number format. Notion models currency as a
 * number with a per-currency display format; a code Notion has no format for
 * falls back to a plain number (the value still round-trips; only the symbol is
 * lost). Matches how Postgres treats `currencyCode` as display metadata only.
 */
const CURRENCY_CODE_TO_NOTION_NUMBER_FORMAT: Record<string, string> = {
  USD: 'dollar',
  AUD: 'dollar',
  CAD: 'canadian_dollar',
  SGD: 'singapore_dollar',
  EUR: 'euro',
  GBP: 'pound',
  JPY: 'yen',
  CNY: 'yuan',
  RUB: 'ruble',
  INR: 'rupee',
  KRW: 'won',
  BRL: 'real',
  TRY: 'lira',
  IDR: 'rupiah',
  CHF: 'franc',
  HKD: 'hong_kong_dollar',
  NZD: 'new_zealand_dollar',
  SEK: 'krona',
  NOK: 'norwegian_krone',
  MXN: 'mexican_peso',
  ZAR: 'rand',
  TWD: 'new_taiwan_dollar',
  DKK: 'danish_krone',
  PLN: 'zloty',
  THB: 'baht',
  HUF: 'forint',
  CZK: 'koruna',
  ILS: 'shekel',
  CLP: 'chilean_peso',
  PHP: 'philippine_peso',
  AED: 'dirham',
  COP: 'colombian_peso',
  SAR: 'riyal',
  MYR: 'ringgit',
  RON: 'leu',
  ARS: 'argentine_peso',
  UYU: 'uruguayan_peso',
  PEN: 'peruvian_sol',
};

export function currencyCodeToNotionNumberFormat(currencyCode: string): string {
  return CURRENCY_CODE_TO_NOTION_NUMBER_FORMAT[currencyCode.toUpperCase()] ?? 'number';
}

/** Attach an optional `description` to a property config (Notion accepts it as a sibling key). */
function withDescription(config: NotionPropertyConfig, field: ResolvedCreateFieldSpec): NotionPropertyConfig {
  return field.description ? { ...config, description: field.description } : config;
}

/** Build Notion select/multi-select options, normalizing (or dropping) each color hint. */
function buildSelectOptions(
  options: { name: string; color?: string }[],
): { name: string; color?: NotionSelectColor }[] {
  return options.map((option) => {
    const color = normalizeSelectColor(option.color);
    return color !== undefined ? { name: option.name, color } : { name: option.name };
  });
}

/** Map a single foreignKey field to a Notion one-way relation, or a skip reason. */
function mapForeignKeyToRelation(
  field: ResolvedCreateFieldSpec,
  fkResolutions: NotionForeignKeyResolutions,
): { config: NotionPropertyConfig } | { skipReason: string } {
  const resolution = fkResolutions.get(field.name);
  if (!resolution) {
    return { skipReason: `foreign key "${field.name}" could not be resolved to a target data source` };
  }
  if (resolution.kind === 'unresolvable') {
    return { skipReason: resolution.reason };
  }
  // Notion relations are inherently multi-valued, so `allowMultiple` needs no
  // special handling. `single_property` creates a one-way relation (no reciprocal
  // property is added to the target data source).
  return {
    config: withDescription(
      { relation: { data_source_id: resolution.targetDataSourceId, type: 'single_property', single_property: {} } },
      field,
    ),
  };
}

/**
 * Map one logical field to its Notion property configuration, or return a skip
 * reason when it can't become a property (an unresolvable foreign key). When
 * `isPrimaryTitle` is true the field becomes Notion's mandatory `title` property
 * (create-table only); otherwise it maps by kind.
 */
export function mapCreateFieldToNotionProperty(
  field: ResolvedCreateFieldSpec,
  isPrimaryTitle: boolean,
  fkResolutions: NotionForeignKeyResolutions,
): { config: NotionPropertyConfig } | { skipReason: string } {
  if (isPrimaryTitle) {
    return { config: withDescription({ title: {} }, field) };
  }

  const fieldType = field.fieldType;
  switch (fieldType.kind) {
    case 'text':
    case 'longText':
      return { config: withDescription({ rich_text: {} }, field) };
    case 'number':
      return {
        config: withDescription({ number: { format: fieldType.format === 'percent' ? 'percent' : 'number' } }, field),
      };
    case 'currency':
      return {
        config: withDescription(
          { number: { format: currencyCodeToNotionNumberFormat(fieldType.currencyCode) } },
          field,
        ),
      };
    case 'boolean':
      return { config: withDescription({ checkbox: {} }, field) };
    case 'date':
      // Notion has no schema-level "includes time" toggle — time is per-value.
      return { config: withDescription({ date: {} }, field) };
    case 'select':
      return { config: withDescription({ select: { options: buildSelectOptions(fieldType.options) } }, field) };
    case 'multiSelect':
      return { config: withDescription({ multi_select: { options: buildSelectOptions(fieldType.options) } }, field) };
    case 'url':
      return { config: withDescription({ url: {} }, field) };
    case 'email':
      return { config: withDescription({ email: {} }, field) };
    case 'phone':
      return { config: withDescription({ phone_number: {} }, field) };
    case 'foreignKey':
      return mapForeignKeyToRelation(field, fkResolutions);
    default:
      return assertUnreachable(fieldType);
  }
}

/** Options controlling how a field set maps to a Notion properties record. */
export interface BuildNotionPropertiesOptions {
  /**
   * When true, the field marked `isPrimary` becomes the Notion `title` property
   * (create-table only). When false (adding fields to an existing data source,
   * which already has its one title), `isPrimary` is ignored and the field maps
   * by kind.
   */
  treatPrimaryAsTitle: boolean;
}

/**
 * Build the Notion `properties` record for a set of fields. Fields that can't
 * become a property (an unresolvable foreign key) populate `skippedFieldReasons`
 * (keyed by field name) instead of failing the whole request — same skip
 * semantics as the Postgres builder.
 */
export function buildNotionPropertiesForFields(
  fields: ResolvedCreateFieldSpec[],
  options: BuildNotionPropertiesOptions,
  fkResolutions: NotionForeignKeyResolutions,
  skippedFieldReasons?: Map<string, string>,
): NotionPropertiesMap {
  const properties: NotionPropertiesMap = {};
  for (const field of fields) {
    const isPrimaryTitle = options.treatPrimaryAsTitle && field.isPrimary === true;
    const result = mapCreateFieldToNotionProperty(field, isPrimaryTitle, fkResolutions);
    if ('skipReason' in result) {
      skippedFieldReasons?.set(field.name, result.skipReason);
      continue;
    }
    properties[field.name] = result.config;
  }
  return properties;
}
