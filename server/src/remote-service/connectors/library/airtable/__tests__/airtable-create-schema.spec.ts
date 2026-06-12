import { type CreateFieldType } from '@spinner/shared-types';
import { type ResolvedCreateFieldSpec } from '../../../schema-creation.types';
import {
  AIRTABLE_SCHEMA_CREATION_CAPABILITIES,
  buildAirtableCreateField,
  clampPrecision,
  currencySymbolFor,
  mapKindToNativeType,
} from '../airtable-create-schema';
import { type AirtableApiCreateField } from '../airtable-types';

const BASE_ID = 'appBASE';

function field(fieldType: CreateFieldType, extra: Partial<ResolvedCreateFieldSpec> = {}): ResolvedCreateFieldSpec {
  return { name: 'f', fieldType, ...extra };
}

/** Build and assert a field came back (not a skip), returning the Airtable field. */
function buildField(fieldType: CreateFieldType, extra: Partial<ResolvedCreateFieldSpec> = {}): AirtableApiCreateField {
  const result = buildAirtableCreateField(field(fieldType, extra), { baseId: BASE_ID });
  if ('skip' in result) {
    throw new Error(`expected a built field, got skip: ${result.skip}`);
  }
  return result.field;
}

describe('AIRTABLE_SCHEMA_CREATION_CAPABILITIES', () => {
  it('supports all 12 logical field kinds', () => {
    expect(AIRTABLE_SCHEMA_CREATION_CAPABILITIES.supportedFieldKinds).toHaveLength(12);
  });

  it('mandates a primary field with text-like kinds only', () => {
    expect(AIRTABLE_SCHEMA_CREATION_CAPABILITIES.requiresPrimaryField).toBe(true);
    expect(AIRTABLE_SCHEMA_CREATION_CAPABILITIES.primaryFieldKinds).toEqual([
      'text',
      'longText',
      'number',
      'date',
      'url',
      'email',
      'phone',
      'currency',
    ]);
  });

  it('excludes checkbox/select/multiSelect/link kinds from the primary field', () => {
    const primary = AIRTABLE_SCHEMA_CREATION_CAPABILITIES.primaryFieldKinds ?? [];
    expect(primary).not.toContain('boolean');
    expect(primary).not.toContain('select');
    expect(primary).not.toContain('multiSelect');
    expect(primary).not.toContain('foreignKey');
  });

  it('caps table and field names at 255 characters', () => {
    expect(AIRTABLE_SCHEMA_CREATION_CAPABILITIES.maxTableNameLength).toBe(255);
    expect(AIRTABLE_SCHEMA_CREATION_CAPABILITIES.maxFieldNameLength).toBe(255);
  });
});

