import { z } from 'zod';
import { ScheduleAction } from '../../enums';

export const createScheduleSchema = z.object({
  name: z.string(),
  action: z.enum(ScheduleAction),
  entityId: z.string(),
  cronExpression: z.string(),
  /** IANA timezone for the cron's wall-clock time, or null/omitted for UTC. */
  timezone: z.string().nullable().optional(),
  enabled: z.boolean().optional(),
});

export type CreateScheduleDto = z.infer<typeof createScheduleSchema>;

// Required fields are already required by the schema, so the "validated" variant
// is just the DTO itself; kept for backwards-compatible imports.
export type ValidatedCreateScheduleDto = Required<
  Pick<CreateScheduleDto, 'name' | 'action' | 'entityId' | 'cronExpression'>
> &
  CreateScheduleDto;
