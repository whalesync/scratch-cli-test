import { IsObject, IsOptional, IsString } from 'class-validator';

export class UpdateDataFolderDto {
  @IsOptional()
  @IsString()
  filter?: string | null;

  @IsOptional()
  @IsObject()
  options?: Record<string, unknown>;
}

export type ValidatedUpdateDataFolderDto = Pick<UpdateDataFolderDto, 'filter' | 'options'>;
