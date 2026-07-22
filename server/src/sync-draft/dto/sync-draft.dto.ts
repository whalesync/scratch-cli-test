import {
  applySyncDraftSchema,
  createSyncDraftSchema,
  patchSyncDraftSchema,
  saveSyncDraftSchema,
} from '@spinner/shared-types';
import { createZodDto } from 'nestjs-zod';

// NestJS bridge classes for the shared SyncDraft request schemas. The global
// ZodValidationPipe validates the incoming body against the shared zod schema.
export class CreateSyncDraftDtoClass extends createZodDto(createSyncDraftSchema) {}
export class PatchSyncDraftDtoClass extends createZodDto(patchSyncDraftSchema) {}
export class ApplySyncDraftDtoClass extends createZodDto(applySyncDraftSchema) {}
export class SaveSyncDraftDtoClass extends createZodDto(saveSyncDraftSchema) {}
