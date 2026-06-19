import { z } from 'zod';

/** Query params for `GET /workbooks/:workbookId/routine-runs`. */
export const routineRunListQuerySchema = z.object({
  /** Filter runs to a single routine file path, e.g. "routines/daily-sync.yaml". */
  routineFilePath: z.string().optional(),
  /**
   * When true, include each run's `steps`, and on every step its `job` (the pull/sync/publish job in
   * the `/jobs` wire shape). `z.stringbool` coerces the `?includeJobs=true` query string to a boolean.
   */
  includeJobs: z.stringbool().optional(),
});

export type RoutineRunListQueryDto = z.infer<typeof routineRunListQuerySchema>;
