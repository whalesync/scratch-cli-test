import { z } from 'zod';

/** Query params for `GET /workbooks/:workbookId/routine-runs`. */
export const routineRunListQuerySchema = z.object({
  /** Filter runs to a single routine file path, e.g. "routines/daily-sync.yaml". */
  routineFilePath: z.string().optional(),
});

export type RoutineRunListQueryDto = z.infer<typeof routineRunListQuerySchema>;
