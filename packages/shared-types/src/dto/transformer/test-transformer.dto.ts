import { z } from 'zod';
import { TransformerConfig } from '../../sync-mapping';

export const testTransformerSchema = z.object({
  workbookId: z.string().min(1),
  fileId: z.string().min(1),
  path: z.string().min(1),
  transformerConfig: z.record(z.string(), z.unknown()),
});

// `transformerConfig` is validated as a generic object but carries the `TransformerConfig` type for consumers.
export type TestTransformerDto = Omit<z.infer<typeof testTransformerSchema>, 'transformerConfig'> & {
  transformerConfig: TransformerConfig;
};

export interface TestTransformerResponse {
  success: boolean;
  value: unknown;
  error?: string;
  originalValue?: unknown;
}
