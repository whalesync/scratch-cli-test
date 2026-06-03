import { Type, type TSchema } from '@sinclair/typebox';
import {
  X_SCRATCH_FOREIGN_KEY_OPTIONS,
  X_SCRATCH_LAST_MODIFIED_FIELD,
  X_SCRATCH_READONLY,
} from '@spinner/shared-types';
import { BaseJsonTableSpec, EntityId, idPath } from '../../types';
import { buildMocoDefaultView } from './moco-default-view';
import { MocoEntityType } from './moco-types';

/**
 * Display names for Moco entity types
 */
const ENTITY_DISPLAY_NAMES: Record<MocoEntityType, string> = {
  companies: 'Companies',
  contacts: 'Contacts',
  projects: 'Projects',
};

/**
 * Get the title column remote ID for an entity type.
 */
function getTitleColumnRemoteId(entityType: MocoEntityType): string[] {
  switch (entityType) {
    case 'companies':
      return [entityType, 'name'];
    case 'contacts':
      return [entityType, 'lastname'];
    case 'projects':
      return [entityType, 'name'];
  }
}

/**
 * Get the main content column remote ID for an entity type.
 */
function getMainContentColumnRemoteId(entityType: MocoEntityType): string[] {
  switch (entityType) {
    case 'companies':
      return [entityType, 'info'];
    case 'contacts':
      return [entityType, 'info'];
    case 'projects':
      return [entityType, 'info'];
  }
}

/**
 * Build the TypeBox schema for a Company.
 */
