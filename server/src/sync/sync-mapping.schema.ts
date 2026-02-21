import { z } from 'zod';

// -- Transformer schemas --

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
  })
  .strict();

const lookupFieldOptionsSchema = z
  .object({
    referencedDataFolderId: z.string().min(1),
    referencedFieldPath: z.string().min(1),
  })
  .strict();

const transformerConfigSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('string_to_number'), options: stringToNumberOptionsSchema }),
  z.object({ type: z.literal('source_fk_to_dest_fk'), options: sourceFkToDestFkOptionsSchema }),
  z.object({ type: z.literal('lookup_field'), options: lookupFieldOptionsSchema }),
  z.object({ type: z.literal('notion_to_html'), options: z.record(z.string(), z.never()).optional() }),
]);

// -- Column / Table / Sync mapping schemas --

const columnMappingSchema = z
  .object({
    sourceColumnId: z.string().min(1),
    destinationColumnId: z.string().min(1),
    transformer: transformerConfigSchema.optional(),
  })
  .strict();

const tableMappingSchema = z
  .object({
    sourceDataFolderId: z.string().min(1),
    destinationDataFolderId: z.string().min(1),
    columnMappings: z.array(columnMappingSchema).min(1),
    recordMatching: z
      .object({
        sourceColumnId: z.string().min(1),
        destinationColumnId: z.string().min(1),
      })
      .strict()
      .optional(),
  })
  .strict();

const syncMappingSchema = z
  .object({
    version: z.literal(1),
    tableMappings: z.array(tableMappingSchema).min(1),
  })
  .strict();

// -- Request body schemas --

export const saveSyncBodySchema = z
  .object({
    displayName: z.string().min(1),
    mappings: syncMappingSchema,
  })
  .strict();

export const previewRecordBodySchema = z
  .object({
    sourceId: z.string().min(1),
    filePath: z.string().min(1),
    columnMappings: z.array(columnMappingSchema).min(1),
  })
  .strict();

export const validateMappingBodySchema = z
  .object({
    sourceId: z.string().min(1),
    destId: z.string().min(1),
    columnMappings: z.array(columnMappingSchema).min(1),
  })
  .strict();
