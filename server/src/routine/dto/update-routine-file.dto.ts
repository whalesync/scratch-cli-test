import { updateRoutineFileSchema } from '@spinner/shared-types';
import { createZodDto } from 'nestjs-zod';

/** Bridges the shared zod schema into a NestJS DTO for `PUT /routines/file`. */
export class UpdateRoutineFileDto extends createZodDto(updateRoutineFileSchema) {}
