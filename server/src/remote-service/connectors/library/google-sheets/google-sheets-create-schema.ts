/**
 * Pure field-mapping for create-schema (Live Export into Google Sheets).
 *
 * Maps the connector-agnostic logical field kinds to a per-column "plan": the
 * header text plus the column treatment (number format, data validation,
 * header note, FK marker metadata). Nothing here makes an HTTP call — the
 * connector turns plans into one `spreadsheets.batchUpdate`.
 *
 * A sheet column has no real type system, so "creating a field" means creating
 * a HEADER plus column formatting that makes values render right and nudges
 * humans toward valid input (checkbox validation for booleans, dropdown
 * validation for selects, DATE/DATE_TIME formats for dates). Values themselves
 * are whatever the cells hold — the schema layer stays a permissive union.
 */
import { CREATE_FIELD_KINDS, type CreateFieldType, type SchemaCreationCapabilities } from '@spinner/shared-types';
import { assertUnreachable } from 'src/utils/asserts';
import { type ResolvedCreateFieldSpec } from '../../schema-creation.types';
// Pure mapping module (no registration side effects) — shares the ISO-4217 →
// symbol table so the two destinations can't drift on the same plan.
import { currencySymbolFor } from '../airtable/airtable-create-schema';
import {
  GoogleSheetsDataValidationRule,
  GoogleSheetsNumberFormat,
  SCRATCH_ID_COLUMN_HEADER,
} from './google-sheets-types';

/** Google's limit on sheet (tab) names. */
export const GOOGLE_SHEETS_MAX_SHEET_NAME_LENGTH = 100;

/** No hard header-length limit exists; this keeps names sane. */
export const GOOGLE_SHEETS_MAX_FIELD_NAME_LENGTH = 255;

/** Rows a Live-Export-created sheet starts with (Sheets' own default). */
export const GOOGLE_SHEETS_NEW_SHEET_ROW_COUNT = 1000;

export const GOOGLE_SHEETS_SCHEMA_CREATION_CAPABILITIES: SchemaCreationCapabilities = {
  supportedFieldKinds: [...CREATE_FIELD_KINDS],
  // No mandatory primary field — but when a plan designates one, the connector
  // orders it right after the Scratch ID column (column B), the spot both
  // humans and the title-column heuristic treat as "the" identifying column.
  primaryField: null,
  maxTableNameLength: GOOGLE_SHEETS_MAX_SHEET_NAME_LENGTH,
  maxFieldNameLength: GOOGLE_SHEETS_MAX_FIELD_NAME_LENGTH,
  // Column A is always the injected Scratch ID column.
  reservedFieldNames: [SCRATCH_ID_COLUMN_HEADER],
  // A foreign-key cell holds ONE scr_… id (a multi-link would need a lossy
  // comma-joined encoding), so like Postgres this destination represents only
  // the one-side of a relationship — the plan generator narrows N→N pairs.
  supportsManyToManyForeignKeys: false,
  // Sheet titles are unique within a spreadsheet.
  requiresUniqueTableNames: true,
};

/** `0.00`-style decimal pattern for a precision (0 → `0`). */
function decimalPattern(precision: number): string {
  const clamped = Math.min(10, Math.max(0, Math.round(precision)));
  return clamped === 0 ? '0' : `0.${'0'.repeat(clamped)}`;
}

/** The column treatment for one created field. */
export interface GoogleSheetsColumnPlan {
  header: string;
  /** Number format applied to the column's data rows. */
  numberFormat?: GoogleSheetsNumberFormat;
  /** Data validation applied to the column's data rows (checkbox / dropdown). */
  dataValidation?: GoogleSheetsDataValidationRule;
  /** Note placed on the header cell. */
  headerNote?: string;
  /**
   * For foreignKey fields: the `scratch-fk-target` developer-metadata value
   * (`<spreadsheetId>/<sheetId>`), read back by the schema builder into the
   * `x-scratch-foreign-key` annotation.
   */
  foreignKeyTargetMetadataValue?: string;
}

export type BuiltGoogleSheetsColumn = { column: GoogleSheetsColumnPlan } | { skip: string };

