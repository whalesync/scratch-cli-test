import { type CreateFieldSpec, type CreateFieldType } from '@spinner/shared-types';
import {
  buildNotionPropertiesForFields,
  currencyCodeToNotionNumberFormat,
  mapCreateFieldToNotionProperty,
  normalizeSelectColor,
  NOTION_SCHEMA_CREATION_CAPABILITIES,
  type NotionForeignKeyResolutions,
} from '../notion-create-schema';

function field(name: string, fieldType: CreateFieldType, extra: Partial<CreateFieldSpec> = {}): CreateFieldSpec {
  return { name, fieldType, ...extra };
}

const noFks: NotionForeignKeyResolutions = new Map();

function configFor(fieldType: CreateFieldType, fkResolutions: NotionForeignKeyResolutions = noFks): unknown {
  const result = mapCreateFieldToNotionProperty(field('value', fieldType), false, fkResolutions);
  if ('skipReason' in result) {
    throw new Error(`expected a config but got a skip: ${result.skipReason}`);
  }
  return result.config;
}

describe('mapCreateFieldToNotionProperty', () => {
  it('maps a primary field to Notion title regardless of kind', () => {
    const result = mapCreateFieldToNotionProperty(field('Name', { kind: 'text' }), true, noFks);
    expect(result).toEqual({ config: { title: {} } });
  });

  describe('logical field kind → Notion property config', () => {
    it.each<[string, CreateFieldType, unknown]>([
      ['text', { kind: 'text' }, { rich_text: {} }],
      ['longText', { kind: 'longText' }, { rich_text: {} }],
      ['number plain', { kind: 'number', format: 'plain' }, { number: { format: 'number' } }],
      ['number integer', { kind: 'number', format: 'integer' }, { number: { format: 'number' } }],
      ['number decimal', { kind: 'number', format: 'decimal' }, { number: { format: 'number' } }],
      ['number unset', { kind: 'number' }, { number: { format: 'number' } }],
      ['number percent', { kind: 'number', format: 'percent' }, { number: { format: 'percent' } }],
      ['currency USD', { kind: 'currency', currencyCode: 'USD' }, { number: { format: 'dollar' } }],
      ['currency EUR', { kind: 'currency', currencyCode: 'EUR' }, { number: { format: 'euro' } }],
      ['currency unknown', { kind: 'currency', currencyCode: 'XyZ' as 'USD' }, { number: { format: 'number' } }],
      ['boolean', { kind: 'boolean' }, { checkbox: {} }],
      ['date', { kind: 'date' }, { date: {} }],
      ['date w/ time', { kind: 'date', includesTime: true }, { date: {} }],
      ['url', { kind: 'url' }, { url: {} }],
      ['email', { kind: 'email' }, { email: {} }],
      ['phone', { kind: 'phone' }, { phone_number: {} }],
    ])('maps %s', (_label, fieldType, expectedConfig) => {
      expect(configFor(fieldType)).toEqual(expectedConfig);
    });

    it('maps select with normalized option colors', () => {
      expect(
        configFor({
          kind: 'select',
          options: [{ name: 'Low', color: 'green' }, { name: 'High', color: 'not-a-notion-color' }, { name: 'Plain' }],
        }),
      ).toEqual({
        select: { options: [{ name: 'Low', color: 'green' }, { name: 'High' }, { name: 'Plain' }] },
      });
    });

    it('maps multiSelect with options', () => {
      expect(configFor({ kind: 'multiSelect', options: [{ name: 'a' }, { name: 'b' }] })).toEqual({
        multi_select: { options: [{ name: 'a' }, { name: 'b' }] },
      });
    });
  });

  it('attaches an optional description as a sibling key', () => {
    const result = mapCreateFieldToNotionProperty(
      field('v', { kind: 'text' }, { description: 'a note' }),
      false,
      noFks,
    );
    expect(result).toEqual({ config: { rich_text: {}, description: 'a note' } });
  });

  describe('foreignKey → relation', () => {
    it('maps a resolved foreign key to a one-way relation', () => {
      const fkResolutions: NotionForeignKeyResolutions = new Map([
        ['link', { kind: 'resolved', targetDataSourceId: 'ds_target' }],
      ]);
      const result = mapCreateFieldToNotionProperty(
        field('link', { kind: 'foreignKey', target: { existingRemoteTableId: ['db', 'ds_target'] } }),
        false,
        fkResolutions,
      );
      expect(result).toEqual({
        config: { relation: { data_source_id: 'ds_target', type: 'single_property', single_property: {} } },
      });
    });

    it('skips an unresolvable foreign key with the resolution reason', () => {
      const fkResolutions: NotionForeignKeyResolutions = new Map([
        ['link', { kind: 'unresolvable', reason: 'no data source' }],
      ]);
      const result = mapCreateFieldToNotionProperty(
        field('link', { kind: 'foreignKey', target: { existingRemoteTableId: ['db'] } }),
        false,
        fkResolutions,
      );
      expect(result).toEqual({ skipReason: 'no data source' });
    });

    it('skips a foreign key with no resolution at all', () => {
      const result = mapCreateFieldToNotionProperty(
        field('link', { kind: 'foreignKey', target: { existingRemoteTableId: ['db', 'ds'] } }),
        false,
        noFks,
      );
      expect('skipReason' in result).toBe(true);
    });
  });
});

