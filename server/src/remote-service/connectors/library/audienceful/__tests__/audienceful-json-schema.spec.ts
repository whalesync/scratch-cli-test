import { extractSchemaFields } from '../../../../../utils/schema-helpers';
import { buildAudiencefulJsonTableSpec } from '../audienceful-json-schema';
import { AudiencefulField } from '../audienceful-types';

describe('buildAudiencefulJsonTableSpec', () => {
  const entityId = { wsId: 'people', remoteId: ['people'] };

  it('should nest custom fields under extra_data', () => {
    const customFields: AudiencefulField[] = [
      { id: 'f1', name: 'First Name', data_name: 'first_name', type: 'string', editable: true, required: false },
      {
        id: 'f2',
        name: 'Address Line 1',
        data_name: 'address_line_1',
        type: 'string',
        editable: true,
        required: false,
      },
    ];

    const spec = buildAudiencefulJsonTableSpec(entityId, customFields);
    const fields = extractSchemaFields(spec.schema);

    const paths = fields.map((f) => f.path);

    // Custom fields should be nested under extra_data
    expect(paths).toContain('extra_data.first_name');
    expect(paths).toContain('extra_data.address_line_1');

    // They should NOT appear at the top level
    expect(paths).not.toContain('first_name');
    expect(paths).not.toContain('address_line_1');
  });

  it('should not duplicate built-in fields inside extra_data', () => {
    // If the API returns a custom field with the same name as a built-in field, skip it
    const customFields: AudiencefulField[] = [
      { id: 'f1', name: 'Email', data_name: 'email', type: 'string', editable: true, required: true },
    ];

    const spec = buildAudiencefulJsonTableSpec(entityId, customFields);
    const fields = extractSchemaFields(spec.schema);

    const paths = fields.map((f) => f.path);

    // email should exist as a top-level built-in field
    expect(paths).toContain('email');
    // It should NOT be duplicated under extra_data
    expect(paths).not.toContain('extra_data.email');
  });

  it('should preserve field types for custom fields under extra_data', () => {
    const customFields: AudiencefulField[] = [
      { id: 'f1', name: 'Age', data_name: 'age', type: 'number', editable: true, required: false },
      { id: 'f2', name: 'Birthday', data_name: 'birthday', type: 'date', editable: true, required: false },
      { id: 'f3', name: 'Active', data_name: 'is_active', type: 'boolean', editable: true, required: false },
    ];

    const spec = buildAudiencefulJsonTableSpec(entityId, customFields);
    const fields = extractSchemaFields(spec.schema);

    const ageField = fields.find((f) => f.path === 'extra_data.age');
    const birthdayField = fields.find((f) => f.path === 'extra_data.birthday');
    const activeField = fields.find((f) => f.path === 'extra_data.is_active');

    expect(ageField?.type).toBe('number');
    expect(birthdayField?.type).toBe('string'); // dates are strings with format
    expect(activeField?.type).toBe('boolean');
  });

  it('should include standard top-level fields', () => {
    const spec = buildAudiencefulJsonTableSpec(entityId, []);
    const fields = extractSchemaFields(spec.schema);

    const paths = fields.map((f) => f.path);

    expect(paths).toContain('email');
    expect(paths).toContain('uid');
    expect(paths).toContain('status');
    expect(paths).toContain('extra_data');
  });
});
