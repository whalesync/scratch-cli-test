import { listRoutineFilesQuerySchema } from '@spinner/shared-types';
import { createZodDto } from 'nestjs-zod';

/** Bridges the shared zod schema into a NestJS DTO for `GET /cli/v1/workbooks/:id/routines/files`. */
export class ListRoutineFilesQueryDto extends createZodDto(listRoutineFilesQuerySchema) {}