describe('buildAirtableCreateField', () => {
  it.each<[string, CreateFieldType, AirtableApiCreateField['type']]>([
    ['text', { kind: 'text' }, 'singleLineText'],
    ['longText', { kind: 'longText' }, 'multilineText'],
    ['url', { kind: 'url' }, 'url'],
    ['email', { kind: 'email' }, 'email'],
    ['phone', { kind: 'phone' }, 'phoneNumber'],
  ])('maps %s to the %s Airtable type', (_label, fieldType, expectedType) => {
    expect(buildField(fieldType).type).toBe(expectedType);
  });

  it('maps boolean to a checkbox with required color/icon options', () => {
    expect(buildField({ kind: 'boolean' })).toEqual({
      name: 'f',
      type: 'checkbox',
      options: { color: 'greenBright', icon: 'check' },
    });
  });

  describe('number', () => {
    it('maps integer format to precision 0', () => {
      expect(buildField({ kind: 'number', format: 'integer' })).toEqual({
        name: 'f',
        type: 'number',
        options: { precision: 0 },
      });
    });

    it('passes a requested decimal precision through', () => {
      expect(buildField({ kind: 'number', format: 'decimal', precision: 5 })).toEqual({
        name: 'f',
        type: 'number',
        options: { precision: 5 },
      });
    });

    it('clamps a precision above Airtable max (8)', () => {
      expect(buildField({ kind: 'number', format: 'decimal', precision: 9 })).toEqual({
        name: 'f',
        type: 'number',
        options: { precision: 8 },
      });
    });

    it('defaults precision to 2 when unset', () => {
      expect(buildField({ kind: 'number' })).toEqual({ name: 'f', type: 'number', options: { precision: 2 } });
    });

    it('maps percent format to the percent type', () => {
      expect(buildField({ kind: 'number', format: 'percent', precision: 1 })).toEqual({
        name: 'f',
        type: 'percent',
        options: { precision: 1 },
      });
    });
  });

  describe('currency', () => {
    it('maps a known currency code to its symbol with default precision', () => {
      expect(buildField({ kind: 'currency', currencyCode: 'USD' })).toEqual({
        name: 'f',
        type: 'currency',
        options: { precision: 2, symbol: '$' },
      });
    });

    it('maps EUR to its symbol', () => {
      const built = buildField({ kind: 'currency', currencyCode: 'EUR' });
      expect(built).toMatchObject({ type: 'currency', options: { symbol: '€' } });
    });

    it('falls back to the raw code for an unknown currency', () => {
      const built = buildField({ kind: 'currency', currencyCode: 'ZZZ' });
      expect(built).toMatchObject({ type: 'currency', options: { symbol: 'ZZZ' } });
    });
  });

  describe('date', () => {
    it('maps a date-only field to the date type', () => {
      expect(buildField({ kind: 'date' })).toEqual({
        name: 'f',
        type: 'date',
        options: { dateFormat: { name: 'local' } },
      });
    });

    it('maps an includesTime field to a UTC dateTime', () => {
      expect(buildField({ kind: 'date', includesTime: true })).toEqual({
        name: 'f',
        type: 'dateTime',
        options: {
          timeZone: 'utc',
          dateFormat: { name: 'local' },
          timeFormat: { format: 'HH:mm', name: '24hour' },
        },
      });
    });
  });

  describe('select / multiSelect', () => {
    it('maps select to singleSelect, dropping per-option colors', () => {
      const built = buildField({ kind: 'select', options: [{ name: 'A', color: 'blue' }, { name: 'B' }] });
      expect(built).toEqual({
        name: 'f',
        type: 'singleSelect',
        options: { choices: [{ name: 'A' }, { name: 'B' }] },
      });
    });

    it('maps multiSelect to multipleSelects', () => {
      const built = buildField({ kind: 'multiSelect', options: [{ name: 'X' }] });
      expect(built).toEqual({
        name: 'f',
        type: 'multipleSelects',
        options: { choices: [{ name: 'X' }] },
      });
    });
  });

  describe('foreignKey', () => {
    it('maps a same-base link to multipleRecordLinks with the linked table id', () => {
      const built = buildField({ kind: 'foreignKey', target: { existingRemoteTableId: [BASE_ID, 'tblTARGET'] } });
      expect(built).toEqual({
        name: 'f',
        type: 'multipleRecordLinks',
        options: { linkedTableId: 'tblTARGET' },
      });
    });

    it('ignores allowMultiple (Airtable links are always multi-capable)', () => {
      const built = buildField({
        kind: 'foreignKey',
        target: { existingRemoteTableId: [BASE_ID, 'tblTARGET'] },
        allowMultiple: true,
      });
      expect(built).toMatchObject({ type: 'multipleRecordLinks', options: { linkedTableId: 'tblTARGET' } });
    });

    it('skips a cross-base link', () => {
      const result = buildAirtableCreateField(
        field({ kind: 'foreignKey', target: { existingRemoteTableId: ['appOTHER', 'tblX'] } }),
        { baseId: BASE_ID },
      );
      expect('skip' in result).toBe(true);
      if ('skip' in result) {
        expect(result.skip).toContain('different base');
      }
    });

    it('skips an unresolved {ref} target (server-bug guard)', () => {
      const result = buildAirtableCreateField(field({ kind: 'foreignKey', target: { ref: 'other-table' } }), {
        baseId: BASE_ID,
      });
      expect('skip' in result).toBe(true);
      if ('skip' in result) {
        expect(result.skip).toContain('not resolved');
      }
    });
  });

  it('passes name and description through to the Airtable field', () => {
    const built = buildField({ kind: 'text' }, { name: 'Title', description: 'the headline' });
    expect(built.name).toBe('Title');
    expect(built.description).toBe('the headline');
  });
});

describe('helpers', () => {
  it.each([
    [-1, 0],
    [0, 0],
    [3, 3],
    [8, 8],
    [9, 8],
    [100, 8],
  ])('clampPrecision(%i) === %i', (input, expected) => {
    expect(clampPrecision(input)).toBe(expected);
  });

  it('currencySymbolFor maps known codes and falls back otherwise', () => {
    expect(currencySymbolFor('GBP')).toBe('£');
    expect(currencySymbolFor('JPY')).toBe('¥');
    expect(currencySymbolFor('XYZ')).toBe('XYZ');
  });

  it('mapKindToNativeType returns the representative Airtable type per kind', () => {
    expect(mapKindToNativeType('foreignKey')).toBe('multipleRecordLinks');
    expect(mapKindToNativeType('boolean')).toBe('checkbox');
    expect(mapKindToNativeType('text')).toBe('singleLineText');
  });
});
