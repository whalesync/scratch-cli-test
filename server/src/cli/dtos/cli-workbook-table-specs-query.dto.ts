import { cliListWorkbookTableSpecsQuerySchema } from '@spinner/shared-types';
import { createZodDto } from 'nestjs-zod';

/** Bridges the shared zod query schema into a NestJS DTO for `GET /cli/v1/workbooks/:workbookId/table-specs`. */
export class CliListWorkbookTableSpecsQueryDto extends createZodDto(cliListWorkbookTableSpecsQuerySchema) {}
