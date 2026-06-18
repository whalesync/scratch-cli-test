import { pushRoutineFilesSchema } from '@spinner/shared-types';
import { createZodDto } from 'nestjs-zod';

/** Bridges the shared zod schema into a NestJS DTO for `POST /cli/v1/workbooks/:id/routines/push`. */
export class PushRoutineFilesDto extends createZodDto(pushRoutineFilesSchema) {}
