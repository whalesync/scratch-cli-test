import { createFileSchema, updateFileSchema } from '@spinner/shared-types';
import { createZodDto } from 'nestjs-zod';

// NestJS bridge classes for the shared file request schemas. The global
// ZodValidationPipe validates the incoming body against the shared zod schema.
export class CreateFileDto extends createZodDto(createFileSchema) {}
export class UpdateFileDto extends createZodDto(updateFileSchema) {}
