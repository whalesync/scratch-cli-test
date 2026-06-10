import { z } from 'zod';

export const renameDataFolderSchema = z.object({
  name: z.string().min(1),
});

export type RenameDataFolderDto = z.infer<typeof renameDataFolderSchema>;
export type ValidatedRenameDataFolderDto = RenameDataFolderDto;
