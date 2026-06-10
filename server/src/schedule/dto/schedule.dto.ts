import { createScheduleSchema, updateScheduleSchema } from '@spinner/shared-types';
import { createZodDto } from 'nestjs-zod';

// NestJS bridge classes for the shared schedule request schemas. The global
// ZodValidationPipe validates the incoming body against the shared zod schema.
export class CreateScheduleDto extends createZodDto(createScheduleSchema) {}
export class UpdateScheduleDto extends createZodDto(updateScheduleSchema) {}
