import { TSchema, Type } from '@sinclair/typebox';
import {
  TransformerTypes,
  X_SCRATCH_CONNECTOR_DATA_TYPE,
  X_SCRATCH_FOREIGN_KEY_OPTIONS,
  X_SCRATCH_READONLY,
  X_SCRATCH_REMOTE_FIELD_ID,
  X_SCRATCH_SUGGESTED_IN_TRANSFORMER,
  X_SCRATCH_SUGGESTED_IN_TRANSFORMER_INPUT_TYPE,
  X_SCRATCH_SUGGESTED_TRANSFORMER,
} from '@spinner/shared-types';
import { sanitizeForTableWsId } from '../../ids';
import { BaseJsonTableSpec, dotPath, EntityId } from '../../types';
import {
  GoogleSheetsColumnDescriptor,
  GoogleSheetsSheetDescription,
  SCRATCH_ID_COLUMN_HEADER,
  SCRATCH_ID_RECORD_KEY,
} from './google-sheets-types';

/**
 * Schema builder: a described sheet → BaseJsonTableSpec.
 *
 * A record file is a flat object: `scratch_id` (the managed remote id) plus one
 * key per headed column, keyed by the header's slug. Cells are read losslessly
 * (UNFORMATTED_VALUE + SERIAL_NUMBER), so every data field is
 * string | number | boolean | null — a cell can hold any of these regardless of
 * the column's declared format (Sheets never enforces cell types), which is why
 * the schema deliberately stays a permissive union: the column FORMAT is a
 * display/semantic hint (carried via x-scratch annotations), never a validation
 * constraint that would flag legitimate user data.
 */

/**
 * The connector-data-type vocabulary this connector emits on
 * `x-scratch-connector-data-type` (derived from the column's number format and
 * data validation). Consumed by the default-view builder and the Live Export
 * plan generator; NOT a validation constraint.
 */
export type GoogleSheetsColumnDataType =
  | 'text'
  | 'number'
  | 'percent'
  | 'currency'
  | 'date'
  | 'datetime'
  | 'time'
  | 'checkbox'
  | 'select';

/** Derive the semantic column type from its format + validation (undefined = plain text). */
export function deriveColumnDataType(column: GoogleSheetsColumnDescriptor): GoogleSheetsColumnDataType | undefined {
  const validationConditionType = column.dataValidation?.condition?.type;
  if (validationConditionType === 'BOOLEAN') return 'checkbox';
  if (validationConditionType === 'ONE_OF_LIST') return 'select';

  switch (column.numberFormat?.type) {
    case 'DATE':
      return 'date';
    case 'DATE_TIME':
      return 'datetime';
    case 'TIME':
      return 'time';
    case 'CURRENCY':
      return 'currency';
    case 'PERCENT':
      return 'percent';
    case 'NUMBER':
    case 'SCIENTIFIC':
      return 'number';
    case 'TEXT':
      return 'text';
    default:
      return undefined;
  }
}

/** Whether a derived column type stores spreadsheet serial-date numbers. */
export function isSerialDateColumnType(columnDataType: GoogleSheetsColumnDataType | undefined): boolean {
  return columnDataType === 'date' || columnDataType === 'datetime';
}