describe('buildNotionPropertiesForFields', () => {
  it('builds a properties record, mapping the isPrimary field to title when treatPrimaryAsTitle is true', () => {
    const properties = buildNotionPropertiesForFields(
      [field('Title', { kind: 'text' }, { isPrimary: true }), field('Count', { kind: 'number' })],
      { treatPrimaryAsTitle: true },
      noFks,
    );
    expect(properties).toEqual({ Title: { title: {} }, Count: { number: { format: 'number' } } });
  });

  it('ignores isPrimary when treatPrimaryAsTitle is false (adding fields to an existing data source)', () => {
    const properties = buildNotionPropertiesForFields(
      [field('Title', { kind: 'text' }, { isPrimary: true })],
      { treatPrimaryAsTitle: false },
      noFks,
    );
    expect(properties).toEqual({ Title: { rich_text: {} } });
  });

  it('records a skip reason for an unresolvable foreign key instead of adding it', () => {
    const skipped = new Map<string, string>();
    const properties = buildNotionPropertiesForFields(
      [
        field('Name', { kind: 'text' }, { isPrimary: true }),
        field('link', { kind: 'foreignKey', target: { existingRemoteTableId: ['db', 'ds'] } }),
      ],
      { treatPrimaryAsTitle: true },
      new Map([['link', { kind: 'unresolvable', reason: 'gone' }]]),
      skipped,
    );
    expect(properties).toEqual({ Name: { title: {} } });
    expect(skipped.get('link')).toBe('gone');
  });
});

describe('NOTION_SCHEMA_CREATION_CAPABILITIES', () => {
  it('supports every logical field kind and requires a text-like primary field', () => {
    const primaryField = NOTION_SCHEMA_CREATION_CAPABILITIES.primaryField;
    expect(primaryField).not.toBeNull();
    expect(primaryField?.kinds).toEqual(['text', 'longText']);
    // Notion calls its mandatory primary property the "Title".
    expect(primaryField?.displayName).toBe('Title');
    expect(primaryField?.description).toMatch(/title/i);
    // Notion has no good public docs page for this, so it ships without a link.
    expect(primaryField?.docsLink).toBeUndefined();
    expect(NOTION_SCHEMA_CREATION_CAPABILITIES.supportedFieldKinds).toEqual(
      expect.arrayContaining([
        'text',
        'longText',
        'number',
        'boolean',
        'date',
        'select',
        'multiSelect',
        'url',
        'email',
        'phone',
        'currency',
        'foreignKey',
      ]),
    );
  });

  it('does not require unique table names — a Notion page may hold multiple same-titled databases (DEV-10943)', () => {
    expect(NOTION_SCHEMA_CREATION_CAPABILITIES.requiresUniqueTableNames).toBe(false);
  });
});

describe('helpers', () => {
  it('normalizeSelectColor passes through valid Notion colors (case-insensitive) and drops the rest', () => {
    expect(normalizeSelectColor('blue')).toBe('blue');
    expect(normalizeSelectColor('BLUE')).toBe('blue');
    expect(normalizeSelectColor('chartreuse')).toBeUndefined();
    expect(normalizeSelectColor(undefined)).toBeUndefined();
  });

  it('currencyCodeToNotionNumberFormat maps known ISO codes and falls back to number', () => {
    expect(currencyCodeToNotionNumberFormat('USD')).toBe('dollar');
    expect(currencyCodeToNotionNumberFormat('gbp')).toBe('pound');
    expect(currencyCodeToNotionNumberFormat('ZZZ')).toBe('number');
  });
});
