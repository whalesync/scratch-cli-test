import type { WhalesyncShadowUserDto as IWhalesyncShadowUserDto } from '@spinner/shared-types';
import { IsNotEmpty, IsOptional, IsString } from 'class-validator';

// Response shapes are pure contracts and live in shared-types; re-export them so controllers can
// import everything for these endpoints from one place.
export type {
  WhalesyncRevokeSessionsResponse,
  WhalesyncSessionResponse,
  WhalesyncUserResponse,
} from '@spinner/shared-types';

/**
 * Body for `POST /internal/whalesync/sessions` and `POST /internal/whalesync/users`.
 * `whalesyncUserId` and `email` are required; `name` is optional. The global ValidationPipe enforces
 * these via the class-validator decorators below.
 */
export class WhalesyncShadowUserDto implements IWhalesyncShadowUserDto {
  @IsString()
  @IsNotEmpty()
  whalesyncUserId!: string;

  @IsString()
  @IsNotEmpty()
  email!: string;

  @IsString()
  @IsOptional()
  name?: string;
}
