import { IsNotEmpty, IsObject, IsOptional, IsString } from 'class-validator';
import { DecryptedCredentials } from '../../connector-account-types';

export class UpdateConnectorAccountDto {
  @IsString()
  @IsNotEmpty()
  @IsOptional()
  readonly displayName?: string;

  @IsObject()
  @IsOptional()
  readonly userProvidedParams?: Partial<DecryptedCredentials>;

  @IsString()
  @IsOptional()
  readonly modifier?: string;

  @IsObject()
  @IsOptional()
  readonly extras?: Record<string, any>;
}

export type ValidatedUpdateConnectorAccountDto = UpdateConnectorAccountDto;
