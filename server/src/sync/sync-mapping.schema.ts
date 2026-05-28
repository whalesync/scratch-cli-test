import { StoredSyncMapping, TransformerTypes } from '@spinner/shared-types';
import { z } from 'zod';

// -- Transformer schemas --

const arrayAutoConvertOptionsSchema = z
  .object({
    targetType: z.enum(['string', 'number', 'integer', 'boolean']),
  })
  .strict();

const autoConvertOptionsSchema = z
  .object({
    targetType: z.enum(['string', 'number', 'integer', 'boolean', 'array']),
    preserveNull: z.boolean().optional(),
  })
  .strict();

const stringToNumberOptionsSchema = z
  .object({
    stripCurrency: z.boolean().optional(),
    parseInteger: z.boolean().optional(),
  })
  .strict()
  .optional();

const sourceFkToDestFkOptionsSchema = z
  .object({
    referencedDataFolderId: z.string().min(1),
    onUnresolved: z.enum(['fail', 'ignore']).optional(),
    outputType: z.enum(['array', 'single']).optional(),
  })
  .strict();

const lookupFieldOptionsSchema = z
  .object({
    referencedDataFolderId: z.string().min(1),
    referencedFieldPath: z.string().min(1),
  })
  .strict();

const jsonpathOptionsSchema = z
  .object({
    expression: z.string().min(1),
    arrayHandling: z.enum(['first', 'array', 'join_space', 'join_comma', 'concat']).optional(),
  })
  .strict();

const sourceAssetToDestAssetOptionsSchema = z
  .object({
    sourceDataFolderId: z.string().min(1),
    destinationDataFolderId: z.string().min(1),
    onUnresolved: z.enum(['fail', 'ignore']).optional(),
    outputType: z.enum(['array', 'single']).optional(),
  })
  .strict();

const ensureTypeOptionsSchema = z
  .object({
    expectedType: z.enum(['string', 'number', 'boolean', 'object', 'array']),
    onFailure: z.enum(['null', 'error', 'omit', 'other']),
    fallbackValue: z.string().optional(),
  })
  .strict();

const notionFileUrlOptionsSchema = z
  .object({
    arrayHandling: z.enum(['first', 'array']).optional(),
  })
  .strict()
  .optional();

