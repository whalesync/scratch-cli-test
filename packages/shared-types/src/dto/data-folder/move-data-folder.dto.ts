import { z } from 'zod';

export const moveDataFolderSchema = z.object({
  parentFolderId: z.string().nullable().optional(),
});

export type MoveDataFolderDto = z.infer<typeof moveDataFolderSchema>;
export type ValidatedMoveDataFolderDto = MoveDataFolderDto;
