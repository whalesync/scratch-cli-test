import {
  X_SCRATCH_FOREIGN_KEY_OPTIONS,
  X_SCRATCH_LAST_MODIFIED_FIELD,
  X_SCRATCH_READONLY,
  X_SCRATCH_REMOTE_FIELD_ID,
} from '@spinner/shared-types';
import {
  buildZohoJsonTableSpec,
  isReadonlyZohoField,
  sanitizeZohoWritePayload,
  zohoFieldToJsonSchema,
} from '../zoho-json-schema';
import { ZohoFieldMetadata } from '../zoho-types';

function makeField(overrides: Partial<ZohoFieldMetadata> & { api_name: string; data_type: string }): ZohoFieldMetadata {
  return { field_label: overrides.api_name, json_type: 'string', ...overrides };
}

/** A field schema's annotations live as top-level keys on the (union) schema object. */
function ann(schema: unknown, key: string): unknown {
  return (schema as Record<string, unknown>)[key];
}

function propsOf(spec: { schema: unknown }): Record<string, Record<string, unknown>> {
  return (spec.schema as { properties: Record<string, Record<string, unknown>> }).properties;
}

describe('zohoFieldToJsonSchema — data_type mapping', () => {
  it('maps text / textarea / phone to nullable string', () => {
    for (const dt of ['text', 'textarea', 'phone']) {
      const json = JSON.stringify(zohoFieldToJsonSchema(makeField({ api_name: 'f', data_type: dt })));
      expect(json).toContain('"type":"string"');
      expect(json).toContain('"type":"null"');
    }
  });

  it('maps email and website to formatted strings', () => {
    expect(JSON.stringify(zohoFieldToJsonSchema(makeField({ api_name: 'Email', data_type: 'email' })))).toContain(
      '"format":"email"',
    );
    expect(JSON.stringify(zohoFieldToJsonSchema(makeField({ api_name: 'Web', data_type: 'website' })))).toContain(
      '"format":"uri"',
    );
  });

  it('maps boolean / integer / double / currency / percent to their primitives', () => {
    expect(JSON.stringify(zohoFieldToJsonSchema(makeField({ api_name: 'b', data_type: 'boolean' })))).toContain(
      '"type":"boolean"',
    );
    expect(JSON.stringify(zohoFieldToJsonSchema(makeField({ api_name: 'i', data_type: 'integer' })))).toContain(
      '"type":"integer"',
    );
    for (const dt of ['double', 'currency', 'percent']) {
      expect(JSON.stringify(zohoFieldToJsonSchema(makeField({ api_name: 'n', data_type: dt })))).toContain(
        '"type":"number"',
      );
    }
  });

  it('maps bigint to string to preserve precision', () => {
    const json = JSON.stringify(zohoFieldToJsonSchema(makeField({ api_name: 'big', data_type: 'bigint' })));
    expect(json).toContain('"type":"string"');
    expect(json).not.toContain('"type":"integer"');
  });

  it('maps date and datetime to formatted strings', () => {
    expect(JSON.stringify(zohoFieldToJsonSchema(makeField({ api_name: 'd', data_type: 'date' })))).toContain(
      '"format":"date"',
    );
    expect(JSON.stringify(zohoFieldToJsonSchema(makeField({ api_name: 'dt', data_type: 'datetime' })))).toContain(
      '"format":"date-time"',
    );
  });

  it('annotates a lookup with a single-target foreign key from lookup.module.api_name', () => {
    const schema = zohoFieldToJsonSchema(
      makeField({ api_name: 'Account_Name', data_type: 'lookup', lookup: { module: { api_name: 'Accounts' } } }),
    );
    expect(ann(schema, X_SCRATCH_FOREIGN_KEY_OPTIONS)).toEqual({ linkedTableId: 'Accounts' });
  });

  it('annotates owner/user lookups with a foreign key to users', () => {
    for (const dt of ['ownerlookup', 'userlookup']) {
      const schema = zohoFieldToJsonSchema(makeField({ api_name: 'Owner', data_type: dt }));
      expect(ann(schema, X_SCRATCH_FOREIGN_KEY_OPTIONS)).toEqual({ linkedTableId: 'users' });
    }
  });

  it('stores polymorphic (multimodulelookup) refs verbatim with NO foreign key', () => {
    const schema = zohoFieldToJsonSchema(makeField({ api_name: 'Parent_Id', data_type: 'multimodulelookup' }));
    expect(ann(schema, X_SCRATCH_FOREIGN_KEY_OPTIONS)).toBeUndefined();
  });

  it('builds a picklist enum from active values ordered by sequence_number', () => {
    const schema = zohoFieldToJsonSchema(
      makeField({
        api_name: 'Lead_Status',
        data_type: 'picklist',
        pick_list_values: [
          { actual_value: 'Contacted', sequence_number: 2, type: 'used' },
          { actual_value: 'New', sequence_number: 1, type: 'used' },
          { actual_value: 'Deprecated', sequence_number: 3, type: 'not used' },
        ],
      }),
    );
    const json = JSON.stringify(schema);
    expect(json).toContain('"const":"New"');
    expect(json).toContain('"const":"Contacted"');
    // 'not used' values are excluded.
    expect(json).not.toContain('"const":"Deprecated"');
    // Ordered by sequence_number: New (1) before Contacted (2).
    expect(json.indexOf('"const":"New"')).toBeLessThan(json.indexOf('"const":"Contacted"'));
  });

  it('falls back to verbatim for unknown data types', () => {
    const schema = zohoFieldToJsonSchema(makeField({ api_name: 'weird', data_type: 'some_future_type' }));
    expect(schema).toBeDefined();
  });
});

