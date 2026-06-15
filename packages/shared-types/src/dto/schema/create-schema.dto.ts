import { z } from 'zod';

/**
 * Request contracts for the create-schema API (DEV-10378).
 *
 * These describe — in a connector-agnostic "logical" vocabulary — new tables and
 * fields to create on a remote data source. The server validates them and (in a
 * later pass) hands them to a connector that maps each logical field type to its
 * native type. Keeping the vocabulary logical means connector knowledge never
 * crosses the wire.
 *
 * Per the shared-types convention, request bodies are zod schemas (validated by
 * the global ZodValidationPipe); responses/data objects are plain interfaces
 * (see ./create-schema-responses.dto.ts).
 */

// Reasonable upper bounds; individual connectors may enforce stricter limits via
// SchemaCreationCapabilities.maxTableNameLength / maxFieldNameLength.
export const MAX_TABLE_NAME_LENGTH = 255;
export const MAX_FIELD_NAME_LENGTH = 255;

/** Bounds on numeric precision a caller may request. */
export const MAX_NUMBER_PRECISION = 10;

/**
 * Every logical field-type discriminant, as a runtime tuple. Kept alongside the
 * discriminated union below; connectors declare which of these they support via
 * SchemaCreationCapabilities.supportedFieldKinds.
 */
export const CREATE_FIELD_KINDS = [
  'text',
  'longText',
  'number',
  'boolean',
  'date',
  'select',
  'multiSelect',
  'url',
  'email',
  'phone',
  'currency',
  'foreignKey',
] as const;

/** A single choice for a select / multiSelect field. */
export const createChoiceOptionSchema = z.object({
  name: z.string().min(1),
  /** Optional UI color hint; connectors that lack per-option colors ignore it. */
  color: z.string().optional(),
});
export type CreateChoiceOption = z.infer<typeof createChoiceOptionSchema>;

/**
 * What a foreignKey field points at. Exactly one branch is set:
 *   - `existingRemoteTableId` — the remoteId of a table that already exists on
 *     the destination service.
 *   - `ref` — the caller-assigned `ref` of another table being created in the
 *     SAME request (resolved to a real remote id by the server after creation).
 *
 * Strict objects make "both branches" or an empty target fail validation.
 */
export const foreignKeyTargetSchema = z.union([
  z.strictObject({ existingRemoteTableId: z.array(z.string()).min(1) }),
  z.strictObject({ ref: z.string().min(1) }),
]);
export type ForeignKeyTarget = z.infer<typeof foreignKeyTargetSchema>;

/**
 * The logical field-type vocabulary. A discriminated union keyed on `kind`, so
 * each variant validates its own options (a select needs choices, a currency
 * needs an ISO-4217 code, a foreignKey needs a resolvable target, etc.).
 */
export const createFieldTypeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('text') }),
  z.object({ kind: z.literal('longText') }),
  z.object({
    kind: z.literal('number'),
    precision: z.number().int().min(0).max(MAX_NUMBER_PRECISION).optional(),
    format: z.enum(['plain', 'integer', 'decimal', 'percent']).optional(),
  }),
  z.object({ kind: z.literal('boolean') }),
  z.object({ kind: z.literal('date'), includesTime: z.boolean().optional() }),
  z.object({
    kind: z.literal('select'),
    options: z
      .array(createChoiceOptionSchema)
      .min(1)
      .refine((opts) => uniqueCaseInsensitive(opts.map((o) => o.name)), {
        message: 'select options must have unique names (case-insensitive)',
        params: { code: 'DUPLICATE_SELECT_OPTION' },
      }),
  }),
  z.object({
    kind: z.literal('multiSelect'),
    options: z
      .array(createChoiceOptionSchema)
      .min(1)
      .refine((opts) => uniqueCaseInsensitive(opts.map((o) => o.name)), {
        message: 'multiSelect options must have unique names (case-insensitive)',
        params: { code: 'DUPLICATE_SELECT_OPTION' },
      }),
  }),
  z.object({ kind: z.literal('url') }),
  z.object({ kind: z.literal('email') }),
  z.object({ kind: z.literal('phone') }),
  z.object({
    kind: z.literal('currency'),
    // ISO-4217 alphabetic code, e.g. USD, EUR.
    currencyCode: z.string().regex(/^[A-Z]{3}$/, 'currencyCode must be a 3-letter ISO-4217 code'),
    precision: z.number().int().min(0).max(MAX_NUMBER_PRECISION).optional(),
  }),
  z.object({
    kind: z.literal('foreignKey'),
    target: foreignKeyTargetSchema,
    allowMultiple: z.boolean().optional(),
  }),
]);
export type CreateFieldType = z.infer<typeof createFieldTypeSchema>;
export type CreateFieldKind = CreateFieldType['kind'];

