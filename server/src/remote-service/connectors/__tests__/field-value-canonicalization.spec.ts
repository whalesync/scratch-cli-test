import { Type } from '@sinclair/typebox';
import { X_SCRATCH_CONNECTOR_DATA_TYPE } from '@spinner/shared-types';
import { ConnectorRegistration, connectorRegistry } from 'src/remote-service/connectors/connector-registry';
import {
  areFieldValuesCanonicallyEqual,
  FieldValueCanonicalizerContext,
  resolveFieldValueCanonicalizersForTable,
} from 'src/remote-service/connectors/field-value-canonicalization';
import {
  asIs,
  composeCanonicalizers,
  decimalTextNormalized,
  emptyAsNull,
  isoInstantTruncatedTo,
  numberRoundedToSignificantDigits,
  parsedJsonText,
  pickedAndCanonicalized,
  unpackedWithClientSafeTransformer,
} from 'src/remote-service/connectors/field-value-canonicalizers';
import type { BaseJsonTableSpec } from 'src/remote-service/connectors/types';

const SERVICE_WITH_HOOK = 'TEST_CANONICALIZING_SERVICE';
const SERVICE_WITHOUT_HOOK = 'TEST_STRUCTURAL_SERVICE';

function makeTableSpec(): BaseJsonTableSpec {
  return {
    schema: Type.Object({
      id: Type.String(),
      fields: Type.Object({
        Notes: Type.Union([Type.String(), Type.Null()], { [X_SCRATCH_CONNECTOR_DATA_TYPE]: 'singleLineText' }),
        Done: Type.Boolean({ [X_SCRATCH_CONNECTOR_DATA_TYPE]: 'checkbox' }),
        Plain: Type.String(),
      }),
    }),
  } as unknown as BaseJsonTableSpec;
}

const registrationBase = {
  metadata: {} as ConnectorRegistration['metadata'],
  advancedSettings: [],
  supportedAuthMethods: [],
  createConnector: () => Promise.reject(new Error('not instantiable in this test')),
} satisfies Omit<ConnectorRegistration, 'service'>;

describe('resolveFieldValueCanonicalizersForTable', () => {
  const hookCalls: FieldValueCanonicalizerContext[] = [];

  beforeAll(() => {
    connectorRegistry.register({
      ...registrationBase,
      service: SERVICE_WITH_HOOK,
      resolveFieldValueCanonicalizer: (context) => {
        hookCalls.push(context);
        const dataType = context.fieldSchema?.[X_SCRATCH_CONNECTOR_DATA_TYPE] as string | undefined;
        if (dataType === 'checkbox') return emptyAsNull({ falseIsEmpty: true });
        if (dataType === 'singleLineText') return emptyAsNull();
        if (context.fieldPath === 'fields.Plain') throw new Error('boom');
        return undefined;
      },
    });
    connectorRegistry.register({ ...registrationBase, service: SERVICE_WITHOUT_HOOK });
  });

  beforeEach(() => {
    hookCalls.length = 0;
  });

  it('returns an empty map for an unknown service, a connector without the hook, or a table without a schema', () => {
    const spec = makeTableSpec();
    expect(resolveFieldValueCanonicalizersForTable('NO_SUCH_SERVICE', spec).size).toBe(0);
    expect(resolveFieldValueCanonicalizersForTable(SERVICE_WITHOUT_HOOK, spec).size).toBe(0);
    expect(resolveFieldValueCanonicalizersForTable(SERVICE_WITH_HOOK, null).size).toBe(0);
    expect(resolveFieldValueCanonicalizersForTable(SERVICE_WITH_HOOK, {} as BaseJsonTableSpec).size).toBe(0);
  });

  it('calls the hook once per schema field with the field path, schema node and SchemaField, keeping only declared canonicalizers', () => {
    const spec = makeTableSpec();
    const canonicalizers = resolveFieldValueCanonicalizersForTable(SERVICE_WITH_HOOK, spec);

    expect([...canonicalizers.keys()].sort()).toEqual(['fields.Done', 'fields.Notes']);
    const notesCall = hookCalls.find((call) => call.fieldPath === 'fields.Notes');
    expect(notesCall?.fieldSchema?.[X_SCRATCH_CONNECTOR_DATA_TYPE]).toBe('singleLineText');
    expect(notesCall?.schemaField.path).toBe('fields.Notes');
    expect(notesCall?.schemaField.type).toBe('string');
    expect(notesCall?.tableSpec).toBe(spec);
  });

  it('treats a hook that throws for one field as "no canonicalizer" for that field only', () => {
    const canonicalizers = resolveFieldValueCanonicalizersForTable(SERVICE_WITH_HOOK, makeTableSpec());
    expect(canonicalizers.has('fields.Plain')).toBe(false);
    expect(canonicalizers.has('fields.Notes')).toBe(true);
  });

  it('memoises per table-spec object so repeated calls do not re-run the hook', () => {
    const spec = makeTableSpec();
    const first = resolveFieldValueCanonicalizersForTable(SERVICE_WITH_HOOK, spec);
    const callsAfterFirst = hookCalls.length;
    const second = resolveFieldValueCanonicalizersForTable(SERVICE_WITH_HOOK, spec);
    expect(second).toBe(first);
    expect(hookCalls.length).toBe(callsAfterFirst);
  });

  it('produces canonicalizers that make the Airtable absent-vs-empty spellings equal', () => {
    const canonicalizers = resolveFieldValueCanonicalizersForTable(SERVICE_WITH_HOOK, makeTableSpec());
    const notes = canonicalizers.get('fields.Notes');
    const done = canonicalizers.get('fields.Done');
    if (!notes || !done) throw new Error('expected canonicalizers');
    expect(areFieldValuesCanonicallyEqual(notes, undefined, '')).toBe(true);
    expect(areFieldValuesCanonicallyEqual(notes, null, '')).toBe(true);
    expect(areFieldValuesCanonicallyEqual(notes, 'a', '')).toBe(false);
    expect(areFieldValuesCanonicallyEqual(done, undefined, false)).toBe(true);
    expect(areFieldValuesCanonicallyEqual(done, undefined, true)).toBe(false);
  });
});