/** Map one logical field spec to its column plan (or a per-field skip reason). */
export function buildGoogleSheetsColumn(spec: ResolvedCreateFieldSpec): BuiltGoogleSheetsColumn {
  const fieldType = spec.fieldType;
  switch (fieldType.kind) {
    case 'text':
    case 'longText':
    case 'url':
    case 'email':
    case 'phone':
      // TEXT format keeps hand-typed entries verbatim (no locale date/number coercion).
      return { column: { header: spec.name, numberFormat: { type: 'TEXT' } } };
    case 'number':
      return { column: { header: spec.name, numberFormat: buildNumberFormat(fieldType) } };
    case 'currency': {
      const symbol = currencySymbolFor(fieldType.currencyCode);
      return {
        column: {
          header: spec.name,
          numberFormat: {
            type: 'CURRENCY',
            pattern: `"${symbol}"#,##${decimalPattern(fieldType.precision ?? 2)}`,
          },
        },
      };
    }
    case 'boolean':
      // BOOLEAN validation renders real checkboxes — no magic header prefixes.
      return {
        column: {
          header: spec.name,
          dataValidation: { condition: { type: 'BOOLEAN' }, strict: false, showCustomUi: true },
        },
      };
    case 'date':
      return {
        column: {
          header: spec.name,
          numberFormat: fieldType.includesTime
            ? { type: 'DATE_TIME', pattern: 'yyyy-mm-dd hh:mm:ss' }
            : { type: 'DATE', pattern: 'yyyy-mm-dd' },
        },
      };
    case 'select':
      return {
        column: {
          header: spec.name,
          dataValidation: {
            condition: {
              type: 'ONE_OF_LIST',
              values: fieldType.options.map((option) => ({ userEnteredValue: option.name })),
            },
            // Non-strict: an unexpected value gets Google's warning triangle,
            // never a rejected write (surface, don't block).
            strict: false,
            showCustomUi: true,
          },
        },
      };
    case 'multiSelect':
      // Cells are scalars, so multiple values are comma-joined text. The
      // dropdown validation would fight multi-values, so it's a plain TEXT
      // column with the options documented in the header note.
      return {
        column: {
          header: spec.name,
          numberFormat: { type: 'TEXT' },
          headerNote: `Multiple values, separated by commas.\nOptions: ${fieldType.options
            .map((option) => option.name)
            .join(', ')}`,
        },
      };
    case 'foreignKey':
      return buildForeignKeyColumn(spec, fieldType);
    default:
      return assertUnreachable(fieldType);
  }
}

function buildNumberFormat(fieldType: Extract<CreateFieldType, { kind: 'number' }>): GoogleSheetsNumberFormat {
  const format = fieldType.format ?? 'plain';
  if (format === 'percent') {
    return { type: 'PERCENT', pattern: `${decimalPattern(fieldType.precision ?? 2)}%` };
  }
  if (format === 'integer') {
    return { type: 'NUMBER', pattern: '0' };
  }
  return fieldType.precision !== undefined
    ? { type: 'NUMBER', pattern: decimalPattern(fieldType.precision) }
    : { type: 'NUMBER' };
}

function buildForeignKeyColumn(
  spec: ResolvedCreateFieldSpec,
  fieldType: Extract<CreateFieldType, { kind: 'foreignKey' }>,
): BuiltGoogleSheetsColumn {
  const target = fieldType.target;
  if (!('existingRemoteTableId' in target)) {
    // Refs are resolved server-side before dispatch; surface rather than crash.
    return { skip: `foreign key "${spec.name}" target was not resolved to an existing table` };
  }
  const [targetSpreadsheetId, targetSheetId] = target.existingRemoteTableId;
  if (!targetSpreadsheetId || !targetSheetId) {
    return { skip: `foreign key "${spec.name}" target is missing a Google Sheets table id` };
  }
  return {
    column: {
      header: spec.name,
      numberFormat: { type: 'TEXT' },
      headerNote:
        `Linked rows: this column holds the ${SCRATCH_ID_COLUMN_HEADER} of a row in the linked sheet ` +
        `(sheet id ${targetSheetId}). Managed by Scratch.`,
      foreignKeyTargetMetadataValue: `${targetSpreadsheetId}/${targetSheetId}`,
    },
  };
}

/**
 * Order a table's fields for creation: the designated primary field (if any)
 * first, so it lands in column B right after the Scratch ID column. Stable
 * otherwise; does not mutate the input.
 */
export function orderFieldsForCreateTable(fields: ResolvedCreateFieldSpec[]): ResolvedCreateFieldSpec[] {
  const primaryIndex = fields.findIndex((field) => field.isPrimary);
  if (primaryIndex <= 0) return [...fields];
  return [fields[primaryIndex], ...fields.slice(0, primaryIndex), ...fields.slice(primaryIndex + 1)];
}