/** One field to create on a table. */
export const createFieldSpecSchema = z.object({
  name: z.string().min(1).max(MAX_FIELD_NAME_LENGTH),
  fieldType: createFieldTypeSchema,
  description: z.string().optional(),
  /** Best-effort: the connector may not support per-field requiredness. */
  required: z.boolean().optional(),
  /**
   * Marks this field as the table's primary/title field. At most one field per
   * table may set it (validation rejects multiple). Connectors with a mandatory
   * title field (Notion, Webflow) use it; if none is set the connector picks or
   * injects its own default.
   */
  isPrimary: z.boolean().optional(),
});
export type CreateFieldSpec = z.infer<typeof createFieldSpecSchema>;

/** One table to create, together with its fields. */
export const createTableSpecSchema = z
  .object({
    name: z.string().min(1).max(MAX_TABLE_NAME_LENGTH),
    fields: z.array(createFieldSpecSchema).min(1),
    /**
     * Caller-assigned correlation handle, unique within the request. Used to
     * wire cross-table foreign keys (a sibling field's `target.ref`) and to
     * correlate this spec to its result row in the response.
     */
    ref: z.string().min(1),
  })
  .superRefine((table, ctx) => {
    // Field names unique within the table (case-insensitive).
    reportDuplicateNames(
      table.fields.map((f) => f.name),
      ctx,
      (index) => ['fields', index, 'name'],
      'field',
      'DUPLICATE_FIELD_NAME',
    );
    // At most one primary field per table.
    const primaryIndexes = table.fields.flatMap((f, i) => (f.isPrimary ? [i] : []));
    if (primaryIndexes.length > 1) {
      for (const index of primaryIndexes) {
        ctx.addIssue({
          code: 'custom',
          message: 'a table may designate at most one field as isPrimary',
          path: ['fields', index, 'isPrimary'],
          params: { code: 'MULTIPLE_PRIMARY_FIELDS' },
        });
      }
    }
  });
export type CreateTableSpec = z.infer<typeof createTableSpecSchema>;

/**
 * POST /workbook/:workbookId/schema/tables — create one or more tables (each with
 * its fields) on a remote service. Also the body of /schema/validate (dry-run)
 * and the editable `plan` returned by /schema/plan-from-folder.
 */
export const createSchemaTablesSchema = z
  .object({
    connectorAccountId: z.string().min(1),
    /** Remote base/parent under which to create (connector-interpreted). */
    remoteParentId: z.array(z.string()).optional(),
    tables: z.array(createTableSpecSchema).min(1),
    /** Also create a local DataFolder + schema.json for each created table. */
    materializeLocally: z.boolean().optional(),
    /** Parent folder for materialized folders. */
    parentFolderId: z.string().optional(),
  })
  .superRefine((request, ctx) => {
    // Table refs unique across the request (case-sensitive identifiers).
    reportDuplicateNames(
      request.tables.map((t) => t.ref),
      ctx,
      (index) => ['tables', index, 'ref'],
      'table ref',
      'DUPLICATE_TABLE_REF',
      false,
    );
    // Table names unique across the request (case-insensitive).
    reportDuplicateNames(
      request.tables.map((t) => t.name),
      ctx,
      (index) => ['tables', index, 'name'],
      'table',
      'DUPLICATE_TABLE_NAME',
    );
    // Each foreignKey `{ ref }` target must reference a table in this request.
    const refSet = new Set(request.tables.map((t) => t.ref));
    request.tables.forEach((table, tableIndex) => {
      table.fields.forEach((field, fieldIndex) => {
        if (field.fieldType.kind === 'foreignKey' && 'ref' in field.fieldType.target) {
          const targetRef = field.fieldType.target.ref;
          if (!refSet.has(targetRef)) {
            ctx.addIssue({
              code: 'custom',
              message: `foreignKey target ref "${targetRef}" does not match any table in this request`,
              path: ['tables', tableIndex, 'fields', fieldIndex, 'fieldType', 'target', 'ref'],
              params: { code: 'FK_UNKNOWN_REF' },
            });
          }
        }
      });
    });
  });
export type CreateSchemaTablesDto = z.infer<typeof createSchemaTablesSchema>;

/**
 * POST /workbook/:workbookId/schema/fields — add fields to an existing remote
 * table. Unlike /tables, a foreignKey here cannot use `{ ref }` (there are no
 * sibling tables being created); it must point at an existing remote table.
 */
