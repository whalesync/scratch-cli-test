import { z } from 'zod';

/** Request body for `POST /workbooks/:workbookId/routines/trigger` — start a manual run of one routine. */
export const triggerRoutineSchema = z.object({
  /** The routine file path to run, e.g. "routines/daily-sync.yaml". */
  filePath: z.string().min(1),
});

export type TriggerRoutineDto = z.infer<typeof triggerRoutineSchema>;
