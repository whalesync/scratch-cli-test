import { createRoutineFileSchema } from '@spinner/shared-types';
import { createZodDto } from 'nestjs-zod';

/** Bridges the shared zod schema into a NestJS DTO for `POST /routines/file`. */
export class CreateRoutineFileDto extends createZodDto(createRoutineFileSchema) {}