describe('isReadonlyZohoField', () => {
  it('treats audit fields (api_update=false) as read-only even when read_only=false', () => {
    expect(
      isReadonlyZohoField(
        makeField({
          api_name: 'Modified_Time',
          data_type: 'datetime',
          read_only: false,
          operation_type: { api_update: false },
        }),
      ),
    ).toBe(true);
  });

  it('treats formula / rollup / autonumber / asset types as read-only', () => {
    for (const dt of ['formula', 'rollup_summary', 'autonumber', 'profileimage']) {
      expect(isReadonlyZohoField(makeField({ api_name: 'f', data_type: dt }))).toBe(true);
    }
  });

  it('treats a normal writable field as not read-only', () => {
    expect(
      isReadonlyZohoField(
        makeField({ api_name: 'Last_Name', data_type: 'text', operation_type: { api_update: true } }),
      ),
    ).toBe(false);
  });
});

describe('buildZohoJsonTableSpec', () => {
  const fields: ZohoFieldMetadata[] = [
    makeField({ api_name: 'Last_Name', data_type: 'text', length: 80, operation_type: { api_update: true } }),
    makeField({ api_name: 'Modified_Time', data_type: 'datetime', operation_type: { api_update: false } }),
    makeField({ api_name: 'Account_Name', data_type: 'lookup', lookup: { module: { api_name: 'Accounts' } } }),
  ];
  const spec = buildZohoJsonTableSpec({ wsId: 'Leads', remoteId: ['Leads'] }, 'Leads', 'Leads', fields);

  it('adds an implicit read-only id field and uses it as the id column', () => {
    expect(propsOf(spec).id[X_SCRATCH_READONLY]).toBe(true);
    expect(spec.idColumnRemoteId).toBe('id');
  });

  it('annotates Modified_Time as the last-modified field and read-only', () => {
    expect(propsOf(spec).Modified_Time[X_SCRATCH_LAST_MODIFIED_FIELD]).toBe(true);
    expect(propsOf(spec).Modified_Time[X_SCRATCH_READONLY]).toBe(true);
  });

  it('records the remote field id and leaves writable fields un-readonly', () => {
    expect(propsOf(spec).Last_Name[X_SCRATCH_REMOTE_FIELD_ID]).toBe('Last_Name');
    expect(propsOf(spec).Last_Name[X_SCRATCH_READONLY]).toBeUndefined();
  });

  it('picks a sensible title column', () => {
    expect(spec.titleColumnRemoteId).toEqual(['Last_Name']);
  });
});

describe('sanitizeZohoWritePayload', () => {
  const fields: ZohoFieldMetadata[] = [
    makeField({ api_name: 'Last_Name', data_type: 'text', operation_type: { api_update: true } }),
    makeField({ api_name: 'Modified_Time', data_type: 'datetime', operation_type: { api_update: false } }),
    makeField({ api_name: 'Account_Name', data_type: 'lookup', lookup: { module: { api_name: 'Accounts' } } }),
  ];
  const spec = buildZohoJsonTableSpec({ wsId: 'Leads', remoteId: ['Leads'] }, 'Leads', 'Leads', fields);

  it('drops id and read-only fields and reduces a lookup to { id }', () => {
    const payload = sanitizeZohoWritePayload(
      {
        id: '6330685000000486408',
        Last_Name: 'Bob',
        Modified_Time: '2026-06-04T00:00:00+00:00',
        Account_Name: { id: '9', name: 'Acme' },
      },
      spec,
    );
    expect(payload).toEqual({ Last_Name: 'Bob', Account_Name: { id: '9' } });
  });

  it('writes null for a cleared lookup', () => {
    const payload = sanitizeZohoWritePayload({ id: '1', Account_Name: null }, spec);
    expect(payload).toEqual({ Account_Name: null });
  });
});
