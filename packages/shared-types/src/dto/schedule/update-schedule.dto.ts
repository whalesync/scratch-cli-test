import { z } from 'zod';

export const updateScheduleSchema = z.object({
  name: z.string().optional(),
  cronExpression: z.string().optional(),
  /**
   * IANA timezone for the cron's wall-clock time. Present (string or null) means "change
   * it"; omitted (undefined) leaves the stored timezone unchanged.
   */
  timezone: z.string().nullable().optional(),
  enabled: z.boolean().optional(),
});

export type UpdateScheduleDto = z.infer<typeof updateScheduleSchema>;
export type ValidatedUpdateScheduleDto = UpdateScheduleDto;
