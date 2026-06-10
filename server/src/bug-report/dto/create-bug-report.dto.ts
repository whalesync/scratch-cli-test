import { createBugReportSchema } from '@spinner/shared-types';
import { createZodDto } from 'nestjs-zod';

// NestJS bridge class for the shared create-bug-report request schema. The global
// ZodValidationPipe validates the incoming body against the shared zod schema.
export class CreateBugReportDto extends createZodDto(createBugReportSchema) {}