const transformerConfigSchema: z.ZodType = z.discriminatedUnion('type', [
  z.object({ type: z.literal(TransformerTypes.AutoConvert), options: autoConvertOptionsSchema }),
  z.object({ type: z.literal(TransformerTypes.StringToNumber), options: stringToNumberOptionsSchema }),
  z.object({ type: z.literal(TransformerTypes.SourceFkToDestFk), options: sourceFkToDestFkOptionsSchema }),
  z.object({ type: z.literal(TransformerTypes.LookupField), options: lookupFieldOptionsSchema }),
  z.object({ type: z.literal(TransformerTypes.NotionToHtml), options: z.record(z.string(), z.never()).optional() }),
  z.object({ type: z.literal(TransformerTypes.AirmarkToHtml), options: z.record(z.string(), z.never()).optional() }),
  z.object({ type: z.literal(TransformerTypes.HtmlToAirmark), options: z.record(z.string(), z.never()).optional() }),
  z.object({ type: z.literal(TransformerTypes.ArrayAutoConvert), options: arrayAutoConvertOptionsSchema }),
  z.object({ type: z.literal(TransformerTypes.WebflowOption), options: z.record(z.string(), z.never()).optional() }),
  z.object({
    type: z.literal(TransformerTypes.WebflowOptionIdToValue),
    options: z.record(z.string(), z.never()).optional(),
  }),
  z.object({ type: z.literal(TransformerTypes.Slugify), options: z.record(z.string(), z.never()).optional() }),
  z.object({ type: z.literal(TransformerTypes.JSONPath), options: jsonpathOptionsSchema }),
  z.object({
    type: z.literal(TransformerTypes.SourceAssetToDestAsset),
    options: sourceAssetToDestAssetOptionsSchema,
  }),
  z.object({ type: z.literal(TransformerTypes.EnsureType), options: ensureTypeOptionsSchema }),
  z.object({ type: z.literal(TransformerTypes.NotionFileUrl), options: notionFileUrlOptionsSchema }),
  z.object({ type: z.literal(TransformerTypes.EscapeHtml), options: z.record(z.string(), z.never()).optional() }),
  z.object({ type: z.literal(TransformerTypes.Trim), options: z.record(z.string(), z.never()).optional() }),
  z.object({
    type: z.literal(TransformerTypes.SkipIfDestMatches),
    options: z
      .object({
        sourceExpression: z.string().optional(),
        destinationExpression: z.string().optional(),
      })
      .strict()
      .optional(),
  }),
  z.object({
    type: z.literal(TransformerTypes.ReplaceNewlines),
    options: z.object({ replacement: z.string().optional() }).strict().optional(),
  }),
  z.object({
    type: z.literal(TransformerTypes.ReplaceRegex),
    options: z.object({ pattern: z.string().min(1), replacement: z.string().optional() }).strict(),
  }),
  z.object({
    type: z.literal(TransformerTypes.MatchAssetByHash),
    options: z
      .object({
        sourceDataFolderId: z.string().min(1),
        destinationDataFolderId: z.string().min(1),
        sourceIdPath: z.string().optional(),
        destinationIdPath: z.string().optional(),
        onUnresolved: z.enum(['fail', 'ignore']).optional(),
        outputType: z.enum(['array', 'single']).optional(),
      })
      .strict(),
  }),
  z.object({
    type: z.literal(TransformerTypes.WrapObject),
    options: z.object({ template: z.record(z.string(), z.unknown()) }).strict(),
  }),
  z.object({
    type: z.literal(TransformerTypes.MapArray),
    options: z
      .object({
        elementTransformer: z.lazy(() => transformerConfigSchema),
      })
      .strict(),
  }),
  z.object({
    type: z.literal(TransformerTypes.SkipIfDestArrayMatches),
    options: z
      .object({
        sourceElementExpression: z.string().optional(),
        destinationElementExpression: z.string().optional(),
        matchOrdering: z.boolean().optional(),
      })
      .strict()
      .optional(),
  }),
]);

// -- V1 column / table / sync mapping schemas (legacy on-disk shape) --
//
// Frozen as of the introduction of `Sync.mappingsV2`. New writes go to v2;
// existing rows still hold v1 until backfill. Kept in lockstep with the v1
// TypeScript shapes in `packages/shared-types/src/sync-mapping.ts`.

const columnMappingV1Schema = z
  .object({
    sourceColumnId: z.string().min(1),
    destinationColumnId: z.string().min(1),
    transformer: transformerConfigSchema.optional(),
    transformers: z.array(transformerConfigSchema).min(1).optional(),
  })
  .strict()
  .refine((data) => !(data.transformer && data.transformers), {
    message: 'Cannot set both "transformer" and "transformers" — use one or the other',
  });

const tableMappingV1Schema = z
  .object({
    sourceDataFolderId: z.string().min(1),
    destinationDataFolderId: z.string().min(1),
    columnMappings: z.array(columnMappingV1Schema).min(1),
    recordMatching: z
      .object({
        sourceColumnId: z.string().min(1),
        destinationColumnId: z.string().min(1),
      })
      .strict()
      .optional(),
  })
  .strict();

export const syncMappingV1Schema = z
  .object({
    version: z.literal(1),
    tableMappings: z.array(tableMappingV1Schema).min(1),
  })
  .strict();

/**
 * Back-compat alias. Existing consumers (`sync.service.ts`, `debug-openrouter.ts`)
 * import `syncMappingSchema`; keep the name pointing at v1 so the surface stays
 * stable while the v2 rollout is in progress.
 *
 * TODO(DEV-10008): drop this alias once the v1 column is removed and all
 * consumers have migrated to the v1/v2 schemas explicitly.
 */
export const syncMappingSchema = syncMappingV1Schema;

