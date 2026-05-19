import { IsEnum, IsNotEmpty, IsObject, IsOptional, IsString } from 'class-validator';
import type { Service } from '../../enums';
import { AuthType } from '../../enums';

export class CreateConnectorAccountDto {
  @IsString()
  @IsNotEmpty()
  readonly service?: Service;

  @IsObject()
  @IsOptional()
  readonly userProvidedParams?: Record<string, string>;

  /**
   * Optional structured extras supplied directly by the client. Used by
   * connectors whose extras shape is too rich for the string-only
   * `userProvidedParams` path (currently: GENERIC_API).
   *
   * When present, the server skips `parseUserProvidedParams` for the extras
   * portion and uses these directly. The per-service type guard
   * (e.g. isGenericApiConnectorExtras) validates the shape.
   */
  @IsObject()
  @IsOptional()
  readonly extras?: Record<string, unknown>;

  @IsEnum(AuthType)
  @IsOptional()
  readonly authType?: AuthType;

  @IsString()
  @IsOptional()
  readonly modifier?: string;

  @IsString()
  @IsOptional()
  readonly displayName?: string;
}

export type ValidatedCreateConnectorAccountDto = Required<Pick<CreateConnectorAccountDto, 'service'>> &
  Pick<CreateConnectorAccountDto, 'userProvidedParams' | 'extras' | 'authType' | 'modifier' | 'displayName'>;
