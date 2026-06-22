import { Type } from '@sinclair/typebox';
import {
  X_SCRATCH_FOREIGN_KEY_OPTIONS,
  X_SCRATCH_LAST_MODIFIED_FIELD,
  X_SCRATCH_READONLY,
} from '@spinner/shared-types';
import { BaseJsonTableSpec, idPath } from '../../../types';
import {
  airtableFieldToJsonSchema,
  getForeignKeyOptions,
  isForeignKey,
  isReadonlyField,
} from '../airtable-json-schema';
import { AirtableDataType } from '../airtable-types';

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
      idColumnRemoteId: idPath('id'),
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