function buildCompanySchema(): TSchema {
  // VAT configuration object schema (shared between billing_vat and customer_vat)
  const vatConfigSchema = Type.Object({
    id: Type.Optional(Type.Number()),
    tax: Type.Optional(Type.Number()),
    description: Type.Optional(Type.String()),
    reverse_charge: Type.Optional(Type.Boolean()),
    intra_eu: Type.Optional(Type.Boolean()),
    print_gross_total: Type.Optional(Type.Boolean()),
    notice_tax_exemption: Type.Optional(Type.String()),
    notice_tax_exemption_en: Type.Optional(Type.String()),
    notice_tax_exemption_alt: Type.Optional(Type.String()),
    active: Type.Optional(Type.Boolean()),
    code: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    credit_account: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  });

  // Abbreviated project schema for the projects array
  const projectRefSchema = Type.Object({
    id: Type.Number(),
    identifier: Type.Optional(Type.String()),
    name: Type.String(),
    active: Type.Boolean(),
    billable: Type.Boolean(),
  });

  return Type.Object(
    {
      id: Type.Number({ description: 'Unique identifier (read-only)', [X_SCRATCH_READONLY]: true }),
      type: Type.Union([Type.Literal('customer'), Type.Literal('supplier'), Type.Literal('organization')], {
        description: 'Company type (required)',
      }),
      name: Type.String({ description: 'Company name (required)' }),
      website: Type.Optional(Type.Union([Type.String(), Type.Null()], { description: 'Website URL' })),
      email: Type.Optional(
        Type.Union([Type.String({ format: 'email' }), Type.Null()], { description: 'Email address' }),
      ),
      billing_email_cc: Type.Optional(
        Type.Union([Type.String({ format: 'email' }), Type.Null()], { description: 'CC email for invoices' }),
      ),
      phone: Type.Optional(Type.Union([Type.String(), Type.Null()], { description: 'Phone number' })),
      fax: Type.Optional(Type.Union([Type.String(), Type.Null()], { description: 'Fax number' })),
      address: Type.Optional(Type.Union([Type.String(), Type.Null()], { description: 'Address (multiline)' })),
      info: Type.Optional(Type.Union([Type.String(), Type.Null()], { description: 'Additional info' })),
      identifier: Type.Optional(Type.Union([Type.String(), Type.Null()], { description: 'Company code/number' })),
      intern: Type.Optional(Type.Union([Type.Boolean(), Type.Null()], { description: 'Internal company flag' })),
      currency: Type.Optional(
        Type.Union([Type.String(), Type.Null()], { description: 'Currency code (e.g., EUR, USD)' }),
      ),
      country_code: Type.Optional(
        Type.Union([Type.String(), Type.Null()], { description: 'ISO Alpha-2 country code (e.g., US, DE)' }),
      ),
      vat_identifier: Type.Optional(
        Type.Union([Type.String(), Type.Null()], { description: 'EU VAT identification number' }),
      ),
      alternative_correspondence_language: Type.Optional(
        Type.Boolean({ description: 'Use alternative language for documents' }),
      ),
      english_correspondence_language: Type.Optional(Type.Boolean({ description: 'Use English for correspondence' })),
      labels: Type.Optional(Type.Array(Type.String(), { description: 'Labels' })),
      tags: Type.Optional(Type.Array(Type.String(), { description: 'Tags' })),
      user: Type.Optional(
        Type.Object(
          { id: Type.Number(), firstname: Type.String(), lastname: Type.String() },
          { description: 'Assigned user (read-only, use user_id for create/update)', [X_SCRATCH_READONLY]: true },
        ),
      ),
      footer: Type.Optional(Type.Union([Type.String(), Type.Null()], { description: 'HTML footer for invoices' })),
      custom_properties: Type.Optional(
        Type.Record(Type.String(), Type.Unknown(), { description: 'Custom properties (key-value pairs)' }),
      ),
      // Billing/customer-specific fields
      billing_tax: Type.Optional(Type.Number({ description: 'Billing tax percentage' })),
      billing_vat: Type.Optional(
        Type.Union([vatConfigSchema, Type.Null()], { description: 'Billing VAT configuration' }),
      ),
      customer_vat: Type.Optional(
        Type.Union([vatConfigSchema, Type.Null()], { description: 'Customer VAT configuration' }),
      ),
      custom_rates: Type.Optional(Type.Boolean({ description: 'Use custom rate pricing' })),
      include_time_report: Type.Optional(Type.Boolean({ description: 'Include time report in invoices' })),
      billing_notes: Type.Optional(
        Type.Union([Type.String(), Type.Null()], { description: 'Special billing instructions' }),
      ),
      default_discount: Type.Optional(Type.Number({ description: 'Default discount percentage' })),
      default_cash_discount: Type.Optional(Type.Number({ description: 'Early payment discount percentage' })),
      default_cash_discount_days: Type.Optional(Type.Number({ description: 'Days for cash discount' })),
      default_invoice_due_days: Type.Optional(Type.Number({ description: 'Invoice payment terms (days)' })),
      // Related entities (read-only)
      projects: Type.Optional(
        Type.Array(projectRefSchema, { description: 'Associated projects (read-only)', [X_SCRATCH_READONLY]: true }),
      ),
      created_at: Type.String({
        description: 'Created timestamp (read-only)',
        format: 'date-time',
        [X_SCRATCH_READONLY]: true,
      }),
      updated_at: Type.String({
        description: 'Updated timestamp (read-only)',
        format: 'date-time',
        [X_SCRATCH_READONLY]: true,
        // Annotated for the UI's last-modified-field picker. Moco's connector
        // hardcodes `updated_at` for incremental pulls (it is a fixed system
        // field on every entity), but the annotation keeps the picker and the
        // auto-detect path (findLastModifiedFieldName) consistent with the
        // other connectors. Mirrors how Linear annotates `updatedAt`.
        [X_SCRATCH_LAST_MODIFIED_FIELD]: true,
      }),
    },
    { $id: 'moco/companies', title: 'Companies' },
  );
}

/**
 * Build the TypeBox schema for a Contact.
 */
