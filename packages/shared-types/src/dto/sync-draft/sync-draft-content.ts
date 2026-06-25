import { z } from 'zod';
import type { TransformerConfig } from '../../sync-mapping';
import { createFieldSpecSchema, createTableSpecSchema } from '../schema/create-schema.dto';

/**
 * The structured working copy a SyncDraft holds in its `tableMappings` column —
 * the desired-state input the apply reconciler consumes (Phase 2) and the saga
 * checkpoint materialize writes back into (Phase 1).
 *
 * Zod-first because:
 *   - it is validated untrusted input on `PATCH /sync-drafts/:id`, and
 *   - placeholders embed the approved create plan, which is *already* a zod
 *     schema (`createTableSpecSchema` / `createFieldSpecSchema`) — composing the
 *     schemas keeps one source of truth.
 *
 * The `SyncDraft` data interface (db/sync-draft.ts) imports the inferred types
 * for its `tableMappings` field, so the wire shape and the validation schema
 * cannot drift.
 *
 * Invariant: a placeholder `ref` is stable, unique within the draft, assigned by
 * us, never derived from a remote service and never regenerated per attempt.
 * Mappings reference placeholders by `ref`; materialize results are written back
 * by `ref`.
 */

// ── Destination of a draft table mapping ──────────────────────────────────────

/** The remote table id + (once apply runs) data folder a materialized placeholder resolved to. */
export const draftPlaceholderTableResolvedSchema = z.object({
  /** Remote table id assigned by the connector on creation, e.g. [baseId, tableId]. */
  remoteTableId: z.array(z.string()).min(1),
  /** Destination DataFolder id — populated by apply (Phase 2), not materialize. */
  dataFolderId: z.string().optional(),
  /** The name actually created, which may carry a server-appended `(1)`-style disambiguator. */
  actualName: z.string().optional(),
});
export type DraftPlaceholderTableResolved = z.infer<typeof draftPlaceholderTableResolvedSchema>;

export const draftTableDestinationSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('existing'),
    dataFolderId: z.string().min(1),
  }),
  z.object({
    kind: z.literal('placeholderTable'),
    /** Stable, unique-in-draft handle. Mappings + materialize writebacks key on this. */
    ref: z.string().min(1),
    /** Destination connector account the table is created on (the plan includes where to create it). */
    connectorAccountId: z.string().min(1),
    /** Remote base/parent under which to create (connector-interpreted), e.g. an Airtable base id. */
    remoteParentId: z.array(z.string()).optional(),
    /** The approved table-create spec the user signed off on in the UI. */
    createSpec: createTableSpecSchema,
    /** Absent until materialize succeeds; presence is the "resolved" signal. */
    resolved: draftPlaceholderTableResolvedSchema.optional(),
  }),
]);
export type DraftTableDestination = z.infer<typeof draftTableDestinationSchema>;

// ── A field added to an existing destination table ────────────────────────────

export const draftFieldAdditionSchema = z.object({
  /** Stable, unique-in-draft handle. `placeholderField` column refs point at this. */
  ref: z.string().min(1),
  /** The approved field-create spec. */
  createFieldSpec: createFieldSpecSchema,
  /** Absent until materialize succeeds. */
  resolved: z
    .object({
      remoteFieldId: z.string().min(1),
      actualName: z.string().optional(),
    })
    .optional(),
});
export type DraftFieldAddition = z.infer<typeof draftFieldAdditionSchema>;

// ── Column + record-matching mappings ─────────────────────────────────────────

/**
 * Destination side of a column mapping. The client expresses to-be-created
 * fields by `placeholderField` ref (by name, via the field addition / table
 * spec) — never by column path id. Apply resolves those refs → real column ids
 * by name after creating folders, and owns the v2 mapping format.
 */
export const draftColumnDestinationSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('existing'), columnId: z.string().min(1) }),
  z.object({ kind: z.literal('placeholderField'), ref: z.string().min(1) }),
]);
export type DraftColumnDestination = z.infer<typeof draftColumnDestinationSchema>;

/**
 * A transformer pipeline carried verbatim from a create plan's `FieldMappingNote`
 * into the draft, then threaded into the resulting sync's column-mapping source by
 * apply. The draft is a pass-through carrier: it does NOT re-validate the
 * connector-specific transformer shape here — the authoritative validation is the
 * full `TransformerConfig` union, enforced when the sync is saved. We only assert
 * each entry names a `type`, and type the schema as `TransformerConfig` so the
 * value flows create-plan → draft → sync mapping without being reshaped.
 */
const draftColumnTransformerSchema = z
  .object({ type: z.string().min(1) })
  .passthrough() as unknown as z.ZodType<TransformerConfig>;

export const draftColumnMappingSchema = z.object({
  /** Existing source column path id (the source is always a real, existing folder). */
  source: z.object({ columnId: z.string().min(1) }),
  destination: draftColumnDestinationSchema,
  /**
   * Optional transformer pipeline copied verbatim from the create plan
   * (CRM Mirror), applied to the source value before it is written to the
   * destination column. Apply moves this onto `ColumnMappingSource.transformers`.
   */
  transformers: z.array(draftColumnTransformerSchema).min(1).optional(),
});
export type DraftColumnMapping = z.infer<typeof draftColumnMappingSchema>;

export const draftRecordMatchingSchema = z.object({
  source: z.object({ columnId: z.string().min(1) }),
  destination: draftColumnDestinationSchema,
});
export type DraftRecordMatching = z.infer<typeof draftRecordMatchingSchema>;

// ── A single table mapping ────────────────────────────────────────────────────

export const draftTableMappingSchema = z
  .object({
    /** Stable, unique-in-draft handle for this table mapping. */
    ref: z.string().min(1),
    /** Existing source folder only — placeholder sources are not supported (yet). */
    source: z.object({ dataFolderId: z.string().min(1) }),
    destination: draftTableDestinationSchema,
    /** Only meaningful when destination is `existing`; ignored otherwise. */
    fieldAdditions: z.array(draftFieldAdditionSchema).optional(),
    columnMappings: z.array(draftColumnMappingSchema),
    recordMatching: draftRecordMatchingSchema.optional(),
  })
  .superRefine((table, ctx) => {
    // Field additions only apply to an existing destination table.
    if (table.destination.kind === 'placeholderTable' && table.fieldAdditions && table.fieldAdditions.length > 0) {
      ctx.addIssue({
        code: 'custom',
        message: 'fieldAdditions are only valid when the destination is an existing table',
        path: ['fieldAdditions'],
        params: { code: 'FIELD_ADDITIONS_ON_PLACEHOLDER_TABLE' },
      });
    }
  });
export type DraftTableMapping = z.infer<typeof draftTableMappingSchema>;

/** The full `tableMappings` payload. */
export const draftTableMappingsSchema = z.array(draftTableMappingSchema);
