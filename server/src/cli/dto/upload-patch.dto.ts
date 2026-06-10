import { uploadPatchCommitSchema, uploadPatchInitSchema } from '@spinner/shared-types';
import { createZodDto } from 'nestjs-zod';

// NestJS bridge classes for the shared upload-patch request schemas. The global
// ZodValidationPipe validates the incoming body against the shared zod schema.
export class UploadPatchInitDto extends createZodDto(uploadPatchInitSchema) {}
export class UploadPatchCommitDto extends createZodDto(uploadPatchCommitSchema) {}