function buildContactSchema(): TSchema {
  return Type.Object(
    {
      id: Type.Number({ description: 'Unique identifier (read-only)', [X_SCRATCH_READONLY]: true }),
      gender: Type.Union([Type.Literal('F'), Type.Literal('M'), Type.Literal('U')], {
        description: 'Gender (required): F=Female, M=Male, U=Unknown',
      }),
      firstname: Type.Optional(Type.Union([Type.String(), Type.Null()], { description: 'First name' })),
      lastname: Type.String({ description: 'Last name (required)' }),
      title: Type.Optional(Type.Union([Type.String(), Type.Null()], { description: 'Title (e.g., Dr. med.)' })),
      job_position: Type.Optional(Type.Union([Type.String(), Type.Null()], { description: 'Job position/role' })),
      mobile_phone: Type.Optional(Type.Union([Type.String(), Type.Null()], { description: 'Mobile phone number' })),
      work_phone: Type.Optional(Type.Union([Type.String(), Type.Null()], { description: 'Work phone number' })),
      work_email: Type.Optional(
        Type.Union([Type.String({ format: 'email' }), Type.Null()], { description: 'Work email address' }),
      ),
      work_fax: Type.Optional(Type.Union([Type.String(), Type.Null()], { description: 'Work fax number' })),
      work_address: Type.Optional(Type.Union([Type.String(), Type.Null()], { description: 'Work address' })),
      home_address: Type.Optional(Type.Union([Type.String(), Type.Null()], { description: 'Home address' })),
      home_email: Type.Optional(
        Type.Union([Type.String({ format: 'email' }), Type.Null()], { description: 'Home email address' }),
      ),
      home_phone: Type.Optional(Type.Union([Type.String(), Type.Null()], { description: 'Home phone number' })),
      birthday: Type.Optional(
        Type.Union([Type.String({ format: 'date' }), Type.Null()], { description: 'Birthday (YYYY-MM-DD)' }),
      ),
      salutation: Type.Optional(Type.Union([Type.String(), Type.Null()], { description: 'Salutation' })),
      info: Type.Optional(Type.Union([Type.String(), Type.Null()], { description: 'Additional information' })),
      avatar_url: Type.Optional(
        Type.Union([Type.String(), Type.Null()], {
          description: 'Profile image URL (read-only)',
          [X_SCRATCH_READONLY]: true,
        }),
      ),
      tags: Type.Optional(Type.Array(Type.String(), { description: 'Tags/labels' })),
      custom_properties: Type.Optional(
        Type.Record(Type.String(), Type.Unknown(), { description: 'Custom properties (key-value pairs)' }),
      ),
      company: Type.Optional(
        Type.Object(
          {
            id: Type.Number(),
            type: Type.Optional(Type.String()),
            name: Type.String(),
          },
          {
            description: 'Associated company (read-only, use company_id for create/update)',
            [X_SCRATCH_READONLY]: true,
            [X_SCRATCH_FOREIGN_KEY_OPTIONS]: { linkedTableId: 'companies' },
          },
        ),
      ),
      user: Type.Optional(
        Type.Object(
          { id: Type.Number(), firstname: Type.String(), lastname: Type.String() },
          { description: 'Assigned user (read-only, use user_id for create/update)', [X_SCRATCH_READONLY]: true },
        ),
      ),
      created_at: Type.String({
        description: 'Created timestamp (read-only)',
        format: 'date-time',
        [X_SCRATCH_READONLY]: true,
      }),
      updated_at: Type.String({
        description: 'Updated timestamp (read-only)',
        format: 'date-time',
        [X_SCRATCH_READONLY]: true,
        // Annotated for the UI's last-modified-field picker. Moco's connector
        // hardcodes `updated_at` for incremental pulls (it is a fixed system
        // field on every entity), but the annotation keeps the picker and the
        // auto-detect path (findLastModifiedFieldName) consistent with the
        // other connectors. Mirrors how Linear annotates `updatedAt`.
        [X_SCRATCH_LAST_MODIFIED_FIELD]: true,
      }),
    },
    { $id: 'moco/contacts', title: 'Contacts' },
  );
}

/**
 * Build the TypeBox schema for a Project.
 */
