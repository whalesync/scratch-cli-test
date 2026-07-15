import type {
  CreateFieldSpec,
  CreateSchemaTablesDto,
  SchemaCreationCapabilities,
  ValidateSchemaIssue,
} from '@spinner/shared-types';
import { z } from 'zod';

/**
 * Pure validation helpers for create-schema (DEV-10378).
 *
 * Structural + intra-request rules live in the zod schema (see
 * `create-schema.dto.ts`); this module (1) converts zod issues into the
 * dry-run `ValidateSchemaIssue` shape and (2) adds the checks that depend on
 * runtime context the schema can't see: the connector's declared capabilities
 * and a table's existing field names.
 */

/** Format a zod issue path (`['tables', 0, 'fields', 2, 'name']`) → `tables[0].fields[2].name`. */
export function formatIssuePath(path: PropertyKey[]): string {
  let formatted = '';
  for (const segment of path) {
    if (typeof segment === 'number') {
      formatted += `[${segment}]`;
    } else {
      const key = String(segment);
      formatted += formatted ? `.${key}` : key;
    }
  }
  return formatted;
}

/** Stable issue code: the `params.code` we attach to custom issues, else the zod code uppercased. */
function codeForZodIssue(issue: z.core.$ZodIssue): string {
  if (issue.code === 'custom' && issue.params && typeof issue.params.code === 'string') {
    return issue.params.code;
  }
  return issue.code.toUpperCase();
}

/** Convert a ZodError into the dry-run issue list. */
export function zodErrorToValidateIssues(error: z.ZodError): ValidateSchemaIssue[] {
  return error.issues.map((issue) => ({
    path: formatIssuePath(issue.path),
    code: codeForZodIssue(issue),
    message: issue.message,
  }));
}

/**
 * Validate every table in a create-tables request against a connector's declared
 * capabilities: supported field kinds, a mandatory primary field (and its
 * allowed kinds), and name-length limits. Returns all issues found (does not
 * throw) so the dry-run endpoint can surface them together.
 */
export function validateTablesAgainstCapabilities(
  request: CreateSchemaTablesDto,
  capabilities: SchemaCreationCapabilities,
): ValidateSchemaIssue[] {
  const issues: ValidateSchemaIssue[] = [];
  request.tables.forEach((table, tableIndex) => {
    const tablePath = `tables[${tableIndex}]`;
    if (capabilities.maxTableNameLength !== undefined && table.name.length > capabilities.maxTableNameLength) {
      issues.push({
        path: `${tablePath}.name`,
        code: 'TABLE_NAME_TOO_LONG',
        message: `table name exceeds the connector's maximum of ${capabilities.maxTableNameLength} characters`,
      });
    }

    if (capabilities.maxFieldsPerTable !== undefined && table.fields.length > capabilities.maxFieldsPerTable) {
      issues.push({
        path: `${tablePath}.fields`,
        code: 'TOO_MANY_FIELDS',
        message: `this table has ${table.fields.length} fields, which exceeds the connector's maximum of ${capabilities.maxFieldsPerTable} fields per table`,
      });
    }

    issues.push(...validateFieldsAgainstCapabilities(table.fields, capabilities, `${tablePath}.fields`));

    if (capabilities.primaryField) {
      const allowedPrimaryFieldKinds = capabilities.primaryField.kinds;
      const primaryFields = table.fields.filter((field) => field.isPrimary);
      if (primaryFields.length === 0) {
        issues.push({
          path: `${tablePath}`,
          code: 'MISSING_PRIMARY_FIELD',
          message: 'this connector requires the table to designate exactly one field with isPrimary',
        });
      } else if (allowedPrimaryFieldKinds.length > 0) {
        // (zod already rejects >1 primary; here we only validate the single primary's kind.)
        const primary = primaryFields[0];
        if (!allowedPrimaryFieldKinds.includes(primary.fieldType.kind)) {
          issues.push({
            path: `${tablePath}.fields[${table.fields.indexOf(primary)}].fieldType.kind`,
            code: 'PRIMARY_FIELD_WRONG_KIND',
            message: `the primary field must be one of: ${allowedPrimaryFieldKinds.join(', ')}`,
          });
        }
      }
    }
  });
  return issues;
}

