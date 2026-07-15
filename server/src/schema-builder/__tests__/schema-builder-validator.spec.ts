import { createSchemaTablesSchema, SchemaCreationCapabilities } from '@spinner/shared-types';
import {
  formatIssuePath,
  validateForeignKeyTargetsResolved,
  validateNamesAgainstExisting,
  validateTableForeignKeyTargetsResolved,
  validateTablesAgainstCapabilities,
  zodErrorToValidateIssues,
} from '../schema-builder-validator';

/** Parse a raw body and return the dry-run issue codes (or [] if valid). */
function issueCodes(body: unknown): string[] {
  const parsed = createSchemaTablesSchema.safeParse(body);
  if (parsed.success) return [];
  return zodErrorToValidateIssues(parsed.error).map((issue) => issue.code);
}

const validRequest = {
  connectorAccountId: 'conn_1',
  tables: [
    {
      ref: 't1',
      name: 'Posts',
      fields: [
        { name: 'Title', fieldType: { kind: 'text' }, isPrimary: true },
        { name: 'Count', fieldType: { kind: 'number', format: 'integer' } },
      ],
    },
  ],
};

describe('createSchemaTablesSchema (zod contract)', () => {
  it('accepts a well-formed request', () => {
    expect(createSchemaTablesSchema.safeParse(validRequest).success).toBe(true);
  });

  it('rejects duplicate field names case-insensitively', () => {
    const codes = issueCodes({
      ...validRequest,
      tables: [
        {
          ref: 't1',
          name: 'Posts',
          fields: [
            { name: 'Title', fieldType: { kind: 'text' } },
            { name: 'title', fieldType: { kind: 'text' } },
          ],
        },
      ],
    });
    expect(codes).toContain('DUPLICATE_FIELD_NAME');
  });

  it('rejects more than one primary field', () => {
    const codes = issueCodes({
      ...validRequest,
      tables: [
        {
          ref: 't1',
          name: 'Posts',
          fields: [
            { name: 'A', fieldType: { kind: 'text' }, isPrimary: true },
            { name: 'B', fieldType: { kind: 'text' }, isPrimary: true },
          ],
        },
      ],
    });
    expect(codes).toContain('MULTIPLE_PRIMARY_FIELDS');
  });

  it('rejects duplicate table refs', () => {
    const codes = issueCodes({
      ...validRequest,
      tables: [
        { ref: 'dup', name: 'A', fields: [{ name: 'x', fieldType: { kind: 'text' } }] },
        { ref: 'dup', name: 'B', fields: [{ name: 'y', fieldType: { kind: 'text' } }] },
      ],
    });
    expect(codes).toContain('DUPLICATE_TABLE_REF');
  });

  it('rejects a foreignKey ref that matches no table in the request', () => {
    const codes = issueCodes({
      ...validRequest,
      tables: [
        {
          ref: 't1',
          name: 'Posts',
          fields: [{ name: 'Author', fieldType: { kind: 'foreignKey', target: { ref: 'missing' } } }],
        },
      ],
    });
    expect(codes).toContain('FK_UNKNOWN_REF');
  });

  it('accepts a foreignKey ref that matches a sibling table', () => {
    const result = createSchemaTablesSchema.safeParse({
      connectorAccountId: 'conn_1',
      tables: [
        { ref: 'authors', name: 'Authors', fields: [{ name: 'Name', fieldType: { kind: 'text' } }] },
        {
          ref: 'posts',
          name: 'Posts',
          fields: [{ name: 'Author', fieldType: { kind: 'foreignKey', target: { ref: 'authors' } } }],
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it('rejects a foreignKey target that sets both branches', () => {
    const result = createSchemaTablesSchema.safeParse({
      ...validRequest,
      tables: [
        {
          ref: 't1',
          name: 'Posts',
          fields: [
            { name: 'Author', fieldType: { kind: 'foreignKey', target: { ref: 't1', existingRemoteTableId: ['x'] } } },
          ],
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  it('rejects a select field with no options and with duplicate options', () => {
    expect(
      issueCodes({
        ...validRequest,
        tables: [{ ref: 't1', name: 'Posts', fields: [{ name: 'S', fieldType: { kind: 'select', options: [] } }] }],
      }),
    ).not.toHaveLength(0);

    expect(
      issueCodes({
        ...validRequest,
        tables: [
          {
            ref: 't1',
            name: 'Posts',
            fields: [{ name: 'S', fieldType: { kind: 'select', options: [{ name: 'A' }, { name: 'a' }] } }],
          },
        ],
      }),
    ).toContain('DUPLICATE_SELECT_OPTION');
  });

  it('rejects a currency field whose code is not ISO-4217', () => {
    expect(
      createSchemaTablesSchema.safeParse({
        ...validRequest,
        tables: [
          {
            ref: 't1',
            name: 'Posts',
            fields: [{ name: 'Price', fieldType: { kind: 'currency', currencyCode: 'usd' } }],
          },
        ],
      }).success,
    ).toBe(false);
  });

  it('rejects a foreignKey still carrying an unresolved (pending) target', () => {
    expect(
      issueCodes({
        ...validRequest,
        tables: [
          {
            ref: 't1',
            name: 'Posts',
            fields: [
              { name: 'Title', fieldType: { kind: 'text' }, isPrimary: true },
              {
                name: 'Author',
                fieldType: { kind: 'foreignKey', target: { unresolvedLinkedTableId: 'contacts' } },
              },
            ],
          },
        ],
      }),
    ).toContain('FK_TARGET_UNRESOLVED');
  });
});

describe('validateForeignKeyTargetsResolved', () => {
  it('flags only the pending foreignKey targets, leaving resolved ones alone', () => {
    const issues = validateForeignKeyTargetsResolved(
      [
        { name: 'Title', fieldType: { kind: 'text' } },
        { name: 'Owner', fieldType: { kind: 'foreignKey', target: { existingRemoteTableId: ['base', 'tbl'] } } },
        { name: 'Author', fieldType: { kind: 'foreignKey', target: { unresolvedLinkedTableId: 'contacts' } } },
      ],
      'fields',
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ code: 'FK_TARGET_UNRESOLVED', path: 'fields[2].fieldType.target' });
  });

  it('scans every table via validateTableForeignKeyTargetsResolved', () => {
    const issues = validateTableForeignKeyTargetsResolved({
      connectorAccountId: 'conn_1',
      tables: [
        { ref: 't1', name: 'A', fields: [{ name: 'Title', fieldType: { kind: 'text' } }] },
        {
          ref: 't2',
          name: 'B',
          fields: [{ name: 'Link', fieldType: { kind: 'foreignKey', target: { unresolvedLinkedTableId: 'x' } } }],
        },
      ],
    });
    expect(issues.map((issue) => issue.code)).toEqual(['FK_TARGET_UNRESOLVED']);
    expect(issues[0].path).toBe('tables[1].fields[0].fieldType.target');
  });
});

describe('validateTablesAgainstCapabilities', () => {
  const capabilities: SchemaCreationCapabilities = {
    supportedFieldKinds: ['text', 'number'],
    primaryField: {
      displayName: 'Primary field',
      description: 'A primary field is required.',
      kinds: ['text'],
      docsLink: { label: 'Learn more', url: 'https://example.test/primary-field' },
    },
    maxFieldNameLength: 10,
  };

  function parse(body: unknown) {
    const parsed = createSchemaTablesSchema.safeParse(body);
    if (!parsed.success) throw new Error('fixture should parse');
    return parsed.data;
  }

  it('flags an unsupported field kind', () => {
    const data = parse({
      connectorAccountId: 'c',
      tables: [
        {
          ref: 't1',
          name: 'T',
          fields: [
            { name: 'Title', fieldType: { kind: 'text' }, isPrimary: true },
            { name: 'Flag', fieldType: { kind: 'boolean' } },
          ],
        },
      ],
    });
    const codes = validateTablesAgainstCapabilities(data, capabilities).map((i) => i.code);
    expect(codes).toContain('UNSUPPORTED_FIELD_KIND');
  });

  it('flags a missing required primary field', () => {
    const data = parse({
      connectorAccountId: 'c',
      tables: [{ ref: 't1', name: 'T', fields: [{ name: 'Title', fieldType: { kind: 'text' } }] }],
    });
    const codes = validateTablesAgainstCapabilities(data, capabilities).map((i) => i.code);
    expect(codes).toContain('MISSING_PRIMARY_FIELD');
  });

  it('flags a primary field of a disallowed kind', () => {
    const data = parse({
      connectorAccountId: 'c',
      tables: [{ ref: 't1', name: 'T', fields: [{ name: 'N', fieldType: { kind: 'number' }, isPrimary: true }] }],
    });
    const codes = validateTablesAgainstCapabilities(data, capabilities).map((i) => i.code);
    // 'number' is supported but not an allowed primary kind.
    expect(codes).toContain('PRIMARY_FIELD_WRONG_KIND');
  });

  it('flags a field name longer than the connector limit', () => {
    const data = parse({
      connectorAccountId: 'c',
      tables: [
        {
          ref: 't1',
          name: 'T',
          fields: [{ name: 'ThisNameIsWayTooLong', fieldType: { kind: 'text' }, isPrimary: true }],
        },
      ],
    });
    const codes = validateTablesAgainstCapabilities(data, capabilities).map((i) => i.code);
    expect(codes).toContain('FIELD_NAME_TOO_LONG');
  });

  it('flags a table with more fields than the connector allows', () => {
    const capabilitiesWithFieldCap: SchemaCreationCapabilities = { ...capabilities, maxFieldsPerTable: 2 };
    const data = parse({
      connectorAccountId: 'c',
      tables: [
        {
          ref: 't1',
          name: 'T',
          fields: [
            { name: 'A', fieldType: { kind: 'text' }, isPrimary: true },
            { name: 'B', fieldType: { kind: 'text' } },
            { name: 'C', fieldType: { kind: 'text' } },
          ],
        },
      ],
    });
    const codes = validateTablesAgainstCapabilities(data, capabilitiesWithFieldCap).map((i) => i.code);
    expect(codes).toContain('TOO_MANY_FIELDS');
  });

  it('does not flag a table exactly at the connector field limit', () => {
    const capabilitiesWithFieldCap: SchemaCreationCapabilities = { ...capabilities, maxFieldsPerTable: 2 };
    const data = parse({
      connectorAccountId: 'c',
      tables: [
        {
          ref: 't1',
          name: 'T',
          fields: [
            { name: 'A', fieldType: { kind: 'text' }, isPrimary: true },
            { name: 'B', fieldType: { kind: 'text' } },
          ],
        },
      ],
    });
    const codes = validateTablesAgainstCapabilities(data, capabilitiesWithFieldCap).map((i) => i.code);
    expect(codes).not.toContain('TOO_MANY_FIELDS');
  });
});

describe('validateNamesAgainstExisting', () => {
  it('flags a proposed name that already exists (case-insensitive)', () => {
    const issues = validateNamesAgainstExisting(['Name', 'Other'], ['name'], (i) => `fields[${i}].name`);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ code: 'FIELD_NAME_ALREADY_EXISTS', path: 'fields[0].name' });
  });
});

describe('formatIssuePath', () => {
  it('renders array indices as [n] and keys as dotted segments', () => {
    expect(formatIssuePath(['tables', 0, 'fields', 2, 'name'])).toBe('tables[0].fields[2].name');
  });
});
