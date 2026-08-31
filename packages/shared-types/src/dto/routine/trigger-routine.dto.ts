import { z } from 'zod';

/** Request body for `POST /workbooks/:workbookId/routines/trigger` — start a manual run of one routine. */
export const triggerRoutineSchema = z.object({
  /** The routine file path to run, e.g. "routines/daily-sync.yaml". */
  filePath: z.string().min(1),
  /**
   * When true, EVERY pull step of this run is forced to a full pull (`options.fullPull: true` is
   * written onto the run's step snapshot), regardless of what the routine YAML says. This is how a
   * Live Export whose destination pull is incremental (`ENABLE_LIVE_EXPORT_INCREMENTAL_DESTINATION_PULL`)
   * runs a one-off "full sync" — the only pull mode that reconciles deletions (`deleteStaleFiles`)
   * and re-creates destination records that were deleted/archived out-of-band (DEV-11407). The
   * routine file itself is NOT modified: the next plain trigger is incremental again.
   * Omitted/false = each pull step uses its own `options.fullPull`.
   */
  forceFullPull: z.boolean().optional(),
});

export type TriggerRoutineDto = z.infer<typeof triggerRoutineSchema>;
