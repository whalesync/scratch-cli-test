import { runMigrationSchema } from '@spinner/shared-types';
import { createZodDto } from 'nestjs-zod';

// NestJS bridge class for the shared run-migration request schema. The global
// ZodValidationPipe validates the incoming body against the shared zod schema.
export class RunMigrationDto extends createZodDto(runMigrationSchema) {}
