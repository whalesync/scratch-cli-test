import { z } from 'zod';

/** Query params for `GET /workbooks/:workbookId/routine-runs/:runId`. */
export const routineRunGetQuerySchema = z.object({
  /**
   * When true, include each step's `job` (the pull/sync/publish job in the `/jobs` wire shape).
   * `z.stringbool` coerces the `?includeJobs=true` query string to a boolean.
   */
  includeJobs: z.stringbool().optional(),
});

export type RoutineRunGetQueryDto = z.infer<typeof routineRunGetQuerySchema>;