/**
 * Validate a flat list of fields against a connector's capabilities (supported
 * kinds + name length). Used by both create-tables (per table) and create-fields.
 */
export function validateFieldsAgainstCapabilities(
  fields: CreateFieldSpec[],
  capabilities: SchemaCreationCapabilities,
  pathPrefix: string,
): ValidateSchemaIssue[] {
  const issues: ValidateSchemaIssue[] = [];
  fields.forEach((field, fieldIndex) => {
    const fieldPath = `${pathPrefix}[${fieldIndex}]`;
    if (!capabilities.supportedFieldKinds.includes(field.fieldType.kind)) {
      issues.push({
        path: `${fieldPath}.fieldType.kind`,
        code: 'UNSUPPORTED_FIELD_KIND',
        message: `this connector does not support the "${field.fieldType.kind}" field kind`,
      });
    }
    if (capabilities.maxFieldNameLength !== undefined && field.name.length > capabilities.maxFieldNameLength) {
      issues.push({
        path: `${fieldPath}.name`,
        code: 'FIELD_NAME_TOO_LONG',
        message: `field name exceeds the connector's maximum of ${capabilities.maxFieldNameLength} characters`,
      });
    }
  });
  return issues;
}

/**
 * Flag any foreignKey field still carrying an unresolved (pending) target
 * (`{ unresolvedLinkedTableId }`). The plan generator emits these so an unbound FK
 * survives the plan → draft roundtrip as an available-but-incomplete field; they
 * MUST be bound to a destination (a sibling `ref` or an `existingRemoteTableId`)
 * before create. The zod schema already rejects them at the controller boundary,
 * but the create path re-checks here because the schema-builder service is also
 * invoked directly (e.g. by the sync-draft materializer, which bypasses the
 * controller's zod pipe). Returns all issues (does not throw).
 */
export function validateForeignKeyTargetsResolved(
  fields: CreateFieldSpec[],
  pathPrefix: string,
): ValidateSchemaIssue[] {
  const issues: ValidateSchemaIssue[] = [];
  fields.forEach((field, fieldIndex) => {
    const fieldType = field.fieldType;
    if (fieldType.kind === 'foreignKey' && 'unresolvedLinkedTableId' in fieldType.target) {
      issues.push({
        path: `${pathPrefix}[${fieldIndex}].fieldType.target`,
        code: 'FK_TARGET_UNRESOLVED',
        message: `foreignKey field "${field.name}" has no destination table chosen (it links to "${fieldType.target.unresolvedLinkedTableId}"); resolve it to an existing table or to a sibling being created before creating`,
      });
    }
  });
  return issues;
}

/** Run {@link validateForeignKeyTargetsResolved} across every table in a create-tables request. */
export function validateTableForeignKeyTargetsResolved(request: CreateSchemaTablesDto): ValidateSchemaIssue[] {
  const issues: ValidateSchemaIssue[] = [];
  request.tables.forEach((table, tableIndex) => {
    issues.push(...validateForeignKeyTargetsResolved(table.fields, `tables[${tableIndex}].fields`));
  });
  return issues;
}

/**
 * Case-insensitively flag any proposed field name that collides with an existing
 * field name on the target table (used by create-fields, and by create-tables
 * when the table is already materialized as a local folder).
 */
export function validateNamesAgainstExisting(
  proposedNames: string[],
  existingFieldNames: string[],
  pathFor: (index: number) => string,
): ValidateSchemaIssue[] {
  const existing = new Set(existingFieldNames.map((name) => name.trim().toLowerCase()));
  const issues: ValidateSchemaIssue[] = [];
  proposedNames.forEach((name, index) => {
    if (existing.has(name.trim().toLowerCase())) {
      issues.push({
        path: pathFor(index),
        code: 'FIELD_NAME_ALREADY_EXISTS',
        message: `a field named "${name}" already exists on the target table`,
      });
    }
  });
  return issues;
}
