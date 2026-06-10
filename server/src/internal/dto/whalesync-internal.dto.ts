import { whalesyncShadowUserSchema } from '@spinner/shared-types';
import { createZodDto } from 'nestjs-zod';

// Response shapes are pure contracts and live in shared-types; re-export them so controllers can
// import everything for these endpoints from one place.
export type {
  WhalesyncRevokeSessionsResponse,
  WhalesyncSessionResponse,
  WhalesyncUserResponse,
} from '@spinner/shared-types';

/**
 * Body for `POST /internal/whalesync/sessions` and `POST /internal/whalesync/users`.
 * NestJS bridge for the shared zod schema; the global ZodValidationPipe enforces it.
 */
export class WhalesyncShadowUserDto extends createZodDto(whalesyncShadowUserSchema) {}
