import { routineRunListQuerySchema } from '@spinner/shared-types';
import { createZodDto } from 'nestjs-zod';

/** Bridges the shared zod query schema into a NestJS DTO for `GET /routine-runs`. */
export class RoutineRunListQueryDto extends createZodDto(routineRunListQuerySchema) {}