describe('areFieldValuesCanonicallyEqual', () => {
  it('compares canonical forms with deep equality', () => {
    const lengthOnly = (value: unknown) => (typeof value === 'string' ? value.length : value);
    expect(areFieldValuesCanonicallyEqual(lengthOnly, 'abc', 'xyz')).toBe(true);
    expect(areFieldValuesCanonicallyEqual(lengthOnly, 'abc', 'xy')).toBe(false);
  });

  it('falls back to structural equality when the canonicalizer throws', () => {
    const throwing = () => {
      throw new Error('bad canonicalizer');
    };
    expect(areFieldValuesCanonicallyEqual(throwing, { a: 1 }, { a: 1 })).toBe(true);
    expect(areFieldValuesCanonicallyEqual(throwing, { a: 1 }, { a: 2 })).toBe(false);
  });
});

describe('canonicalizer building blocks', () => {
  it('composeCanonicalizers runs steps left to right', () => {
    const c = composeCanonicalizers(
      (v) => (typeof v === 'string' ? v.trim() : v),
      (v) => (v === '' ? null : v),
    );
    expect(c('  ')).toBeNull();
    expect(c(' a ')).toBe('a');
  });

  it('emptyAsNull maps every spelling of empty to null and passes non-empty values through', () => {
    const basic = emptyAsNull();
    expect(basic(undefined)).toBeNull();
    expect(basic(null)).toBeNull();
    expect(basic('')).toBeNull();
    expect(basic(false)).toBe(false);
    expect(basic([])).toEqual([]);
    expect(basic('x')).toBe('x');
    expect(basic(0)).toBe(0);

    const airtableStyle = emptyAsNull({ falseIsEmpty: true, emptyArrayIsEmpty: true });
    expect(airtableStyle(false)).toBeNull();
    expect(airtableStyle([])).toBeNull();
    expect(airtableStyle(true)).toBe(true);
    expect(airtableStyle(['a'])).toEqual(['a']);
  });

  it('isoInstantTruncatedTo reduces equivalent date strings to one truncated instant', () => {
    const toMinute = isoInstantTruncatedTo('minute');
    expect(toMinute('2026-07-23T21:12:27Z')).toBe(toMinute('2026-07-23T21:12:00.000+00:00'));
    expect(toMinute('2026-07-23T21:12:27Z')).toBe(Date.parse('2026-07-23T21:12:00.000Z'));
    expect(toMinute('2026-07-23T21:13:00Z')).not.toBe(toMinute('2026-07-23T21:12:59Z'));

    const toMillisecond = isoInstantTruncatedTo('millisecond');
    expect(toMillisecond('2026-07-23T21:12:27Z')).toBe(toMillisecond('2026-07-23T21:12:27.000+00:00'));
    expect(toMillisecond('2026-07-23T21:12:27.001Z')).not.toBe(toMillisecond('2026-07-23T21:12:27Z'));

    const toDay = isoInstantTruncatedTo('day');
    expect(toDay('2026-12-25')).toBe(toDay('2026-12-25T00:00:00.000Z'));
    expect(toDay('2026-12-25')).toBe(toDay('2026-12-25T15:09:26.535Z'));

    expect(toMinute('not a date')).toBe('not a date');
    expect(toMinute('')).toBe('');
    expect(toMinute(null)).toBeNull();
    expect(toMinute(42)).toBe(42);
  });

  it('numberRoundedToSignificantDigits makes float64 round-trip noise equal and passes other values through', () => {
    const round15 = numberRoundedToSignificantDigits(15);
    expect(round15(0.1 + 0.2)).toBe(round15(0.3));
    expect(round15(1.5)).toBe(1.5);
    expect(round15(1.5)).not.toBe(round15(1.6));
    expect(round15('1.5')).toBe('1.5');
    expect(round15(Number.NaN)).toBeNaN();
    expect(round15(null)).toBeNull();

    const parsing = numberRoundedToSignificantDigits(15, { parseNumericStrings: true });
    expect(parsing('0.30000000000000004')).toBe(parsing(0.3));
    expect(parsing('abc')).toBe('abc');
  });

  it('decimalTextNormalized normalises decimal literals as text without float precision loss', () => {
    const c = decimalTextNormalized();
    expect(c('1.50')).toBe('1.5');
    expect(c(1.5)).toBe('1.5');
    expect(c('+7')).toBe('7');
    expect(c('007')).toBe('7');
    expect(c('-0.0')).toBe('0');
    expect(c('-12.3400')).toBe('-12.34');
    expect(c('9007199254740993')).toBe('9007199254740993');
    expect(c('9007199254740993')).not.toBe(c('9007199254740994'));
    expect(c('abc')).toBe('abc');
    expect(c('1e5')).toBe('1e5');
    expect(c(null)).toBeNull();
  });

  it('parsedJsonText parses JSON objects/arrays in strings and passes everything else through', () => {
    const c = parsedJsonText();
    expect(c('{"a": 1, "b": [1,2]}')).toEqual({ a: 1, b: [1, 2] });
    expect(c('{"b":[1,2],"a":1}')).toEqual(c('{"a":1,"b":[1,2]}'));
    expect(c('[1, 2]')).toEqual([1, 2]);
    expect(c('plain text')).toBe('plain text');
    expect(c('{not json')).toBe('{not json');
    expect(c({ already: 'object' })).toEqual({ already: 'object' });
  });

  it('unpackedWithClientSafeTransformer applies a jsonpath unpack and passes through on failure or null', () => {
    const plainText = unpackedWithClientSafeTransformer({
      type: 'jsonpath',
      options: { expression: '$.title[*].plain_text', arrayHandling: 'concat' },
    });
    const decorated = {
      id: 'title',
      type: 'title',
      title: [
        {
          type: 'text',
          text: { content: 'get', link: null },
          annotations: {
            bold: false,
            italic: false,
            strikethrough: false,
            underline: false,
            code: false,
            color: 'default',
          },
          plain_text: 'get',
          href: null,
        },
        { type: 'text', text: { content: 'guru', link: null }, plain_text: 'guru', href: null },
      ],
    };
    const minimal = { type: 'title', title: [{ type: 'text', text: { content: 'getguru' }, plain_text: 'getguru' }] };
    expect(plainText(decorated)).toBe('getguru');
    expect(plainText(minimal)).toBe('getguru');
    expect(plainText(null)).toBeNull();
    expect(plainText(undefined)).toBeUndefined();
  });

  it('pickedAndCanonicalized canonicalises exactly the listed keys, treating absent keys as undefined', () => {
    const notionDate = pickedAndCanonicalized({
      start: composeCanonicalizers(isoInstantTruncatedTo('minute'), emptyAsNull()),
      end: composeCanonicalizers(isoInstantTruncatedTo('minute'), emptyAsNull()),
      time_zone: emptyAsNull(),
    });
    expect(notionDate({ start: '2026-07-23T21:12:27Z' })).toEqual(
      notionDate({ start: '2026-07-23T21:12:00.000+00:00', end: null, time_zone: null }),
    );
    expect(notionDate({ start: '2026-07-23T21:12:27Z' })).not.toEqual(notionDate({ start: '2026-07-24T21:12:27Z' }));
    expect(notionDate(null)).toBeNull();
    expect(notionDate('2026-07-23')).toBe('2026-07-23');

    const keepTimeZoneAsIs = pickedAndCanonicalized({ time_zone: asIs });
    expect(keepTimeZoneAsIs({ time_zone: 'Europe/Berlin', extra: 1 })).toEqual({ time_zone: 'Europe/Berlin' });
  });
});
