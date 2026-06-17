import { z } from 'zod';

/**
 * Request body for `POST /workbooks/:id/routines/file` — create a new routine
 * YAML file. `path` must be a single `.yaml`/`.yml` file directly under
 * `routines/`; the server enforces that boundary and validates the YAML before
 * committing (a malformed routine is rejected with a 400).
 */
export const createRoutineFileSchema = z.object({
  path: z.string().min(1),
  content: z.string(),
});

export type CreateRoutineFileDto = z.infer<typeof createRoutineFileSchema>;
