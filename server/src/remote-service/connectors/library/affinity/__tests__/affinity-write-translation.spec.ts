import { X_SCRATCH_CONNECTOR_DATA_TYPE, X_SCRATCH_READONLY } from '@spinner/shared-types';
import { AffinityError } from '../affinity-api-client';
import {
  buildCompanyBasicsUpdatePayload,
  buildCompanyCreatePayload,
  buildFieldValueUpdatesForChangedRecord,
  buildNonEmptyFieldValueUpdatesForNewRecord,
  buildNoteCreateRequestFromRecordFile,
  buildOpportunityBasicsUpdatePayload,
  buildOpportunityCreatePayload,
  buildPersonBasicsUpdatePayload,
  buildPersonCreatePayload,
  COMPANY_WRITABLE_BASIC_KEYS,
  extractDynamicFieldSchemasByFieldId,
  isReadOnlyAffinityField,
  PERSON_WRITABLE_BASIC_KEYS,
  splitChangedRecordIntoBasicsAndFields,
  translateStoredFieldValueToWritePayload,
} from '../affinity-write-translation';

describe('isReadOnlyAffinityField', () => {
  it('treats enriched and relationship-intelligence categories as read-only', () => {
    expect(isReadOnlyAffinityField('enriched', 'text')).toBe(true);
    expect(isReadOnlyAffinityField('relationship-intelligence', 'interaction')).toBe(true);
  });

  it('treats interaction and formula-number value types as read-only even in writable categories', () => {
    expect(isReadOnlyAffinityField('list', 'interaction')).toBe(true);
    expect(isReadOnlyAffinityField('global', 'formula-number')).toBe(true);
  });

  it('treats list/global fields with writable value types as writable', () => {
    expect(isReadOnlyAffinityField('list', 'text')).toBe(false);
    expect(isReadOnlyAffinityField('global', 'dropdown')).toBe(false);
  });
});

describe('translateStoredFieldValueToWritePayload', () => {
  it('passes primitive values through unchanged', () => {
    expect(translateStoredFieldValueToWritePayload('text', { type: 'text', data: 'hello' })).toEqual({
      type: 'text',
      data: 'hello',
    });
    expect(translateStoredFieldValueToWritePayload('number', { type: 'number', data: 42.5 })).toEqual({
      type: 'number',
      data: 42.5,
    });
    expect(
      translateStoredFieldValueToWritePayload('datetime', { type: 'datetime', data: '2023-01-26T08:00:00Z' }),
    ).toEqual({ type: 'datetime', data: '2023-01-26T08:00:00Z' });
  });

  it('builds a null-data clear payload when the stored value is null', () => {
    expect(translateStoredFieldValueToWritePayload('text', null)).toEqual({ type: 'text', data: null });
    expect(translateStoredFieldValueToWritePayload('dropdown', null)).toEqual({ type: 'dropdown', data: null });
  });

  it('narrows a read-shaped dropdown value to {dropdownOptionId} only', () => {
    const storedReadShapedValue = {
      type: 'ranked-dropdown',
      data: { dropdownOptionId: 16915668, text: 'In Progress', rank: 1, color: 'green' },
    };
    expect(translateStoredFieldValueToWritePayload('ranked-dropdown', storedReadShapedValue)).toEqual({
      type: 'ranked-dropdown',
      data: { dropdownOptionId: 16915668 },
    });
  });

  it('narrows a read-shaped person/company reference to {id} only', () => {
    const storedPersonValue = {
      type: 'person',
      data: { id: 153926540, firstName: 'Whalesync', lastName: 'Testing', primaryEmailAddress: 'x@y.com' },
    };
    expect(translateStoredFieldValueToWritePayload('person', storedPersonValue)).toEqual({
      type: 'person',
      data: { id: 153926540 },
    });

    const storedCompanyMultiValue = {
      type: 'company-multi',
      totalCount: 2,
      data: [
        { id: 1, name: 'A', domain: 'a.com' },
        { id: 2, name: 'B', domain: 'b.com' },
      ],
    };
    expect(translateStoredFieldValueToWritePayload('company-multi', storedCompanyMultiValue)).toEqual({
      type: 'company-multi',
      data: [{ id: 1 }, { id: 2 }],
    });
  });

  it('keeps only the five Location write keys', () => {
    const storedLocationValue = {
      type: 'location',
      data: { streetAddress: null, city: 'Detroit', state: 'Michigan', country: 'United States', continent: null },
    };
    expect(translateStoredFieldValueToWritePayload('location', storedLocationValue)).toEqual({
      type: 'location',
      data: { streetAddress: null, city: 'Detroit', state: 'Michigan', country: 'United States', continent: null },
    });
  });

  it('refuses to write a truncated multi-value read (totalCount > values present)', () => {
    const truncatedMultiValue = { type: 'person-multi', totalCount: 150, data: [{ id: 1 }, { id: 2 }] };
    expect(() => translateStoredFieldValueToWritePayload('person-multi', truncatedMultiValue)).toThrow(
      /truncated multi-value/,
    );
  });

  it('refuses computed value types', () => {
    expect(() => translateStoredFieldValueToWritePayload('interaction', { type: 'interaction', data: {} })).toThrow(
      AffinityError,
    );
    expect(() =>
      translateStoredFieldValueToWritePayload('formula-number', { type: 'formula-number', data: 1 }),
    ).toThrow(AffinityError);
  });

  it('refuses a reference value missing its id key', () => {
    expect(() =>
      translateStoredFieldValueToWritePayload('dropdown', { type: 'dropdown', data: { text: 'No id here' } }),
    ).toThrow(/dropdownOptionId/);
  });
});

