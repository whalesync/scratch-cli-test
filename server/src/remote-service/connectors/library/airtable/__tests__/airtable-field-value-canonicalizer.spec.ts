import {
  areFieldValuesCanonicallyEqual,
  FieldValueCanonicalizerContext,
  resolveFieldValueCanonicalizersForTable,
} from 'src/remote-service/connectors/field-value-canonicalization';
import { Service } from 'src/remote-service/connectors/service-constants';
import { getSchemaAtFieldPath } from 'src/utils/field-path';
import { extractSchemaFields } from 'src/utils/schema-helpers';
import {
  airtableFieldValueCanonicalizerForColumnType,
  resolveAirtableFieldValueCanonicalizer,
} from '../airtable-field-value-canonicalizer';
import { buildAirtableJsonTableSpec } from '../airtable-json-schema';
import { AirtableBase, AirtableDataType, AirtableTableV2 } from '../airtable-types';
// Registers the Airtable connector with the registry (its canonicalizer hook is
// deliberately NOT registered yet — see the DEV-10556 comment in its
// `connectorRegistry.register` block).
import '../airtable-connector';

function expectSame(airtableType: string, format: string | undefined, pulled: unknown, written: unknown): void {
  expect(
    areFieldValuesCanonicallyEqual(airtableFieldValueCanonicalizerForColumnType(airtableType, format), pulled, written),
  ).toBe(true);
}

function expectDifferent(airtableType: string, format: string | undefined, pulled: unknown, written: unknown): void {
  expect(
    areFieldValuesCanonicallyEqual(airtableFieldValueCanonicalizerForColumnType(airtableType, format), pulled, written),
  ).toBe(false);
}

describe('airtableFieldValueCanonicalizerForColumnType', () => {
  it('treats an omitted-on-read field and the empty value the sync wrote as equal (DEV-11131)', () => {
    expectSame(AirtableDataType.SINGLE_LINE_TEXT, undefined, undefined, '');
    expectSame(AirtableDataType.MULTILINE_TEXT, undefined, undefined, null);
    expectSame(AirtableDataType.URL, undefined, undefined, '');
    expectSame(AirtableDataType.SINGLE_SELECT, undefined, undefined, null);
    expectSame(AirtableDataType.CHECKBOX, undefined, undefined, false);
    expectSame(AirtableDataType.MULTIPLE_SELECTS, undefined, undefined, []);
    expectSame(AirtableDataType.MULTIPLE_RECORD_LINKS, undefined, undefined, []);
    expectSame(AirtableDataType.MULTIPLE_ATTACHMENTS, undefined, undefined, []);
    expectSame(AirtableDataType.NUMBER, undefined, undefined, null);
    expectSame(AirtableDataType.DATE, 'date', undefined, null);
    expectSame(AirtableDataType.DATE_TIME, 'date-time', undefined, '');
  });

  it('still sees a real value vs empty, and a real value change', () => {
    expectDifferent(AirtableDataType.SINGLE_LINE_TEXT, undefined, 'a', '');
    expectDifferent(AirtableDataType.SINGLE_LINE_TEXT, undefined, 'a', 'b');
    expectDifferent(AirtableDataType.CHECKBOX, undefined, true, false);
    expectDifferent(AirtableDataType.CHECKBOX, undefined, undefined, true);
    expectDifferent(AirtableDataType.MULTIPLE_SELECTS, undefined, ['a'], []);
    expectDifferent(AirtableDataType.MULTIPLE_SELECTS, undefined, ['a', 'b'], ['b', 'a']);
    expectDifferent(AirtableDataType.NUMBER, undefined, 1, 2);
    expectDifferent(AirtableDataType.NUMBER, undefined, 0, null);
  });

  it('tolerates float64 round-trip noise on numeric columns', () => {
    expectSame(AirtableDataType.NUMBER, undefined, 0.3, 0.1 + 0.2);
    expectSame(AirtableDataType.CURRENCY, undefined, 19.99, 19.99);
    expectSame(AirtableDataType.PERCENT, undefined, 0.3, 0.30000000000000004);
  });

  it('compares a date-only column by calendar day and a date-time column by the second', () => {
    expectSame(AirtableDataType.DATE, 'date', '2026-03-14', '2026-03-14T15:09:26.535Z');
    expectDifferent(AirtableDataType.DATE, 'date', '2026-03-14', '2026-03-15');
    // A `dateTime` field configured without a time component also reads back as a day.
    expectSame(AirtableDataType.DATE_TIME, 'date', '2026-03-14', '2026-03-14T15:09:26.535Z');
    expectSame(AirtableDataType.DATE_TIME, 'date-time', '2026-03-14T15:09:26.000Z', '2026-03-14T15:09:26.535Z');
    expectSame(AirtableDataType.DATE_TIME, 'date-time', '2026-03-14T15:09:26.000Z', '2026-03-14T15:09:26+00:00');
    expectDifferent(AirtableDataType.DATE_TIME, 'date-time', '2026-03-14T15:09:26.000Z', '2026-03-14T15:09:27Z');
  });
});

