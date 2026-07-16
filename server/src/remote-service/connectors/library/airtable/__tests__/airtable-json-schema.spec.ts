import { Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import {
  X_SCRATCH_FOREIGN_KEY_OPTIONS,
  X_SCRATCH_LAST_MODIFIED_FIELD,
  X_SCRATCH_READONLY,
} from '@spinner/shared-types';
import { BaseJsonTableSpec, dotPath } from '../../../types';
import {
  airtableFieldToJsonSchema,
  getForeignKeyOptions,
  isForeignKey,
  isReadonlyField,
} from '../airtable-json-schema';
import { AirtableDataType, AirtableFieldsV2 } from '../airtable-types';

// Regression for DEV-10126. Airtable field names are user-typed and frequently
// contain `/` (e.g. `Date/heure de création`). Per RFC 6901 §3 these must be
// escaped before being interpolated into a JSON Pointer — otherwise the
// readonly / FK lookups walk the wrong sub-tree and silently return false.
describe('airtable JSON Pointer escaping (RFC 6901)', () => {
  const fieldWithSlash = 'Date/heure de création';
  const fieldWithTilde = 'priority~note';
  const fkOptions = { linkedTableId: 'tblOther' };

  function buildSpec(): BaseJsonTableSpec {
    return {
      id: { wsId: 't', remoteId: ['t'] },
      slug: 't',
      name: 't',
      schema: Type.Object({
        fields: Type.Object({
          [fieldWithSlash]: Type.String({
            [X_SCRATCH_READONLY]: true,
            [X_SCRATCH_FOREIGN_KEY_OPTIONS]: fkOptions,
          }),
          [fieldWithTilde]: Type.String({ [X_SCRATCH_READONLY]: true }),
        }),
      }),
      idPath: dotPath('id'),
    };
  }

  it('isReadonlyField handles field names containing `/`', () => {
    expect(isReadonlyField(fieldWithSlash, buildSpec())).toBe(true);
  });

  it('isReadonlyField handles field names containing `~`', () => {
    expect(isReadonlyField(fieldWithTilde, buildSpec())).toBe(true);
  });

  it('isForeignKey handles field names containing `/`', () => {
    expect(isForeignKey(fieldWithSlash, buildSpec())).toBe(true);
  });

  // Regression for DEV-10805: isForeignKey used to compare the boolean result
  // of ValuePointer.Has against `undefined`, so it always returned true.
  it('isForeignKey returns false for a non-foreign-key field', () => {
    expect(isForeignKey(fieldWithTilde, buildSpec())).toBe(false);
  });

  it('getForeignKeyOptions handles field names containing `/`', () => {
    expect(getForeignKeyOptions(fieldWithSlash, buildSpec())).toEqual(fkOptions);
  });
});

describe('airtableFieldToJsonSchema last-modified annotation', () => {
  it('annotates lastModifiedTime fields with x-scratch-last-modified-field=true', () => {
    const schema = airtableFieldToJsonSchema({
      id: 'fldLM',
      name: 'Last Modified Time',
      type: AirtableDataType.LAST_MODIFIED_TIME,
    });
    expect((schema as unknown as Record<string, unknown>)[X_SCRATCH_LAST_MODIFIED_FIELD]).toBe(true);
  });

  it('does not annotate other field types', () => {
    const schema = airtableFieldToJsonSchema({
      id: 'fldName',
      name: 'Name',
      type: AirtableDataType.SINGLE_LINE_TEXT,
    });
    expect((schema as unknown as Record<string, unknown>)[X_SCRATCH_LAST_MODIFIED_FIELD]).toBeUndefined();
  });
});

// A createdTime / lastModifiedTime field configured without a time component
// returns date-only "YYYY-MM-DD" from Airtable, which fails a `date-time` format
// check. The emitted format must follow the field's configured result type.
describe('airtableFieldToJsonSchema date vs date-time format', () => {
  function formatOf(schema: ReturnType<typeof airtableFieldToJsonSchema>): unknown {
    return (schema as unknown as Record<string, unknown>).format;
  }

  it('createdTime configured date-only emits format "date"', () => {
    const schema = airtableFieldToJsonSchema({
      id: 'fldC',
      name: 'Created',
      type: AirtableDataType.CREATED_TIME,
      options: { isReversed: false, result: { id: 'r', name: 'r', type: AirtableDataType.DATE } },
    });
    expect(formatOf(schema)).toBe('date');
  });

  it('createdTime configured with time emits format "date-time"', () => {
    const schema = airtableFieldToJsonSchema({
      id: 'fldC',
      name: 'Created',
      type: AirtableDataType.CREATED_TIME,
      options: { isReversed: false, result: { id: 'r', name: 'r', type: AirtableDataType.DATE_TIME } },
    });
    expect(formatOf(schema)).toBe('date-time');
  });

  it('createdTime with no result option falls back to "date-time"', () => {
    const schema = airtableFieldToJsonSchema({
      id: 'fldC',
      name: 'Created',
      type: AirtableDataType.CREATED_TIME,
    });
    expect(formatOf(schema)).toBe('date-time');
  });

  it('lastModifiedTime configured date-only emits format "date"', () => {
    const schema = airtableFieldToJsonSchema({
      id: 'fldL',
      name: 'Modified',
      type: AirtableDataType.LAST_MODIFIED_TIME,
      options: { isReversed: false, result: { id: 'r', name: 'r', type: AirtableDataType.DATE } },
    });
    expect(formatOf(schema)).toBe('date');
  });

  it('lastModifiedTime configured with time emits format "date-time"', () => {
    const schema = airtableFieldToJsonSchema({
      id: 'fldL',
      name: 'Modified',
      type: AirtableDataType.LAST_MODIFIED_TIME,
      options: { isReversed: false, result: { id: 'r', name: 'r', type: AirtableDataType.DATE_TIME } },
    });
    expect(formatOf(schema)).toBe('date-time');
  });

  it('plain dateTime field emits format "date-time"', () => {
    const schema = airtableFieldToJsonSchema({ id: 'fldD', name: 'When', type: AirtableDataType.DATE_TIME });
    expect(formatOf(schema)).toBe('date-time');
  });

  it('date field emits format "date"', () => {
    const schema = airtableFieldToJsonSchema({ id: 'fldD', name: 'Day', type: AirtableDataType.DATE });
    expect(formatOf(schema)).toBe('date');
  });
});

// DEV-10652. Some Airtable values are JSON objects, not scalars: aiText fields
// (direct + looked-up) return { state, value, isStale }, and formula/rollup/lookup
// fields that error return { error: "#ERROR!" } (or { specialValue: "NaN" }). The
// generated schema must accept these verbatim shapes or `enforce_schema` rejects
// every record with `{…} is not of type "string"`. Values below are verbatim from
// the customer "Field Guide" workspace.
describe('airtableFieldToJsonSchema object-valued conformance (DEV-10652)', () => {
  const field = (type: AirtableDataType, resultType?: AirtableDataType): AirtableFieldsV2 =>
    resultType
      ? { id: 'fld', name: 'f', type, options: { isReversed: false, result: { id: 'r', name: 'r', type: resultType } } }
      : { id: 'fld', name: 'f', type };

  const aiGenerated = { state: 'generated', value: 'hello', isStale: true };
  const aiEmpty = { state: 'empty', value: null, isStale: false };
  const formulaError = { error: '#ERROR!' };
  const specialValue = { specialValue: 'NaN' };

  describe('direct aiText field', () => {
    const schema = airtableFieldToJsonSchema(field(AirtableDataType.AI_TEXT));

    it('accepts a generated value object', () => expect(Value.Check(schema, aiGenerated)).toBe(true));
    it('accepts an empty value object (value null)', () => expect(Value.Check(schema, aiEmpty)).toBe(true));
    it('tolerates extra keys (e.g. errorType on failed generations)', () =>
      expect(Value.Check(schema, { ...aiGenerated, errorType: 'timeout' })).toBe(true));
    it('rejects a bare scalar', () => {
      expect(Value.Check(schema, 42)).toBe(false);
      expect(Value.Check(schema, 'just a string')).toBe(false);
    });
    it('is annotated readonly', () =>
      expect((schema as unknown as Record<string, unknown>)[X_SCRATCH_READONLY]).toBe(true));
  });

  describe('lookup resolving to aiText (the 2,140-error case)', () => {
    const schema = airtableFieldToJsonSchema(field(AirtableDataType.MULTIPLE_LOOKUP_VALUES, AirtableDataType.AI_TEXT));

    it('accepts the verbatim array of aiText objects', () =>
      expect(Value.Check(schema, [aiGenerated, aiEmpty])).toBe(true));
    it('rejects a non-object array item', () => expect(Value.Check(schema, [123])).toBe(false));
  });

  describe('lookup resolving to singleLineText', () => {
    const schema = airtableFieldToJsonSchema(
      field(AirtableDataType.MULTIPLE_LOOKUP_VALUES, AirtableDataType.SINGLE_LINE_TEXT),
    );

    it('still accepts plain string items', () => expect(Value.Check(schema, ['a', 'b'])).toBe(true));
    it('accepts a per-item error object', () => expect(Value.Check(schema, [formulaError])).toBe(true));
  });

  describe.each([AirtableDataType.FORMULA, AirtableDataType.ROLLUP, AirtableDataType.LOOKUP])(
    '%s with singleLineText result (the 16-error case)',
    (type) => {
      const schema = airtableFieldToJsonSchema(field(type, AirtableDataType.SINGLE_LINE_TEXT));

      it('accepts { error: "#ERROR!" }', () => expect(Value.Check(schema, formulaError)).toBe(true));
      it('accepts the legacy { specialValue } shape', () => expect(Value.Check(schema, specialValue)).toBe(true));
      it('accepts a normal string', () => expect(Value.Check(schema, 'Join Us')).toBe(true));
      it('still rejects a wrong-type scalar', () => expect(Value.Check(schema, 42)).toBe(false));
    },
  );

  describe('formula with checkbox result', () => {
    const schema = airtableFieldToJsonSchema(field(AirtableDataType.FORMULA, AirtableDataType.CHECKBOX));

    it('accepts an error object', () => expect(Value.Check(schema, formulaError)).toBe(true));
    it('accepts a boolean', () => expect(Value.Check(schema, true)).toBe(true));
    it('rejects a string', () => expect(Value.Check(schema, 'nope')).toBe(false));
  });

  describe('formula with number result', () => {
    const schema = airtableFieldToJsonSchema(field(AirtableDataType.FORMULA, AirtableDataType.NUMBER));

    it('accepts the broadened { error } shape', () => expect(Value.Check(schema, formulaError)).toBe(true));
    it('accepts a number', () => expect(Value.Check(schema, 123)).toBe(true));
  });
});
