import { createDataFolderSchema, updateDataFolderSchema } from '@spinner/shared-types';
import { createZodDto } from 'nestjs-zod';

// NestJS bridge classes for the shared data-folder request schemas. The global
// ZodValidationPipe validates the incoming body against the shared zod schema.
export class CreateDataFolderDto extends createZodDto(createDataFolderSchema) {}
export class UpdateDataFolderDto extends createZodDto(updateDataFolderSchema) {}
