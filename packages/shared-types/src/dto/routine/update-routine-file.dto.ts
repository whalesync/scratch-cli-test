import { z } from 'zod';

/**
 * Request body for `PUT /workbooks/:id/routines/file` — replace the content of
 * an existing routine YAML file at `path`. The server validates the YAML before
 * committing (a malformed routine is rejected with a 400).
 */
export const updateRoutineFileSchema = z.object({
  path: z.string().min(1),
  content: z.string(),
});

export type UpdateRoutineFileDto = z.infer<typeof updateRoutineFileSchema>;
