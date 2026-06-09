import { workbookListQuerySchema } from '@spinner/shared-types';
import { createZodDto } from 'nestjs-zod';

/**
 * NestJS DTO for the `GET /workbook` query string. The validation rules live in
 * `workbookListQuerySchema` in shared-types; this thin generated class is what
 * NestJS needs as the `@Query()` metatype, and the global `ZodValidationPipe`
 * validates the incoming query against the shared schema.
 */
export class WorkbookListQueryDto extends createZodDto(workbookListQuerySchema) {}