// ---------------------------------------------------------------------------
// buildFieldValueUpdatesForChangedRecord
// ---------------------------------------------------------------------------

function buildTestTableSpecSchema(recordHasEntityWrapper: boolean): Record<string, unknown> {
  const fieldsObjectSchema = {
    properties: {
      'field-1': {
        description: 'Stage',
        [X_SCRATCH_CONNECTOR_DATA_TYPE]: 'ranked-dropdown',
      },
      'field-2': {
        description: 'Amount',
        [X_SCRATCH_CONNECTOR_DATA_TYPE]: 'number',
      },
      'affinity-data-growth': {
        description: 'Growth',
        [X_SCRATCH_CONNECTOR_DATA_TYPE]: 'number',
        [X_SCRATCH_READONLY]: true,
      },
    },
  };
  if (recordHasEntityWrapper) {
    return { properties: { entity: { properties: { fields: fieldsObjectSchema } } } };
  }
  return { properties: { fields: fieldsObjectSchema } };
}

const STORED_STAGE_VALUE = { type: 'ranked-dropdown', data: { dropdownOptionId: 99, text: 'Won', rank: 3 } };
const STORED_AMOUNT_VALUE = { type: 'number', data: 5000 };

function buildTestRecordFile(recordHasEntityWrapper: boolean): Record<string, unknown> {
  const fields = {
    'field-1': { id: 'field-1', name: 'Stage', type: 'list', enrichmentSource: null, value: STORED_STAGE_VALUE },
    'field-2': { id: 'field-2', name: 'Amount', type: 'list', enrichmentSource: null, value: STORED_AMOUNT_VALUE },
    'affinity-data-growth': {
      id: 'affinity-data-growth',
      name: 'Growth',
      type: 'enriched',
      enrichmentSource: 'affinity-data',
      value: { type: 'number', data: 0.4 },
    },
  };
  if (recordHasEntityWrapper) {
    return { id: 7, type: 'opportunity', listId: 1, entity: { id: 8, name: 'Deal', fields } };
  }
  return { id: 7, firstName: 'Ada', fields };
}

