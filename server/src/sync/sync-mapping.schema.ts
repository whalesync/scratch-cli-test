import { TransformerTypes } from '@spinner/shared-types';
import { z } from 'zod';

// -- Transformer schemas --

const autoConvertOptionsSchema = z
  .object({
    targetType: z.enum(['string', 'number', 'integer', 'boolean', 'array']),
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

const transformerConfigSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal(TransformerTypes.AutoConvert), options: autoConvertOptionsSchema }),
  z.object({ type: z.literal(TransformerTypes.StringToNumber), options: stringToNumberOptionsSchema }),
  z.object({ type: z.literal(TransformerTypes.SourceFkToDestFk), options: sourceFkToDestFkOptionsSchema }),
  z.object({ type: z.literal(TransformerTypes.LookupField), options: lookupFieldOptionsSchema }),
  z.object({ type: z.literal(TransformerTypes.NotionToHtml), options: z.record(z.string(), z.never()).optional() }),
  z.object({ type: z.literal(TransformerTypes.AirmarkToHtml), options: z.record(z.string(), z.never()).optional() }),
  z.object({ type: z.literal(TransformerTypes.HtmlToAirmark), options: z.record(z.string(), z.never()).optional() }),
  z.object({ type: z.literal(TransformerTypes.WebflowOption), options: z.record(z.string(), z.never()).optional() }),
  z.object({ type: z.literal(TransformerTypes.Slugify), options: z.record(z.string(), z.never()).optional() }),
]);

// -- Column / Table / Sync mapping schemas --

const columnMappingSchema = z
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
