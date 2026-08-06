import {
  TableView,
  TableViewCol,
  TransformerTypes,
  X_SCRATCH_CONNECTOR_DATA_TYPE,
  X_SCRATCH_FOREIGN_KEY_OPTIONS,
  X_SCRATCH_READONLY,
} from '@spinner/shared-types';
import { BaseJsonTableSpec } from '../../types';
import { GoogleSheetsColumnDataType, isSerialDateColumnType } from './google-sheets-json-schema';
import { SCRATCH_ID_RECORD_KEY } from './google-sheets-types';

/**
 * Default view for a Google Sheets table — a pure `spec → view` stage.
 *
 * Columns come out in sheet order (the schema's property insertion order mirrors
 * the grid). Editorial choices: the Scratch ID plumbing column goes last and
 * hidden; date/datetime columns (serial numbers on disk) render through the
 * `serial_date_to_iso` display transform and carry a bidirectional codec so a
 * grid edit of "2025-08-01" saves back as the serial number the sheet expects.
 */
export function buildGoogleSheetsDefaultView(spec: BaseJsonTableSpec): TableView {
  const schemaProperties =
    ((spec.schema as unknown as Record<string, unknown>).properties as Record<string, Record<string, unknown>>) ?? {};

  const dataColumns: TableViewCol[] = [];
  let scratchIdColumn: TableViewCol | undefined;

  for (const [fieldKey, fieldSchema] of Object.entries(schemaProperties)) {
    if (fieldKey === SCRATCH_ID_RECORD_KEY) {
      scratchIdColumn = {
        kind: 'col',
        name: typeof fieldSchema.title === 'string' ? fieldSchema.title : 'Scratch ID',
        path: fieldKey,
        type: 'string',
        readonly: fieldSchema[X_SCRATCH_READONLY] === true,
        hidden: true,
      };
      continue;
    }
    dataColumns.push(buildDataColumn(fieldKey, fieldSchema));
  }

  const cols: TableViewCol[] = [...dataColumns];
  if (scratchIdColumn) cols.push(scratchIdColumn);
  return { name: 'Default', cols };
}

function buildDataColumn(fieldKey: string, fieldSchema: Record<string, unknown>): TableViewCol {
  const columnDataType = fieldSchema[X_SCRATCH_CONNECTOR_DATA_TYPE] as GoogleSheetsColumnDataType | undefined;
  const column: TableViewCol = {
    kind: 'col',
    name: typeof fieldSchema.title === 'string' ? fieldSchema.title : fieldKey,
    path: fieldKey,
    type: renderTypeFor(columnDataType),
  };

  // Live Export injects a `<source>_record_id` match-key column into every
  // created table (CreateFieldSpec.isSourceRecordId). It's sync plumbing, not
  // user content — hide it by default (still available via the column picker).
  // Heuristic on the slug since the injected name is `<service>_record_id`;
  // a user's own column with that suffix just starts hidden, which is cheap to undo.
  if (fieldKey.endsWith('_record_id')) {
    column.hidden = true;
  }

  if (isSerialDateColumnType(columnDataType)) {
    // Raw value is a spreadsheet serial number; render (and export) it as ISO,
    // and pack grid edits back to a serial. `type` stays 'string' because only
    // the text cell consults displayTransformer; `logicalType` tells the export
    // layer what the flattened value really is.
    column.logicalType = columnDataType;
    column.displayTransformer = { type: 'serial_date_to_iso' };
    column.codec = {
      toCore: { type: TransformerTypes.SerialDateToIso },
      fromCore: { type: TransformerTypes.IsoToSerialDate },
    };
  }

  const foreignKeyOptions = fieldSchema[X_SCRATCH_FOREIGN_KEY_OPTIONS] as
    | { linkedTableId: string; linkedTableRemoteId?: string[]; isSingleValued?: boolean }
    | undefined;
  if (foreignKeyOptions) {
    column.foreignKey = {
      linkedTableId: foreignKeyOptions.linkedTableId,
      ...(foreignKeyOptions.linkedTableRemoteId ? { linkedTableRemoteId: foreignKeyOptions.linkedTableRemoteId } : {}),
      ...(foreignKeyOptions.isSingleValued !== undefined ? { isSingleValued: foreignKeyOptions.isSingleValued } : {}),
    };
  }

  return column;
}

function renderTypeFor(columnDataType: GoogleSheetsColumnDataType | undefined): TableViewCol['type'] {
  switch (columnDataType) {
    case 'checkbox':
      return 'checkbox';
    case 'number':
    case 'currency':
    case 'percent':
      return 'number';
    // date/datetime render as 'string' so the text cell runs the display
    // transformer; time/select/text and unformatted columns are plain strings.
    default:
      return 'string';
  }
}
