import { TableViewCol, TransformerTypes } from '@spinner/shared-types';
import { buildGoogleSheetsDefaultView } from '../google-sheets-default-view';
import { buildGoogleSheetsJsonTableSpec } from '../google-sheets-json-schema';
import { GoogleSheetsSheetDescription, SCRATCH_ID_RECORD_KEY } from '../google-sheets-types';

function buildView(columns: GoogleSheetsSheetDescription['columns']) {
  const spec = buildGoogleSheetsJsonTableSpec({
    id: { wsId: 'gs_test_42', remoteId: ['spreadsheet123', '42'] },
    description: {
      spreadsheetId: 'spreadsheet123',
      spreadsheetTitle: 'My Data',
      sheetId: 42,
      sheetTitle: 'Orders',
      rowCount: 100,
      columnCount: 26,
      observedColumnWidth: Math.max(1, ...columns.map((column) => column.columnIndex + 1)),
      columns,
    },
  });
  return buildGoogleSheetsDefaultView(spec);
}

function cols(view: ReturnType<typeof buildGoogleSheetsDefaultView>): TableViewCol[] {
  return view.cols.filter((col): col is TableViewCol => col.kind === 'col');
}

describe('buildGoogleSheetsDefaultView', () => {
  it('lists data columns in sheet order and puts the hidden Scratch ID column last', () => {
    const view = buildView([
      { slug: 'name', header: 'Name', columnIndex: 1 },
      { slug: 'age', header: 'Age', columnIndex: 2, numberFormat: { type: 'NUMBER' } },
    ]);
    const columnPaths = cols(view).map((col) => col.path);
    expect(columnPaths).toEqual(['name', 'age', SCRATCH_ID_RECORD_KEY]);

    const scratchIdColumn = cols(view).find((col) => col.path === SCRATCH_ID_RECORD_KEY);
    expect(scratchIdColumn?.hidden).toBe(true);
    expect(scratchIdColumn?.readonly).toBe(true);
  });

  it('uses the header text as the column display name', () => {
    const view = buildView([{ slug: 'email_address', header: 'Email Address', columnIndex: 1 }]);
    expect(cols(view)[0].name).toBe('Email Address');
  });

  it('maps checkbox and numeric formats to the matching cell types', () => {
    const view = buildView([
      { slug: 'done', header: 'Done', columnIndex: 1, dataValidation: { condition: { type: 'BOOLEAN' } } },
      { slug: 'price', header: 'Price', columnIndex: 2, numberFormat: { type: 'CURRENCY' } },
    ]);
    expect(cols(view).find((col) => col.path === 'done')?.type).toBe('checkbox');
    expect(cols(view).find((col) => col.path === 'price')?.type).toBe('number');
  });

  it('renders serial-date columns as strings with the serial↔ISO display transform and codec', () => {
    const view = buildView([
      { slug: 'launched_at', header: 'Launched At', columnIndex: 1, numberFormat: { type: 'DATE_TIME' } },
    ]);
    const dateColumn = cols(view)[0];
    expect(dateColumn.type).toBe('string');
    expect(dateColumn.logicalType).toBe('datetime');
    expect(dateColumn.displayTransformer).toEqual({ type: 'serial_date_to_iso' });
    expect(dateColumn.codec?.toCore).toEqual({ type: TransformerTypes.SerialDateToIso });
    expect(dateColumn.codec?.fromCore).toEqual({ type: TransformerTypes.IsoToSerialDate });
  });

  it('hides the injected <source>_record_id plumbing column by default', () => {
    const view = buildView([
      { slug: 'name', header: 'Name', columnIndex: 1 },
      { slug: 'sanity_record_id', header: 'sanity_record_id', columnIndex: 2 },
    ]);
    const recordIdColumn = cols(view).find((col) => col.path === 'sanity_record_id');
    expect(recordIdColumn?.hidden).toBe(true);
    expect(cols(view).find((col) => col.path === 'name')?.hidden).toBeUndefined();
  });

  it('propagates foreign-key targets onto the view column', () => {
    const view = buildView([
      { slug: 'customer', header: 'Customer', columnIndex: 1, foreignKeyTarget: ['spreadsheet123', '7'] },
    ]);
    expect(cols(view)[0].foreignKey).toEqual({
      linkedTableId: 'spreadsheet123.7',
      linkedTableRemoteId: ['spreadsheet123', '7'],
      isSingleValued: true,
    });
  });
});
