import { z } from 'zod';

export const updateScheduleSchema = z.object({
  name: z.string().optional(),
  cronExpression: z.string().optional(),
  enabled: z.boolean().optional(),
});

export type UpdateScheduleDto = z.infer<typeof updateScheduleSchema>;
export type ValidatedUpdateScheduleDto = UpdateScheduleDto;
