import { z } from 'zod';

export const createWorkbookSchema = z.object({
  name: z.string().optional(),
});

export type CreateWorkbookDto = z.infer<typeof createWorkbookSchema>;
export type ValidatedCreateWorkbookDto = CreateWorkbookDto;
