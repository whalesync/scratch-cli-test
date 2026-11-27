import {
  whalesyncLiveExportAccessSchema,
  whalesyncShadowUserSchema,
  whalesyncUpdateSubscriptionSchema,
} from '@spinner/shared-types';
import { createZodDto } from 'nestjs-zod';

// Response shapes are pure contracts and live in shared-types; re-export them so controllers can
// import everything for these endpoints from one place.
export type {
  WhalesyncListLiveExportsResponse,
  WhalesyncSessionResponse,
  WhalesyncSetLiveExportAccessResponse,
  WhalesyncUpdateSubscriptionResponse,
} from '@spinner/shared-types';

/**
 * Body for `POST /internal/whalesync/sessions`.
 * NestJS bridge for the shared zod schema; the global ZodValidationPipe enforces it.
 */
export class WhalesyncShadowUserDto extends createZodDto(whalesyncShadowUserSchema) {}

/**
 * Body for `PUT /internal/whalesync/teams/:whalesyncTeamId/live-export-access`.
 * NestJS bridge for the shared zod schema; the global ZodValidationPipe enforces it.
 */
export class WhalesyncLiveExportAccessDto extends createZodDto(whalesyncLiveExportAccessSchema) {}

/**
 * Body for `PATCH /internal/whalesync/subscription`.
 * NestJS bridge for the shared zod schema; the global ZodValidationPipe enforces it.
 */
export class WhalesyncUpdateSubscriptionDto extends createZodDto(whalesyncUpdateSubscriptionSchema) {}
