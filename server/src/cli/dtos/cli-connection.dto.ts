import type { Service } from '@spinner/shared-types';
import { IsObject, IsOptional, IsString } from 'class-validator';

/**
 * DTO for creating a connection via CLI.
 * The CLI sends userProvidedParams directly — the exact keys depend on the service
 * (e.g. Webflow needs {apiKey}, Shopify needs {shopDomain, apiKey},
 * WordPress needs {endpoint, username, password}).
 */
export class CreateCliConnectionDto {
  @IsString()
  service?: Service;

  @IsObject()
  userProvidedParams?: Record<string, string>;

  @IsString()
  @IsOptional()
  displayName?: string;
}

export type ValidatedCreateCliConnectionDto = Required<Pick<CreateCliConnectionDto, 'service' | 'userProvidedParams'>> &
  Pick<CreateCliConnectionDto, 'displayName'>;