export const createSchemaFieldsSchema = z
  .object({
    connectorAccountId: z.string().min(1),
    remoteTableId: z.array(z.string()).min(1),
    fields: z.array(createFieldSpecSchema).min(1),
    /** Re-fetch schema.json if the table is materialized as a local folder. */
    refreshLocalSchema: z.boolean().optional(),
  })
  .superRefine((request, ctx) => {
    reportDuplicateNames(
      request.fields.map((f) => f.name),
      ctx,
      (index) => ['fields', index, 'name'],
      'field',
      'DUPLICATE_FIELD_NAME',
    );
    const primaryIndexes = request.fields.flatMap((f, i) => (f.isPrimary ? [i] : []));
    if (primaryIndexes.length > 1) {
      for (const index of primaryIndexes) {
        ctx.addIssue({
          code: 'custom',
          message: 'at most one field may be marked isPrimary',
          path: ['fields', index, 'isPrimary'],
          params: { code: 'MULTIPLE_PRIMARY_FIELDS' },
        });
      }
    }
    // No in-request `{ ref }` FK targets when adding to an existing table.
    request.fields.forEach((field, fieldIndex) => {
      if (field.fieldType.kind === 'foreignKey' && 'ref' in field.fieldType.target) {
        ctx.addIssue({
          code: 'custom',
          message: 'foreignKey target must be an existingRemoteTableId when adding fields to an existing table',
          path: ['fields', fieldIndex, 'fieldType', 'target', 'ref'],
          params: { code: 'FK_REF_NOT_ALLOWED' },
        });
      }
    });
  });
export type CreateSchemaFieldsDto = z.infer<typeof createSchemaFieldsSchema>;

/** One source folder feeding a generated plan. */
export const generateCreatePlanSourceSchema = z.object({
  dataFolderId: z.string().min(1),
  /** Defaults to the source table/folder name. Ignored for existing-table sources. */
  newTableName: z.string().min(1).max(MAX_TABLE_NAME_LENGTH).optional(),
  /**
   * When set, this source's destination table ALREADY EXISTS: the DataFolderId of
   * an existing, materialized destination folder (it must belong to this workbook
   * and to `destinationConnectorAccountId`). The generated plan becomes an
   * add-fields plan — the source's fields diffed against that folder's current
   * fields, so only the missing ones remain — instead of a create-table plan.
   */
  existingDestinationDataFolderId: z.string().min(1).optional(),
});
export type GenerateCreatePlanSource = z.infer<typeof generateCreatePlanSourceSchema>;

/**
 * POST /workbook/:workbookId/schema/plan-from-folder — derive a create-table plan
 * from one or more existing source DataFolders, targeting a destination connector.
 * Read-only: returns an editable CreateSchemaTablesDto plus per-field notes.
 */
export const generateCreatePlanSchema = z
  .object({
    sources: z.array(generateCreatePlanSourceSchema).min(1),
    destinationConnectorAccountId: z.string().min(1),
    remoteParentId: z.array(z.string()).optional(),
    /**
     * Optional: map a source `linkedTableId` to an already-existing destination
     * table so a foreign key pointing outside the source set can still resolve.
     */
    linkedTableMappings: z
      .array(
        z.object({
          sourceLinkedTableId: z.string().min(1),
          destinationRemoteTableId: z.array(z.string()).min(1),
        }),
      )
      .optional(),
  })
  .superRefine((request, ctx) => {
    // Source folders must be distinct.
    reportDuplicateNames(
      request.sources.map((s) => s.dataFolderId),
      ctx,
      (index) => ['sources', index, 'dataFolderId'],
      'source dataFolderId',
      'DUPLICATE_SOURCE_FOLDER',
      false,
    );
  });
export type GenerateCreatePlanDto = z.infer<typeof generateCreatePlanSchema>;

// ── superRefine helpers ───────────────────────────────────────────────────────

function uniqueCaseInsensitive(values: string[]): boolean {
  return new Set(values.map((v) => v.trim().toLowerCase())).size === values.length;
}

/**
 * Emit a `custom` issue on every element whose (optionally case-insensitive)
 * name collides with an earlier element. Used for field names, table names,
 * refs, and source folder ids. The stable `code` is surfaced to the dry-run
 * /validate response via `issue.params.code`.
 */
function reportDuplicateNames(
  values: string[],
  ctx: z.RefinementCtx,
  pathFor: (index: number) => (string | number)[],
  label: string,
  code: string,
  caseInsensitive = true,
): void {
  const seen = new Map<string, number>();
  values.forEach((value, index) => {
    const key = caseInsensitive ? value.trim().toLowerCase() : value;
    if (seen.has(key)) {
      ctx.addIssue({
        code: 'custom',
        message: `duplicate ${label} "${value}"`,
        path: pathFor(index),
        params: { code },
      });
    } else {
      seen.set(key, index);
    }
  });
}
