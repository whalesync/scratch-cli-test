import {
  TransformerTypes,
  X_SCRATCH_CONNECTOR_DATA_TYPE,
  X_SCRATCH_FOREIGN_KEY_OPTIONS,
  X_SCRATCH_READONLY,
  X_SCRATCH_SUGGESTED_IN_TRANSFORMER,
  X_SCRATCH_SUGGESTED_TRANSFORMER,
} from '@spinner/shared-types';
import { buildGoogleSheetsJsonTableSpec, deriveColumnDataType } from '../google-sheets-json-schema';
import {
  GoogleSheetsColumnDescriptor,
  GoogleSheetsSheetDescription,
  SCRATCH_ID_RECORD_KEY,
} from '../google-sheets-types';

function makeDescription(columns: GoogleSheetsColumnDescriptor[]): GoogleSheetsSheetDescription {
  return {
    spreadsheetId: 'spreadsheet123',
    spreadsheetTitle: 'My Data',
    sheetId: 42,
    sheetTitle: 'Orders',
    rowCount: 100,
    columnCount: 26,
    observedColumnWidth: Math.max(1, ...columns.map((column) => column.columnIndex + 1)),
    columns,
  };
}

const TABLE_ID = { wsId: 'gs_test_42', remoteId: ['spreadsheet123', '42'] };

describe('deriveColumnDataType', () => {
  it('maps validation rules ahead of number formats', () => {
    expect(
      deriveColumnDataType({
        slug: 'x',
        header: 'X',
        columnIndex: 1,
        dataValidation: { condition: { type: 'BOOLEAN' } },
        numberFormat: { type: 'NUMBER' },
      }),
    ).toBe('checkbox');
    expect(
      deriveColumnDataType({
        slug: 'x',
        header: 'X',
        columnIndex: 1,
        dataValidation: { condition: { type: 'ONE_OF_LIST', values: [{ userEnteredValue: 'A' }] } },
      }),
    ).toBe('select');
  });

  it('maps number formats to semantic types', () => {
    const typeFor = (formatType: string) =>
      deriveColumnDataType({
        slug: 'x',
        header: 'X',
        columnIndex: 1,
        numberFormat: { type: formatType as never },
      });
    expect(typeFor('DATE')).toBe('date');
    expect(typeFor('DATE_TIME')).toBe('datetime');
    expect(typeFor('TIME')).toBe('time');
    expect(typeFor('CURRENCY')).toBe('currency');
    expect(typeFor('PERCENT')).toBe('percent');
    expect(typeFor('NUMBER')).toBe('number');
    expect(typeFor('TEXT')).toBe('text');
  });

  it('returns undefined for unformatted columns', () => {
    expect(deriveColumnDataType({ slug: 'x', header: 'X', columnIndex: 1 })).toBeUndefined();
  });
});

describe('buildGoogleSheetsJsonTableSpec', () => {
  it('builds a flat schema with a readonly scratch_id and one property per column', () => {
    const spec = buildGoogleSheetsJsonTableSpec({
      id: TABLE_ID,
      description: makeDescription([
        { slug: 'name', header: 'Name', columnIndex: 1 },
        { slug: 'age', header: 'Age', columnIndex: 2, numberFormat: { type: 'NUMBER' } },
      ]),
    });

    const properties = (spec.schema as unknown as { properties: Record<string, Record<string, unknown>> }).properties;
    expect(Object.keys(properties)).toEqual([SCRATCH_ID_RECORD_KEY, 'name', 'age']);
    expect(properties[SCRATCH_ID_RECORD_KEY][X_SCRATCH_READONLY]).toBe(true);
    expect(properties.age[X_SCRATCH_CONNECTOR_DATA_TYPE]).toBe('number');
    expect(spec.idPath).toBe(SCRATCH_ID_RECORD_KEY);
    expect(spec.titlePath).toBe('name');
    expect(spec.name).toBe('Orders');
    expect(spec.basePath).toEqual(['My Data']);
    expect(spec.remoteWebUrl).toBe('https://docs.google.com/spreadsheets/d/spreadsheet123/edit#gid=42');
    // The container is the spreadsheet — same link without the per-sheet fragment.
    expect(spec.remoteContainer).toEqual({
      id: 'spreadsheet123',
      name: 'My Data',
      remoteWebUrl: 'https://docs.google.com/spreadsheets/d/spreadsheet123/edit',
    });
  });

  it('annotates date columns with the serial-date transformer pair', () => {
    const spec = buildGoogleSheetsJsonTableSpec({
      id: TABLE_ID,
      description: makeDescription([
        { slug: 'launched_at', header: 'Launched At', columnIndex: 1, numberFormat: { type: 'DATE_TIME' } },
      ]),
    });
    const properties = (spec.schema as unknown as { properties: Record<string, Record<string, unknown>> }).properties;
    expect(properties.launched_at[X_SCRATCH_SUGGESTED_TRANSFORMER]).toEqual({
      type: TransformerTypes.SerialDateToIso,
    });
    expect(properties.launched_at[X_SCRATCH_SUGGESTED_IN_TRANSFORMER]).toEqual({
      type: TransformerTypes.IsoToSerialDate,
    });
  });

  it('declares boolean/number packs on checkbox and numeric columns (else values stringify)', () => {
    const spec = buildGoogleSheetsJsonTableSpec({
      id: TABLE_ID,
      description: makeDescription([
        { slug: 'done', header: 'Done', columnIndex: 1, dataValidation: { condition: { type: 'BOOLEAN' } } },
        { slug: 'price', header: 'Price', columnIndex: 2, numberFormat: { type: 'CURRENCY' } },
        { slug: 'ratio', header: 'Ratio', columnIndex: 3, numberFormat: { type: 'PERCENT' } },
      ]),
    });
    const properties = (spec.schema as unknown as { properties: Record<string, Record<string, unknown>> }).properties;
    expect(properties.done[X_SCRATCH_SUGGESTED_IN_TRANSFORMER]).toEqual({
      type: TransformerTypes.AutoConvert,
      options: { targetType: 'boolean', preserveNull: true },
    });
    expect(properties.price[X_SCRATCH_SUGGESTED_IN_TRANSFORMER]).toEqual({
      type: TransformerTypes.AutoConvert,
      options: { targetType: 'number', preserveNull: true },
    });
    expect(properties.ratio[X_SCRATCH_SUGGESTED_IN_TRANSFORMER]).toEqual({
      type: TransformerTypes.AutoConvert,
      options: { targetType: 'number', preserveNull: true },
    });
  });

  it('annotates FK columns from their developer-metadata target, single-valued', () => {
    const spec = buildGoogleSheetsJsonTableSpec({
      id: TABLE_ID,
      description: makeDescription([
        { slug: 'customer', header: 'Customer', columnIndex: 1, foreignKeyTarget: ['spreadsheet123', '7'] },
      ]),
    });
    const properties = (spec.schema as unknown as { properties: Record<string, Record<string, unknown>> }).properties;
    expect(properties.customer[X_SCRATCH_FOREIGN_KEY_OPTIONS]).toEqual({
      // Qualified (never the bare gid — every spreadsheet's first tab is gid 0,
      // so a bare token could cross-match another spreadsheet's tab).
      linkedTableId: 'spreadsheet123.7',
      linkedTableRemoteId: ['spreadsheet123', '7'],
      isSingleValued: true,
    });
  });

  it('omits titlePath for a sheet with no data columns', () => {
    const spec = buildGoogleSheetsJsonTableSpec({ id: TABLE_ID, description: makeDescription([]) });
    expect(spec.titlePath).toBeUndefined();
  });
});