// -- V2 column / table / sync mapping schemas (orphan-aware shape) --
//
// V2 lifts `when` to the top-level column mapping and makes `source` a
// discriminated union. A destination column may carry multiple rules, one
// per `(destinationColumnId, when)` pair. Kept in lockstep with the v2
// TypeScript shapes in `packages/shared-types/src/sync-mapping.ts`.

const columnMappingV2ColumnSourceSchema = z
  .object({
    kind: z.literal('column'),
    columnId: z.string().min(1),
    transformer: transformerConfigSchema.optional(),
    transformers: z.array(transformerConfigSchema).min(1).optional(),
  })
  .strict();

const columnMappingV2ConstantSourceSchema = z
  .object({
    kind: z.literal('constant'),
    // V1-of-v2 limits constant values to JSON primitives. Arrays/objects are
    // deferred until per-element type-checking against the destination column
    // type lands. The destination-column type compatibility check itself
    // (refinement (c) in the plan) needs DataFolder schema info and lives at
    // the service layer, not in this bare zod schema.
    value: z.union([z.string(), z.number(), z.boolean(), z.null()]),
  })
  .strict();

const columnMappingV2SourceSchema = z.discriminatedUnion('kind', [
  columnMappingV2ColumnSourceSchema,
  columnMappingV2ConstantSourceSchema,
]);

const columnMappingWhenSchema = z.enum(['matched', 'unmatched', 'always']);

const columnMappingV2Schema = z
  .object({
    destinationColumnId: z.string().min(1),
    when: columnMappingWhenSchema.optional(),
    source: columnMappingV2SourceSchema,
  })
  .strict()
  .superRefine((data, ctx) => {
    if (data.source.kind === 'column') {
      // Transformer exclusivity — mirrors the v1 refinement, now scoped to
      // the column source variant.
      if (data.source.transformer && data.source.transformers) {
        ctx.addIssue({
          code: 'custom',
          message: 'Cannot set both "transformer" and "transformers" — use one or the other',
          path: ['source'],
        });
      }
      // Refinement (a): a column-sourced mapping cannot fire on orphan
      // buckets — there is no source value to copy when there is no source.
      if (data.when === 'unmatched' || data.when === 'always') {
        ctx.addIssue({
          code: 'custom',
          message:
            'A column-sourced mapping is only legal with when="matched" (or omitted). To force a value on orphan records, use a constant source.',
          path: ['when'],
        });
      }
    }
  });

const unmatchedSourcePolicySchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('create') }).strict(),
  z.object({ type: z.literal('ignore') }).strict(),
]);

const unmatchedDestinationPolicySchema = z
  .object({
    withMatchKey: z.enum(['ignore', 'apply']),
    withoutMatchKey: z.enum(['ignore', 'apply']),
  })
  .strict();

const tableMappingV2Schema = z
  .object({
    sourceDataFolderId: z.string().min(1),
    destinationDataFolderId: z.string().min(1),
    columnMappings: z.array(columnMappingV2Schema).min(1),
    recordMatching: z
      .object({
        sourceColumnId: z.string().min(1),
        destinationColumnId: z.string().min(1),
      })
      .strict()
      .optional(),
    unmatchedSourcePolicy: unmatchedSourcePolicySchema.optional(),
    unmatchedDestinationPolicy: unmatchedDestinationPolicySchema.optional(),
  })
  .strict()
  .superRefine((data, ctx) => {
    // Refinement (b): a constant mapping cannot target the recordMatching
    // destination column. The match-key column identifies which records
    // belong to this sync — overwriting it from a constant would destroy
    // the link. Enforced regardless of `when`.
    const matchCol = data.recordMatching?.destinationColumnId;
    if (matchCol !== undefined) {
      data.columnMappings.forEach((cm, idx) => {
        if (cm.destinationColumnId === matchCol && cm.source.kind === 'constant') {
          ctx.addIssue({
            code: 'custom',
            message: `A constant mapping cannot write to the recordMatching destination column "${matchCol}". The match-key column identifies which records belong to this sync; overwriting it from a constant would destroy that link.`,
            path: ['columnMappings', idx, 'source'],
          });
        }
      });
    }
    // Refinement (d): one mapping per (destinationColumnId, when) pair.
    // Two mappings sharing a destination column but with different `when`
    // values are legal and expected (the archive case is canonical).
    const seen = new Map<string, number>();
    data.columnMappings.forEach((cm, idx) => {
      const whenKey = cm.when ?? 'matched';
      const key = `${cm.destinationColumnId}::${whenKey}`;
      const firstIdx = seen.get(key);
      if (firstIdx !== undefined) {
        ctx.addIssue({
          code: 'custom',
          message: `Duplicate mapping for destinationColumnId="${cm.destinationColumnId}" when="${whenKey}" (already defined at columnMappings[${firstIdx}]). Only one mapping per (destinationColumnId, when) pair is allowed.`,
          path: ['columnMappings', idx],
        });
      } else {
        seen.set(key, idx);
      }
    });
  });

