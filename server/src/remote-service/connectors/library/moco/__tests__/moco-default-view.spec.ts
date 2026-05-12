import { Type } from '@sinclair/typebox';
import { TableViewCol, X_SCRATCH_READONLY } from '@spinner/shared-types';
import { buildMocoDefaultView } from '../moco-default-view';

describe('buildMocoDefaultView', () => {
  function buildCompanySchema() {
    return Type.Object({
      id: Type.Number({ [X_SCRATCH_READONLY]: true }),
      type: Type.Union([Type.Literal('customer'), Type.Literal('supplier'), Type.Literal('organization')]),
      name: Type.String(),
      website: Type.Optional(Type.Union([Type.String(), Type.Null()])),
      email: Type.Optional(Type.Union([Type.String({ format: 'email' }), Type.Null()])),
      phone: Type.Optional(Type.Union([Type.String(), Type.Null()])),
      fax: Type.Optional(Type.Union([Type.String(), Type.Null()])),
      currency: Type.Optional(Type.Union([Type.String(), Type.Null()])),
      country_code: Type.Optional(Type.Union([Type.String(), Type.Null()])),
      identifier: Type.Optional(Type.Union([Type.String(), Type.Null()])),
      intern: Type.Optional(Type.Union([Type.Boolean(), Type.Null()])),
      billing_email_cc: Type.Optional(Type.Union([Type.String({ format: 'email' }), Type.Null()])),
      footer: Type.Optional(Type.Union([Type.String(), Type.Null()])),
      vat_identifier: Type.Optional(Type.Union([Type.String(), Type.Null()])),
      custom_properties: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
      user: Type.Optional(
        Type.Object(
          { id: Type.Number(), firstname: Type.String(), lastname: Type.String() },
          { [X_SCRATCH_READONLY]: true },
        ),
      ),
      created_at: Type.String({ format: 'date-time', [X_SCRATCH_READONLY]: true }),
      updated_at: Type.String({ format: 'date-time', [X_SCRATCH_READONLY]: true }),
    });
  }

  function buildContactSchema() {
    return Type.Object({
      id: Type.Number({ [X_SCRATCH_READONLY]: true }),
      firstname: Type.Optional(Type.Union([Type.String(), Type.Null()])),
      lastname: Type.String(),
      job_position: Type.Optional(Type.Union([Type.String(), Type.Null()])),
      company: Type.Optional(
        Type.Object(
          { id: Type.Number(), type: Type.Optional(Type.String()), name: Type.String() },
          { [X_SCRATCH_READONLY]: true },
        ),
      ),
      work_email: Type.Optional(Type.Union([Type.String({ format: 'email' }), Type.Null()])),
      work_phone: Type.Optional(Type.Union([Type.String(), Type.Null()])),
      mobile_phone: Type.Optional(Type.Union([Type.String(), Type.Null()])),
      birthday: Type.Optional(Type.Union([Type.String({ format: 'date' }), Type.Null()])),
      custom_properties: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
      created_at: Type.String({ format: 'date-time', [X_SCRATCH_READONLY]: true }),
      updated_at: Type.String({ format: 'date-time', [X_SCRATCH_READONLY]: true }),
    });
  }

  function buildProjectSchema() {
    return Type.Object({
      id: Type.Number({ [X_SCRATCH_READONLY]: true }),
      identifier: Type.Optional(Type.Union([Type.String(), Type.Null()])),
      name: Type.String(),
      active: Type.Boolean(),
      billable: Type.Boolean(),
      start_date: Type.String({ format: 'date' }),
      finish_date: Type.String({ format: 'date' }),
      currency: Type.String(),
      budget: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
      custom_properties: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
      leader: Type.Optional(
        Type.Union(
          [Type.Object({ id: Type.Number(), firstname: Type.String(), lastname: Type.String() }), Type.Null()],
          { [X_SCRATCH_READONLY]: true },
        ),
      ),
      customer: Type.Optional(Type.Object({ id: Type.Number(), name: Type.String() }, { [X_SCRATCH_READONLY]: true })),
      created_at: Type.String({ format: 'date-time', [X_SCRATCH_READONLY]: true }),
      updated_at: Type.String({ format: 'date-time', [X_SCRATCH_READONLY]: true }),
    });
  }

  describe('companies', () => {
    const schema = buildCompanySchema();
    const view = buildMocoDefaultView(schema, 'companies');

    it('should return a view named "Default"', () => {
      expect(view.name).toBe('Default');
    });

    it('should place priority fields first in the expected order', () => {
      const paths = view.cols.map((c) => (c as TableViewCol).path);
      const nameIdx = paths.indexOf('name');
      const idIdx = paths.indexOf('id');
      const typeIdx = paths.indexOf('type');
      const websiteIdx = paths.indexOf('website');
      const emailIdx = paths.indexOf('email');
      const phoneIdx = paths.indexOf('phone');
      const currencyIdx = paths.indexOf('currency');
      const countryCodeIdx = paths.indexOf('country_code');
      const identifierIdx = paths.indexOf('identifier');

      expect(nameIdx).toBe(0);
      expect(idIdx).toBeLessThan(typeIdx);
      expect(typeIdx).toBeLessThan(websiteIdx);
      expect(websiteIdx).toBeLessThan(emailIdx);
      expect(emailIdx).toBeLessThan(phoneIdx);
      expect(phoneIdx).toBeLessThan(currencyIdx);
      expect(currencyIdx).toBeLessThan(countryCodeIdx);
      expect(countryCodeIdx).toBeLessThan(identifierIdx);
    });

    it('should place non-priority fields after priority fields alphabetically', () => {
      const paths = view.cols.map((c) => (c as TableViewCol).path);
      const identifierIdx = paths.indexOf('identifier'); // last priority field
      const createdAtIdx = paths.indexOf('created_at');

      expect(createdAtIdx).toBeGreaterThan(identifierIdx);
    });

    it('should hide custom_properties, intern, fax, billing_email_cc, footer, vat_identifier', () => {
      const hiddenFields = ['custom_properties', 'intern', 'fax', 'billing_email_cc', 'footer', 'vat_identifier'];
      for (const fieldId of hiddenFields) {
        const col = view.cols.find((c) => c.kind === 'col' && c.path === fieldId) as TableViewCol;
        expect(col.hidden).toBe(true);
      }
    });

    it('should not hide business fields', () => {
      const nameCol = view.cols.find((c) => c.kind === 'col' && c.path === 'name') as TableViewCol;
      expect(nameCol.hidden).toBeUndefined();
    });

    it('should add id subfield to user object', () => {
      const col = view.cols.find((c) => c.kind === 'col' && c.path === 'user') as TableViewCol;
      expect(col.subfields).toBeDefined();
      expect(col.subfields![0].relativePath).toBe('id');
      expect(col.selectedSubfield).toBe(0);
    });
  });

  describe('contacts', () => {
    const schema = buildContactSchema();
    const view = buildMocoDefaultView(schema, 'contacts');

    it('should place priority fields first in the expected order', () => {
      const paths = view.cols.map((c) => (c as TableViewCol).path);
      const firstnameIdx = paths.indexOf('firstname');
      const lastnameIdx = paths.indexOf('lastname');
      const idIdx = paths.indexOf('id');
      const jobPositionIdx = paths.indexOf('job_position');
      const companyIdx = paths.indexOf('company');

      expect(firstnameIdx).toBe(0);
      expect(lastnameIdx).toBeLessThan(idIdx);
      expect(idIdx).toBeLessThan(jobPositionIdx);
      expect(jobPositionIdx).toBeLessThan(companyIdx);
    });

    it('should add id subfield to company object', () => {
      const col = view.cols.find((c) => c.kind === 'col' && c.path === 'company') as TableViewCol;
      expect(col.subfields).toBeDefined();
      expect(col.subfields![0].relativePath).toBe('id');
      expect(col.selectedSubfield).toBe(0);
    });

    it('should hide custom_properties', () => {
      const col = view.cols.find((c) => c.kind === 'col' && c.path === 'custom_properties') as TableViewCol;
      expect(col.hidden).toBe(true);
    });
  });

  describe('projects', () => {
    const schema = buildProjectSchema();
    const view = buildMocoDefaultView(schema, 'projects');

    it('should place priority fields first in the expected order', () => {
      const paths = view.cols.map((c) => (c as TableViewCol).path);
      const nameIdx = paths.indexOf('name');
      const idIdx = paths.indexOf('id');
      const identifierIdx = paths.indexOf('identifier');
      const activeIdx = paths.indexOf('active');
      const billableIdx = paths.indexOf('billable');
      const startDateIdx = paths.indexOf('start_date');
      const finishDateIdx = paths.indexOf('finish_date');
      const currencyIdx = paths.indexOf('currency');
      const budgetIdx = paths.indexOf('budget');

      expect(nameIdx).toBe(0);
      expect(idIdx).toBeLessThan(identifierIdx);
      expect(identifierIdx).toBeLessThan(activeIdx);
      expect(activeIdx).toBeLessThan(billableIdx);
      expect(billableIdx).toBeLessThan(startDateIdx);
      expect(startDateIdx).toBeLessThan(finishDateIdx);
      expect(finishDateIdx).toBeLessThan(currencyIdx);
      expect(currencyIdx).toBeLessThan(budgetIdx);
    });

    it('should add id subfield to leader object', () => {
      const col = view.cols.find((c) => c.kind === 'col' && c.path === 'leader') as TableViewCol;
      expect(col.subfields).toBeDefined();
      expect(col.subfields![0].relativePath).toBe('id');
      expect(col.selectedSubfield).toBe(0);
    });

    it('should add id subfield to customer object', () => {
      const col = view.cols.find((c) => c.kind === 'col' && c.path === 'customer') as TableViewCol;
      expect(col.subfields).toBeDefined();
      expect(col.subfields![0].relativePath).toBe('id');
      expect(col.selectedSubfield).toBe(0);
    });

    it('should hide custom_properties', () => {
      const col = view.cols.find((c) => c.kind === 'col' && c.path === 'custom_properties') as TableViewCol;
      expect(col.hidden).toBe(true);
    });
  });

  describe('type mapping', () => {
    const schema = buildProjectSchema();
    const view = buildMocoDefaultView(schema, 'projects');

    it('should map date-time format to date type', () => {
      const col = view.cols.find((c) => c.kind === 'col' && c.path === 'created_at') as TableViewCol;
      expect(col.type).toBe('date');
    });

    it('should map date format to date type', () => {
      const col = view.cols.find((c) => c.kind === 'col' && c.path === 'start_date') as TableViewCol;
      expect(col.type).toBe('date');
    });

    it('should map boolean fields to checkbox type', () => {
      const col = view.cols.find((c) => c.kind === 'col' && c.path === 'active') as TableViewCol;
      expect(col.type).toBe('checkbox');
    });

    it('should map number fields to number type', () => {
      const companySchema = buildCompanySchema();
      const companyView = buildMocoDefaultView(companySchema, 'companies');
      const col = companyView.cols.find((c) => c.kind === 'col' && c.path === 'id') as TableViewCol;
      expect(col.type).toBe('number');
    });

    it('should map object fields to object type', () => {
      const col = view.cols.find((c) => c.kind === 'col' && c.path === 'customer') as TableViewCol;
      expect(col.type).toBe('object');
    });

    it('should map Record fields to object type', () => {
      const col = view.cols.find((c) => c.kind === 'col' && c.path === 'custom_properties') as TableViewCol;
      expect(col.type).toBe('object');
    });

    it('should unwrap Union types to find the inner type', () => {
      const contactSchema = buildContactSchema();
      const contactView = buildMocoDefaultView(contactSchema, 'contacts');
      const col = contactView.cols.find((c) => c.kind === 'col' && c.path === 'birthday') as TableViewCol;
      expect(col.type).toBe('date');
    });
  });

  describe('readonly', () => {
    const schema = buildCompanySchema();
    const view = buildMocoDefaultView(schema, 'companies');

    it('should mark readonly fields', () => {
      const col = view.cols.find((c) => c.kind === 'col' && c.path === 'id') as TableViewCol;
      expect(col.readonly).toBe(true);
    });

    it('should not mark writable fields as readonly', () => {
      const col = view.cols.find((c) => c.kind === 'col' && c.path === 'name') as TableViewCol;
      expect(col.readonly).toBeUndefined();
    });

    it('should propagate readonly from object schemas', () => {
      const col = view.cols.find((c) => c.kind === 'col' && c.path === 'user') as TableViewCol;
      expect(col.readonly).toBe(true);
    });
  });

  describe('name formatting', () => {
    const schema = buildCompanySchema();
    const view = buildMocoDefaultView(schema, 'companies');

    it('should format snake_case field names as Title Case', () => {
      const col = view.cols.find((c) => c.kind === 'col' && c.path === 'country_code') as TableViewCol;
      expect(col.name).toBe('Country Code');
    });

    it('should format single-word field names with capital first letter', () => {
      const col = view.cols.find((c) => c.kind === 'col' && c.path === 'name') as TableViewCol;
      expect(col.name).toBe('Name');
    });

    it('should format multi-word field names correctly', () => {
      const col = view.cols.find((c) => c.kind === 'col' && c.path === 'billing_email_cc') as TableViewCol;
      expect(col.name).toBe('Billing Email Cc');
    });
  });

  it('should handle an empty schema gracefully', () => {
    const empty = Type.Object({});
    const emptyView = buildMocoDefaultView(empty, 'companies');
    expect(emptyView.cols).toEqual([]);
  });

  it('should not produce any banner groups', () => {
    const schema = buildCompanySchema();
    const view = buildMocoDefaultView(schema, 'companies');
    const groups = view.cols.filter((c) => c.kind === 'banner-group');
    expect(groups).toHaveLength(0);
  });
});