describe('Airtable resolver on a real built table spec (hook written but not registered — DEV-10556)', () => {
  const BASE = { id: 'app1', name: 'My Base' } as unknown as AirtableBase;
  const table = {
    id: 'tbl1',
    name: 'T',
    primaryFieldId: 'f0',
    fields: [
      { id: 'f0', name: 'Name', type: AirtableDataType.SINGLE_LINE_TEXT },
      { id: 'f1', name: 'Done', type: AirtableDataType.CHECKBOX },
      { id: 'f2', name: 'Tags', type: AirtableDataType.MULTIPLE_SELECTS },
      { id: 'f3', name: 'When', type: AirtableDataType.DATE },
      { id: 'f4', name: 'Total', type: AirtableDataType.FORMULA, options: { result: { type: 'number' } } },
      { id: 'f5', name: 'Created', type: AirtableDataType.CREATED_TIME },
    ],
  } as unknown as AirtableTableV2;

  it('is NOT registered with the connector registry yet — the registry resolves nothing for Airtable', () => {
    const spec = buildAirtableJsonTableSpec({ wsId: 'tbl1', remoteId: ['app1', 'tbl1'] }, BASE, table);
    expect(resolveFieldValueCanonicalizersForTable(Service.AIRTABLE, spec).size).toBe(0);
  });

  it('resolves a canonicalizer for every writable column and none for computed columns or the envelope', () => {
    // Run the (unregistered) resolver over the spec's fields the way the registry helper would.
    const tableSpec = buildAirtableJsonTableSpec({ wsId: 'tbl1', remoteId: ['app1', 'tbl1'] }, BASE, table);
    const canonicalizers = new Map<string, (value: unknown) => unknown>();
    for (const schemaField of extractSchemaFields(tableSpec.schema)) {
      const context: FieldValueCanonicalizerContext = {
        fieldPath: schemaField.path,
        fieldSchema: getSchemaAtFieldPath(tableSpec.schema, schemaField.path),
        schemaField,
        tableSpec,
      };
      const canonicalizer = resolveAirtableFieldValueCanonicalizer(context);
      if (canonicalizer) canonicalizers.set(schemaField.path, canonicalizer);
    }

    expect([...canonicalizers.keys()].sort()).toEqual(
      ['fields.Name', 'fields.Done', 'fields.Tags', 'fields.When'].sort(),
    );
    expect(canonicalizers.has('fields.Total')).toBe(false);
    expect(canonicalizers.has('fields.Created')).toBe(false);
    expect(canonicalizers.has('id')).toBe(false);
    expect(canonicalizers.has('fields')).toBe(false);
    expect(canonicalizers.has('createdTime')).toBe(false);

    const done = canonicalizers.get('fields.Done');
    const when = canonicalizers.get('fields.When');
    if (!done || !when) throw new Error('expected canonicalizers');
    expect(areFieldValuesCanonicallyEqual(done, undefined, false)).toBe(true);
    expect(areFieldValuesCanonicallyEqual(when, '2026-03-14', '2026-03-14T15:09:26.535Z')).toBe(true);
  });
});