describe('buildFieldValueUpdatesForChangedRecord', () => {
  it('builds updates only for the changed field ids, reading full values off the record file', () => {
    // Deep-sparse diff that only touched value.data — the payload must still
    // carry the full {type, data} from the file.
    const updates = buildFieldValueUpdatesForChangedRecord({
      changedRecordSparseObject: { fields: { 'field-1': { value: { data: { dropdownOptionId: 99 } } } } },
      fullRecordFile: buildTestRecordFile(false),
      tableSpecSchema: buildTestTableSpecSchema(false),
      recordHasEntityWrapper: false,
    });
    expect(updates).toEqual([{ id: 'field-1', value: { type: 'ranked-dropdown', data: { dropdownOptionId: 99 } } }]);
  });

  it('handles the entity wrapper on list entries', () => {
    const updates = buildFieldValueUpdatesForChangedRecord({
      changedRecordSparseObject: { entity: { fields: { 'field-2': { value: { data: 6000 } } } } },
      fullRecordFile: buildTestRecordFile(true),
      tableSpecSchema: buildTestTableSpecSchema(true),
      recordHasEntityWrapper: true,
    });
    expect(updates).toEqual([{ id: 'field-2', value: { type: 'number', data: 5000 } }]);
  });

  it('throws when a changed path falls outside the fields container (record basics)', () => {
    expect(() =>
      buildFieldValueUpdatesForChangedRecord({
        changedRecordSparseObject: { firstName: 'Renamed' },
        fullRecordFile: buildTestRecordFile(false),
        tableSpecSchema: buildTestTableSpecSchema(false),
        recordHasEntityWrapper: false,
      }),
    ).toThrow(/firstName/);

    expect(() =>
      buildFieldValueUpdatesForChangedRecord({
        changedRecordSparseObject: { entity: { name: 'Renamed Deal' } },
        fullRecordFile: buildTestRecordFile(true),
        tableSpecSchema: buildTestTableSpecSchema(true),
        recordHasEntityWrapper: true,
      }),
    ).toThrow(/entity\.name/);
  });

  it('throws when a changed field is labeled read-only (computed/enriched)', () => {
    expect(() =>
      buildFieldValueUpdatesForChangedRecord({
        changedRecordSparseObject: { fields: { 'affinity-data-growth': { value: { data: 1 } } } },
        fullRecordFile: buildTestRecordFile(false),
        tableSpecSchema: buildTestTableSpecSchema(false),
        recordHasEntityWrapper: false,
      }),
    ).toThrow(/computed by Affinity/);
  });

  it('throws when a changed field id is not in the schema', () => {
    expect(() =>
      buildFieldValueUpdatesForChangedRecord({
        changedRecordSparseObject: { fields: { 'field-unknown': { value: { data: 1 } } } },
        fullRecordFile: buildTestRecordFile(false),
        tableSpecSchema: buildTestTableSpecSchema(false),
        recordHasEntityWrapper: false,
      }),
    ).toThrow(/re-pull the table/);
  });

  it('falls back to re-sending every writable field when no diff is available', () => {
    const updates = buildFieldValueUpdatesForChangedRecord({
      changedRecordSparseObject: undefined,
      fullRecordFile: buildTestRecordFile(false),
      tableSpecSchema: buildTestTableSpecSchema(false),
      recordHasEntityWrapper: false,
    });
    // The enriched (read-only) field is skipped; the two writable fields are sent.
    expect(updates.map((u) => u.id).sort()).toEqual(['field-1', 'field-2']);
  });
});