export const syncMappingV2Schema = z
  .object({
    version: z.literal(2),
    tableMappings: z.array(tableMappingV2Schema).min(1),
  })
  .strict();

// -- On-disk shape parser (read choke point) --

/**
 * Parse a `Sync` row's on-disk mappings into the `StoredSyncMapping`
 * discriminated union. Prefers `mappingsV2` when non-null; falls back to v1
 * `mappings`. Returns the row with `mappingsV2` stripped and `mappings`
 * replaced by the parsed shape so downstream consumers narrow on
 * `mappings.version` and cannot reach around the choke point.
 *
 * This is the only sanctioned way to read `Sync.mappings` / `Sync.mappingsV2`.
 * The ESLint rule on `prisma.sync.find*` is the static enforcement; this is
 * the runtime parse + strip.
 */
export function parseStoredMappings<R extends { mappings: unknown; mappingsV2: unknown }>(
  row: R,
): Omit<R, 'mappings' | 'mappingsV2'> & { mappings: StoredSyncMapping } {
  // zod schemas parse to structurally-equivalent types with plain `string`
  // where the TS shape uses branded IDs (DataFolderId etc.). The structural
  // validation is what matters at the read boundary; the brand is a static
  // marker that the rest of the codebase already casts to/from at every
  // serialization boundary. Match that convention here.
  const parsed =
    row.mappingsV2 !== null && row.mappingsV2 !== undefined
      ? (syncMappingV2Schema.parse(row.mappingsV2) as unknown as StoredSyncMapping)
      : (syncMappingV1Schema.parse(row.mappings) as unknown as StoredSyncMapping);
  const { mappings: _v1, mappingsV2: _v2, ...rest } = row;
  void _v1;
  void _v2;
  return { ...rest, mappings: parsed };
}

// -- Request body schemas --

export const saveSyncBodySchema = z
  .object({
    displayName: z.string().min(1),
    mappings: syncMappingSchema,
    validateMappings: z.boolean().optional(),
    schedule: z.string().optional(),
    publishAfterSync: z.boolean().optional(),
  })
  .strict();

export const previewRecordBodySchema = z
  .object({
    sourceFolderId: z.string().min(1),
    destFolderId: z.string().min(1),
    filePath: z.string().min(1),
    columnMappings: z.array(columnMappingV1Schema).min(1),
    recordMatching: z
      .object({
        sourceColumnId: z.string().min(1),
        destinationColumnId: z.string().min(1),
      })
      .strict()
      .optional(),
  })
  .strict();

export const validateMappingBodySchema = z
  .object({
    sourceId: z.string().min(1),
    destId: z.string().min(1),
    columnMappings: z.array(columnMappingV1Schema).min(1),
  })
  .strict();

/** Body for validate-mapping-type: trace type through one mapping's pipeline (admin only) */
export const validateMappingTypeBodySchema = z
  .object({
    sourceFolderId: z.string().min(1),
    destFolderId: z.string().min(1),
    sourceColumnId: z.string().min(1),
    destinationColumnId: z.string().min(1),
    transformers: z.array(transformerConfigSchema).default([]),
  })
  .strict();
