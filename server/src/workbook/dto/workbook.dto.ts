import {
  addWorkspacePermissionSchema,
  createWorkbookSchema,
  pullAssetsSchema,
  pullFilesSchema,
  updateWorkbookSchema,
  updateWorkbookSettingsSchema,
  updateWorkspacePermissionSchema,
} from '@spinner/shared-types';
import { createZodDto } from 'nestjs-zod';

// NestJS bridge classes for the shared workbook request schemas. The global
// ZodValidationPipe validates the incoming body against the shared zod schema.
export class CreateWorkbookDto extends createZodDto(createWorkbookSchema) {}
export class UpdateWorkbookDto extends createZodDto(updateWorkbookSchema) {}
export class UpdateWorkbookSettingsDto extends createZodDto(updateWorkbookSettingsSchema) {}
export class PullFilesDto extends createZodDto(pullFilesSchema) {}
export class PullAssetsDto extends createZodDto(pullAssetsSchema) {}
export class AddWorkspacePermissionDto extends createZodDto(addWorkspacePermissionSchema) {}
export class UpdateWorkspacePermissionDto extends createZodDto(updateWorkspacePermissionSchema) {}