function buildProjectSchema(): TSchema {
  // User reference schema (for leader, co_leader)
  const userRefSchema = Type.Object({
    id: Type.Number(),
    firstname: Type.String(),
    lastname: Type.String(),
  });

  // Contact reference schema
  const contactRefSchema = Type.Object({
    id: Type.Number(),
    firstname: Type.Optional(Type.String()),
    lastname: Type.Optional(Type.String()),
  });

  // Task schema
  const taskSchema = Type.Object({
    id: Type.Number(),
    name: Type.String(),
    billable: Type.Boolean(),
    active: Type.Boolean(),
    budget: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
    hourly_rate: Type.Optional(Type.Number()),
    description: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  });

  // Contract schema
  const contractSchema = Type.Object({
    id: Type.Number(),
    user_id: Type.Number(),
    firstname: Type.String(),
    lastname: Type.String(),
    billable: Type.Boolean(),
    active: Type.Boolean(),
    budget: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
    hourly_rate: Type.Optional(Type.Number()),
  });

  return Type.Object(
    {
      id: Type.Number({ description: 'Unique identifier (read-only)', [X_SCRATCH_READONLY]: true }),
      identifier: Type.Optional(Type.Union([Type.String(), Type.Null()], { description: 'Project identifier/code' })),
      name: Type.String({ description: 'Project name (required)' }),
      active: Type.Boolean({ description: 'Active status' }),
      billable: Type.Boolean({ description: 'Billable flag' }),
      fixed_price: Type.Boolean({ description: 'Fixed price project (required)' }),
      retainer: Type.Boolean({ description: 'Retainer project (required)' }),
      start_date: Type.String({ format: 'date', description: 'Start date YYYY-MM-DD (required)' }),
      finish_date: Type.String({ format: 'date', description: 'Finish date YYYY-MM-DD (required)' }),
      color: Type.Optional(Type.Union([Type.String(), Type.Null()], { description: 'Color (hex code)' })),
      currency: Type.String({ description: 'Currency code (required)' }),
      budget: Type.Optional(Type.Union([Type.Number(), Type.Null()], { description: 'Total budget' })),
      budget_monthly: Type.Optional(
        Type.Union([Type.Number(), Type.Null()], { description: 'Monthly budget (required for retainer)' }),
      ),
      budget_expenses: Type.Optional(Type.Union([Type.Number(), Type.Null()], { description: 'Expenses budget' })),
      hourly_rate: Type.Optional(Type.Union([Type.Number(), Type.Null()], { description: 'Default hourly rate' })),
      info: Type.Optional(Type.Union([Type.String(), Type.Null()], { description: 'Additional information' })),
      labels: Type.Optional(Type.Array(Type.String(), { description: 'Labels' })),
      tags: Type.Optional(Type.Array(Type.String(), { description: 'Tags' })),
      custom_properties: Type.Optional(
        Type.Record(Type.String(), Type.Unknown(), { description: 'Custom properties (key-value pairs)' }),
      ),
      // Billing configuration
      billing_variant: Type.Optional(
        Type.Union([Type.Literal('project'), Type.Literal('task'), Type.Literal('user')], {
          description: 'Billing variant',
        }),
      ),
      billing_address: Type.Optional(
        Type.Union([Type.String(), Type.Null()], { description: 'Billing address (multiline with \\n)' }),
      ),
      billing_email_to: Type.Optional(
        Type.Union([Type.String({ format: 'email' }), Type.Null()], { description: 'Billing email recipient' }),
      ),
      billing_email_cc: Type.Optional(
        Type.Union([Type.String({ format: 'email' }), Type.Null()], { description: 'Billing email CC' }),
      ),
      billing_notes: Type.Optional(
        Type.Union([Type.String(), Type.Null()], { description: 'Billing notes/instructions' }),
      ),
      setting_include_time_report: Type.Optional(Type.Boolean({ description: 'Include time report in invoices' })),
      // Retainer-specific fields
      retainer_billing_date: Type.Optional(Type.Number({ description: 'Retainer billing day of month (1-31)' })),
      retainer_billing_title: Type.Optional(
        Type.Union([Type.String(), Type.Null()], { description: 'Retainer billing title' }),
      ),
      retainer_billing_description: Type.Optional(
        Type.Union([Type.String(), Type.Null()], { description: 'Retainer billing description' }),
      ),
      // Related entities (read-only in responses, use *_id for create/update)
      leader: Type.Optional(
        Type.Union([userRefSchema, Type.Null()], {
          description: 'Project leader (read-only, use leader_id for create/update)',
          [X_SCRATCH_READONLY]: true,
        }),
      ),
      co_leader: Type.Optional(
        Type.Union([userRefSchema, Type.Null()], {
          description: 'Co-leader (read-only, use co_leader_id for create/update)',
          [X_SCRATCH_READONLY]: true,
        }),
      ),
      customer: Type.Optional(
        Type.Object(
          { id: Type.Number(), name: Type.String() },
          {
            description: 'Customer company (read-only, use customer_id for create/update)',
            [X_SCRATCH_READONLY]: true,
            [X_SCRATCH_FOREIGN_KEY_OPTIONS]: { linkedTableId: 'companies' },
          },
        ),
      ),
      deal: Type.Optional(
        Type.Union([Type.Object({ id: Type.Number(), name: Type.String() }), Type.Null()], {
          description: 'Associated deal (read-only, use deal_id for create/update)',
          [X_SCRATCH_READONLY]: true,
        }),
      ),
      project_group: Type.Optional(
        Type.Union([Type.Object({ id: Type.Number(), name: Type.String() }), Type.Null()], {
          description: 'Project group (read-only, use project_group_id for create/update)',
          [X_SCRATCH_READONLY]: true,
        }),
      ),
      contact: Type.Optional(
        Type.Union([contactRefSchema, Type.Null()], {
          description: 'Primary contact (read-only, use contact_id for create/update)',
          [X_SCRATCH_READONLY]: true,
          [X_SCRATCH_FOREIGN_KEY_OPTIONS]: { linkedTableId: 'contacts' },
        }),
      ),
      secondary_contact: Type.Optional(
        Type.Union([contactRefSchema, Type.Null()], {
          description: 'Secondary contact (read-only, use secondary_contact_id for create/update)',
          [X_SCRATCH_READONLY]: true,
          [X_SCRATCH_FOREIGN_KEY_OPTIONS]: { linkedTableId: 'contacts' },
        }),
      ),
      billing_contact: Type.Optional(
        Type.Union([contactRefSchema, Type.Null()], {
          description: 'Billing contact (read-only, use billing_contact_id for create/update)',
          [X_SCRATCH_READONLY]: true,
          [X_SCRATCH_FOREIGN_KEY_OPTIONS]: { linkedTableId: 'contacts' },
        }),
      ),
      // Nested arrays (read-only)
      tasks: Type.Optional(
        Type.Array(taskSchema, { description: 'Project tasks (read-only)', [X_SCRATCH_READONLY]: true }),
      ),
      contracts: Type.Optional(
        Type.Array(contractSchema, { description: 'User contracts (read-only)', [X_SCRATCH_READONLY]: true }),
      ),
      // Other read-only fields
      customer_report_url: Type.Optional(
        Type.Union([Type.String(), Type.Null()], {
          description: 'Customer report URL (read-only)',
          [X_SCRATCH_READONLY]: true,
        }),
      ),
      archived_on: Type.Optional(
        Type.Union([Type.String({ format: 'date' }), Type.Null()], {
          description: 'Archive date (read-only)',
          [X_SCRATCH_READONLY]: true,
        }),
      ),
      created_at: Type.String({
        description: 'Created timestamp (read-only)',
        format: 'date-time',
        [X_SCRATCH_READONLY]: true,
      }),
      updated_at: Type.String({
        description: 'Updated timestamp (read-only)',
        format: 'date-time',
        [X_SCRATCH_READONLY]: true,
        // Annotated for the UI's last-modified-field picker. Moco's connector
        // hardcodes `updated_at` for incremental pulls (it is a fixed system
        // field on every entity), but the annotation keeps the picker and the
        // auto-detect path (findLastModifiedFieldName) consistent with the
        // other connectors. Mirrors how Linear annotates `updatedAt`.
        [X_SCRATCH_LAST_MODIFIED_FIELD]: true,
      }),
    },
    { $id: 'moco/projects', title: 'Projects' },
  );
}

/**
 * Build the TypeBox schema for an entity type.
 */
function buildSchema(entityType: MocoEntityType): TSchema {
  switch (entityType) {
    case 'companies':
      return buildCompanySchema();
    case 'contacts':
      return buildContactSchema();
    case 'projects':
      return buildProjectSchema();
  }
}

/**
 * Build the JSON Table Spec for a Moco entity type.
 */
export function buildMocoJsonTableSpec(id: EntityId, entityType: MocoEntityType): BaseJsonTableSpec {
  const schema = buildSchema(entityType);

  return {
    id,
    slug: id.wsId,
    name: ENTITY_DISPLAY_NAMES[entityType],
    schema,
    idColumnRemoteId: idPath('id'),
    titleColumnRemoteId: getTitleColumnRemoteId(entityType).slice(1),
    mainContentColumnRemoteId: getMainContentColumnRemoteId(entityType).slice(1),
    basePath: [],
    generatedAt: new Date().toISOString(),
    defaultView: buildMocoDefaultView(schema, entityType),
  };
}
