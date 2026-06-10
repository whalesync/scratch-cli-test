import { z } from 'zod';

export const updateDataFolderSchema = z.object({
  filter: z.string().nullable().optional(),
  options: z.record(z.string(), z.unknown()).optional(),
});

export type UpdateDataFolderDto = z.infer<typeof updateDataFolderSchema>;
export type ValidatedUpdateDataFolderDto = UpdateDataFolderDto;
