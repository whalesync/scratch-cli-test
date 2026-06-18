import { triggerRoutineSchema } from '@spinner/shared-types';
import { createZodDto } from 'nestjs-zod';

/** Bridges the shared `triggerRoutineSchema` into NestJS for `POST /workbooks/:workbookId/routines/trigger`. */
export class TriggerRoutineDto extends createZodDto(triggerRoutineSchema) {}
