import { z } from 'zod';

export const updateWorkbookSchema = z.object({
  name: z.string().min(1).optional(),
});

export type UpdateWorkbookDto = z.infer<typeof updateWorkbookSchema>;
export type ValidatedUpdateWorkbookDto = UpdateWorkbookDto;
