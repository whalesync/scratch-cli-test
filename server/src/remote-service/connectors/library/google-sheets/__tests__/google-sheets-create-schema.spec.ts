import { type ResolvedCreateFieldSpec } from '../../../schema-creation.types';
import {
  buildGoogleSheetsColumn,
  GOOGLE_SHEETS_SCHEMA_CREATION_CAPABILITIES,
  orderFieldsForCreateTable,
} from '../google-sheets-create-schema';

function field(name: string, fieldType: ResolvedCreateFieldSpec['fieldType']): ResolvedCreateFieldSpec {
  return { name, fieldType };
}

function expectColumn(built: ReturnType<typeof buildGoogleSheetsColumn>) {
  if ('skip' in built) throw new Error(`expected a column, got skip: ${built.skip}`);
  return built.column;
}

describe('GOOGLE_SHEETS_SCHEMA_CREATION_CAPABILITIES', () => {
  it('supports every logical kind, requires no primary field, and reserves the ID header', () => {
    expect(GOOGLE_SHEETS_SCHEMA_CREATION_CAPABILITIES.supportedFieldKinds).toContain('foreignKey');
    expect(GOOGLE_SHEETS_SCHEMA_CREATION_CAPABILITIES.primaryField).toBeNull();
    expect(GOOGLE_SHEETS_SCHEMA_CREATION_CAPABILITIES.reservedFieldNames).toContain('Scratch ID');
    // A cell holds one scr_… id, so N→N links can't be represented.
    expect(GOOGLE_SHEETS_SCHEMA_CREATION_CAPABILITIES.supportsManyToManyForeignKeys).toBe(false);
    expect(GOOGLE_SHEETS_SCHEMA_CREATION_CAPABILITIES.requiresUniqueTableNames).toBe(true);
  });
});

describe('buildGoogleSheetsColumn', () => {
  it('maps text-like kinds to TEXT-formatted columns', () => {
    for (const kind of ['text', 'longText', 'url', 'email', 'phone'] as const) {
      const column = expectColumn(buildGoogleSheetsColumn(field('F', { kind })));
      expect(column.numberFormat).toEqual({ type: 'TEXT' });
    }
  });

  it('maps numbers with precision and percent format', () => {
    expect(expectColumn(buildGoogleSheetsColumn(field('N', { kind: 'number', precision: 3 }))).numberFormat).toEqual({
      type: 'NUMBER',
      pattern: '0.000',
    });
    expect(
      expectColumn(buildGoogleSheetsColumn(field('N', { kind: 'number', format: 'integer' }))).numberFormat,
    ).toEqual({ type: 'NUMBER', pattern: '0' });
    expect(
      expectColumn(buildGoogleSheetsColumn(field('N', { kind: 'number', format: 'percent' }))).numberFormat,
    ).toEqual({ type: 'PERCENT', pattern: '0.00%' });
  });

  it('maps currency to a symbol-bearing pattern', () => {
    const column = expectColumn(buildGoogleSheetsColumn(field('Price', { kind: 'currency', currencyCode: 'EUR' })));
    expect(column.numberFormat?.type).toBe('CURRENCY');
    expect(column.numberFormat?.pattern).toContain('€');
  });

  it('maps boolean to real checkbox validation (no header-prefix hacks)', () => {
    const column = expectColumn(buildGoogleSheetsColumn(field('Done', { kind: 'boolean' })));
    expect(column.dataValidation?.condition?.type).toBe('BOOLEAN');
    expect(column.dataValidation?.strict).toBe(false);
  });

  it('maps date and datetime to ISO-patterned formats', () => {
    expect(expectColumn(buildGoogleSheetsColumn(field('D', { kind: 'date' }))).numberFormat).toEqual({
      type: 'DATE',
      pattern: 'yyyy-mm-dd',
    });
    expect(
      expectColumn(buildGoogleSheetsColumn(field('D', { kind: 'date', includesTime: true }))).numberFormat,
    ).toEqual({ type: 'DATE_TIME', pattern: 'yyyy-mm-dd hh:mm:ss' });
  });

  it('maps select to a non-strict dropdown of the options', () => {
    const column = expectColumn(
      buildGoogleSheetsColumn(field('Status', { kind: 'select', options: [{ name: 'Open' }, { name: 'Closed' }] })),
    );
    expect(column.dataValidation?.condition?.type).toBe('ONE_OF_LIST');
    expect(column.dataValidation?.condition?.values).toEqual([
      { userEnteredValue: 'Open' },
      { userEnteredValue: 'Closed' },
    ]);
    expect(column.dataValidation?.strict).toBe(false);
  });

  it('maps multiSelect to plain text with the options documented in the header note', () => {
    const column = expectColumn(
      buildGoogleSheetsColumn(field('Tags', { kind: 'multiSelect', options: [{ name: 'A' }, { name: 'B' }] })),
    );
    expect(column.dataValidation).toBeUndefined();
    expect(column.headerNote).toContain('A, B');
  });

  it('maps a resolved foreign key to a marked TEXT column', () => {
    const column = expectColumn(
      buildGoogleSheetsColumn(
        field('Customer', {
          kind: 'foreignKey',
          target: { existingRemoteTableId: ['spreadsheetX', '7'] },
        }),
      ),
    );
    expect(column.foreignKeyTargetMetadataValue).toBe('spreadsheetX/7');
    expect(column.headerNote).toContain('Scratch ID');
  });

  it('skips (with a reason) a foreign key whose target was never resolved', () => {
    const built = buildGoogleSheetsColumn(
      field('Customer', { kind: 'foreignKey', target: { unresolvedLinkedTableId: 'contacts' } as never }),
    );
    expect('skip' in built && built.skip).toContain('Customer');
  });
});

describe('orderFieldsForCreateTable', () => {
  it('moves the designated primary field to the front (column B)', () => {
    const fields = [
      field('A', { kind: 'text' }),
      { ...field('Title', { kind: 'text' }), isPrimary: true },
      field('C', { kind: 'text' }),
    ];
    expect(orderFieldsForCreateTable(fields).map((f) => f.name)).toEqual(['Title', 'A', 'C']);
  });

  it('keeps order when no primary is designated (or it is already first)', () => {
    const fields = [field('A', { kind: 'text' }), field('B', { kind: 'text' })];
    expect(orderFieldsForCreateTable(fields).map((f) => f.name)).toEqual(['A', 'B']);
  });
});
