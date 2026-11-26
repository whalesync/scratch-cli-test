import {
  whalesyncLinkTeamsSchema,
  whalesyncShadowUserSchema,
  whalesyncUpdateSubscriptionSchema,
} from '@spinner/shared-types';
import { createZodDto } from 'nestjs-zod';

// Response shapes are pure contracts and live in shared-types; re-export them so controllers can
// import everything for these endpoints from one place.
export type {
  WhalesyncClearSubscriptionResponse,
  WhalesyncLinkTeamsResponse,
  WhalesyncListLiveExportsResponse,
  WhalesyncPendingTeamLinksResponse,
  WhalesyncRevokeSessionsResponse,
  WhalesyncSessionResponse,
  WhalesyncUpdateSubscriptionResponse,
  WhalesyncUserResponse,
} from '@spinner/shared-types';

/**
 * Body for `POST /internal/whalesync/sessions` and `POST /internal/whalesync/users`.
 * NestJS bridge for the shared zod schema; the global ZodValidationPipe enforces it.
 */
export class WhalesyncShadowUserDto extends createZodDto(whalesyncShadowUserSchema) {}

/**
 * Body for `PATCH /internal/whalesync/subscription`.
 * NestJS bridge for the shared zod schema; the global ZodValidationPipe enforces it.
 */
export class WhalesyncUpdateSubscriptionDto extends createZodDto(whalesyncUpdateSubscriptionSchema) {}

/**
 * Body for `POST /internal/whalesync/team-links`.
 * NestJS bridge for the shared zod schema; the global ZodValidationPipe enforces it.
 */
export class WhalesyncLinkTeamsDto extends createZodDto(whalesyncLinkTeamsSchema) {}