describe('extractDynamicFieldSchemasByFieldId', () => {
  it('reads fields at top level for tenant tables and under entity for list entries', () => {
    expect(Object.keys(extractDynamicFieldSchemasByFieldId(buildTestTableSpecSchema(false), false))).toContain(
      'field-1',
    );
    expect(Object.keys(extractDynamicFieldSchemasByFieldId(buildTestTableSpecSchema(true), true))).toContain('field-2');
    expect(extractDynamicFieldSchemasByFieldId({ properties: {} }, false)).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// buildNoteCreateRequestFromRecordFile
// ---------------------------------------------------------------------------

describe('buildNoteCreateRequestFromRecordFile', () => {
  it('builds an entities-type create request from content.html and preview ids', () => {
    const request = buildNoteCreateRequestFromRecordFile({
      content: { html: '<p>Hi</p>' },
      personsPreview: { data: [{ id: 11, firstName: 'A' }], totalCount: 1 },
      companiesPreview: { data: [{ id: 22, name: 'B' }], totalCount: 1 },
    });
    expect(request).toEqual({
      type: 'entities',
      content: { html: '<p>Hi</p>' },
      persons: [{ id: 11 }],
      companies: [{ id: 22 }],
    });
  });

  it('requires non-empty content.html', () => {
    expect(() => buildNoteCreateRequestFromRecordFile({ personsPreview: { data: [{ id: 1 }] } })).toThrow(
      /content\.html/,
    );
  });

  it('requires at least one association', () => {
    expect(() => buildNoteCreateRequestFromRecordFile({ content: { html: '<p>Hi</p>' } })).toThrow(
      /at least one person, company, or opportunity/,
    );
  });
});

// ---------------------------------------------------------------------------
// v1 record-lifecycle payload builders (DEV-10298 phase 2)
// ---------------------------------------------------------------------------

describe('buildPersonCreatePayload', () => {
  it('maps v2 basics to the v1 snake_case create body', () => {
    expect(
      buildPersonCreatePayload({
        firstName: 'Ada',
        lastName: 'Lovelace',
        emailAddresses: ['ada@example.com', 'a@x.com'],
      }),
    ).toEqual({ first_name: 'Ada', last_name: 'Lovelace', emails: ['ada@example.com', 'a@x.com'] });
  });

  it('falls back to primaryEmailAddress when emailAddresses is absent', () => {
    expect(buildPersonCreatePayload({ firstName: 'Ada', primaryEmailAddress: 'ada@example.com' })).toEqual({
      first_name: 'Ada',
      last_name: null,
      emails: ['ada@example.com'],
    });
  });

  it('throws when there is no name and no email', () => {
    expect(() => buildPersonCreatePayload({})).toThrow(/first\/last name or an email/);
  });
});

describe('buildCompanyCreatePayload', () => {
  it('maps name + domain', () => {
    expect(buildCompanyCreatePayload({ name: 'Acme', domain: 'acme.com' })).toEqual({
      name: 'Acme',
      domain: 'acme.com',
    });
  });

  it('throws without a name', () => {
    expect(() => buildCompanyCreatePayload({ domain: 'acme.com' })).toThrow(/needs a "name"/);
  });
});

describe('buildOpportunityCreatePayload', () => {
  it('maps name + listId → list_id', () => {
    expect(buildOpportunityCreatePayload({ name: 'Deal', listId: 204872 })).toEqual({
      name: 'Deal',
      list_id: 204872,
    });
  });

  it('throws without a numeric listId', () => {
    expect(() => buildOpportunityCreatePayload({ name: 'Deal' })).toThrow(/listId/);
  });
});

describe('splitChangedRecordIntoBasicsAndFields', () => {
  it('separates writable basics from the fields container', () => {
    const result = splitChangedRecordIntoBasicsAndFields(
      { firstName: 'New', fields: { 'field-1': { value: { data: 'x' } } } },
      PERSON_WRITABLE_BASIC_KEYS,
    );
    expect(result.basicsChanged).toEqual({ firstName: 'New' });
    expect(result.fieldsChangedSparse).toEqual({ fields: { 'field-1': { value: { data: 'x' } } } });
  });

  it('throws on a changed top-level key that is neither a writable basic nor fields', () => {
    expect(() =>
      splitChangedRecordIntoBasicsAndFields({ primaryEmailAddress: 'x@y.com' }, PERSON_WRITABLE_BASIC_KEYS),
    ).toThrow(/not writable/);
    expect(() => splitChangedRecordIntoBasicsAndFields({ type: 'internal' }, PERSON_WRITABLE_BASIC_KEYS)).toThrow(
      /type/,
    );
  });

  it('honors per-table writable sets (company allows name/domain, not firstName)', () => {
    expect(splitChangedRecordIntoBasicsAndFields({ name: 'Acme2' }, COMPANY_WRITABLE_BASIC_KEYS).basicsChanged).toEqual(
      {
        name: 'Acme2',
      },
    );
    expect(() => splitChangedRecordIntoBasicsAndFields({ firstName: 'x' }, COMPANY_WRITABLE_BASIC_KEYS)).toThrow(
      /firstName/,
    );
  });
});

describe('basics update builders', () => {
  it('builds a sparse person basics body (only changed keys)', () => {
    expect(buildPersonBasicsUpdatePayload({ firstName: 'Ada' })).toEqual({ first_name: 'Ada' });
    expect(buildPersonBasicsUpdatePayload({ emailAddresses: ['a@x.com'] })).toEqual({ emails: ['a@x.com'] });
    expect(buildPersonBasicsUpdatePayload({})).toBeNull();
  });

  it('builds a sparse company basics body', () => {
    expect(buildCompanyBasicsUpdatePayload({ domain: 'acme.io' })).toEqual({ domain: 'acme.io' });
    expect(buildCompanyBasicsUpdatePayload({})).toBeNull();
  });

  it('builds an opportunity name body and refuses to clear the name', () => {
    expect(buildOpportunityBasicsUpdatePayload({ name: 'Renamed' })).toEqual({ name: 'Renamed' });
    expect(buildOpportunityBasicsUpdatePayload({})).toBeNull();
    expect(() => buildOpportunityBasicsUpdatePayload({ name: null })).toThrow(/must have a name/);
  });
});

describe('buildNonEmptyFieldValueUpdatesForNewRecord', () => {
  it('includes only fields with a non-empty value', () => {
    const schema = {
      properties: {
        fields: {
          properties: {
            'field-set': { description: 'Set', [X_SCRATCH_CONNECTOR_DATA_TYPE]: 'text' },
            'field-empty': { description: 'Empty', [X_SCRATCH_CONNECTOR_DATA_TYPE]: 'text' },
          },
        },
      },
    };
    const file = {
      id: 1,
      fields: {
        'field-set': { id: 'field-set', value: { type: 'text', data: 'hi' } },
        'field-empty': { id: 'field-empty', value: { type: 'text', data: null } },
      },
    };
    const updates = buildNonEmptyFieldValueUpdatesForNewRecord({
      fullRecordFile: file,
      tableSpecSchema: schema,
      recordHasEntityWrapper: false,
    });
    expect(updates.map((u) => u.id)).toEqual(['field-set']);
  });
});