/** Build the TypeBox schema node for one data column. */
function buildColumnSchema(column: GoogleSheetsColumnDescriptor): TSchema {
  const columnDataType = deriveColumnDataType(column);

  const annotations: Record<string, unknown> = {
    title: column.header,
    [X_SCRATCH_REMOTE_FIELD_ID]: column.header,
  };
  if (columnDataType !== undefined) {
    annotations[X_SCRATCH_CONNECTOR_DATA_TYPE] = columnDataType;
  }
  if (isSerialDateColumnType(columnDataType)) {
    // Date cells are serial numbers on disk (lossless, locale-free). The
    // suggested transformers keep every consumer in ISO-land: exports FROM this
    // column unpack serial → ISO; syncs INTO it pack ISO → serial (written RAW
    // into the DATE/DATE_TIME-formatted column, so it renders as a real date).
    annotations[X_SCRATCH_SUGGESTED_TRANSFORMER] = { type: TransformerTypes.SerialDateToIso };
    annotations[X_SCRATCH_SUGGESTED_IN_TRANSFORMER] = { type: TransformerTypes.IsoToSerialDate };
    annotations[X_SCRATCH_SUGGESTED_IN_TRANSFORMER_INPUT_TYPE] = 'string';
  } else if (columnDataType === 'checkbox') {
    // A cell holds any scalar and the record schema is a permissive union, so
    // without a declared pack the transform picker's default coerces incoming
    // values to STRING — a checkbox column then holds the literal text "true"
    // (found live in the Sanity audit). Declare what the column really wants.
    annotations[X_SCRATCH_SUGGESTED_IN_TRANSFORMER] = {
      type: TransformerTypes.AutoConvert,
      options: { targetType: 'boolean', preserveNull: true },
    };
    annotations[X_SCRATCH_SUGGESTED_IN_TRANSFORMER_INPUT_TYPE] = 'boolean';
  } else if (columnDataType === 'number' || columnDataType === 'currency' || columnDataType === 'percent') {
    // Same as checkbox: NUMBER/CURRENCY/PERCENT-formatted columns want real
    // numbers, not stringified ones ("0", "9007199254740992").
    annotations[X_SCRATCH_SUGGESTED_IN_TRANSFORMER] = {
      type: TransformerTypes.AutoConvert,
      options: { targetType: 'number', preserveNull: true },
    };
    annotations[X_SCRATCH_SUGGESTED_IN_TRANSFORMER_INPUT_TYPE] = 'number';
  }
  if (column.foreignKeyTarget) {
    const [linkedSpreadsheetId, linkedSheetId] = column.foreignKeyTarget;
    annotations[X_SCRATCH_FOREIGN_KEY_OPTIONS] = {
      // The QUALIFIED dot-joined form (like the pg connectors' `schema.table`),
      // NOT the bare gid: gids are only unique within one spreadsheet (every
      // first tab is gid 0), and the FK binder's fallback token matching would
      // let a bare '0' bind to any other spreadsheet's first tab. The full id
      // rides in linkedTableRemoteId, which the binder matches exactly first.
      linkedTableId: `${linkedSpreadsheetId}.${linkedSheetId}`,
      linkedTableRemoteId: [linkedSpreadsheetId, linkedSheetId],
      // A cell holds ONE scr_… id — multi-links would need a lossy delimiter
      // encoding, so v1 links are declared single-valued (see create-schema's
      // supportsManyToManyForeignKeys: false).
      isSingleValued: true,
    };
  }

  return Type.Union([Type.String(), Type.Number(), Type.Boolean(), Type.Null()], annotations);
}

/** Build the full table spec for a described sheet. */
export function buildGoogleSheetsJsonTableSpec(params: {
  id: EntityId;
  description: GoogleSheetsSheetDescription;
}): BaseJsonTableSpec {
  const { id, description } = params;

  // Every property is OPTIONAL: pulled records always carry every key, but a
  // locally-created record starts as `{}` (and gains scratch_id only at
  // publish) — a `required` list would make enforce_schema warn on every
  // draft row until it ships.
  const properties: Record<string, TSchema> = {
    [SCRATCH_ID_RECORD_KEY]: Type.Optional(
      Type.String({
        title: SCRATCH_ID_COLUMN_HEADER,
        description: 'The row id Scratch assigns in the managed "Scratch ID" column (column A). Never edit this value.',
        [X_SCRATCH_READONLY]: true,
      }),
    ),
  };
  for (const column of description.columns) {
    properties[column.slug] = Type.Optional(buildColumnSchema(column));
  }

  const firstDataColumnSlug = description.columns[0]?.slug;

  return {
    id,
    slug: sanitizeForTableWsId(description.sheetTitle),
    name: description.sheetTitle,
    schema: Type.Object(properties),
    idPath: dotPath(SCRATCH_ID_RECORD_KEY),
    // Column B (the first data column) is the de-facto title column of a sheet.
    titlePath: firstDataColumnSlug ? dotPath(firstDataColumnSlug) : undefined,
    basePath: [description.spreadsheetTitle],
    remoteWebUrl: `https://docs.google.com/spreadsheets/d/${description.spreadsheetId}/edit#gid=${description.sheetId}`,
    // The spreadsheet the sheet lives in — the same place a create destination
    // names; its URL is this one without the per-sheet `#gid` fragment.
    remoteContainer: {
      id: description.spreadsheetId,
      name: description.spreadsheetTitle,
      remoteWebUrl: `https://docs.google.com/spreadsheets/d/${description.spreadsheetId}/edit`,
    },
    generatedAt: new Date().toISOString(),
  };
}
