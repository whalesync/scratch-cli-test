import { IsArray, IsBoolean, IsOptional, IsString } from 'class-validator';

/**
 * DTO for creating a linked table via CLI.
 */
export class CreateCliLinkedTableDto {
  @IsString()
  @IsOptional()
  name?: string;

  @IsString()
  @IsOptional()
  connectorAccountId?: string;

  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  tableId?: string[];

  @IsString()
  @IsOptional()
  filter?: string;
}

export type ValidatedCreateCliLinkedTableDto = Required<
  Pick<CreateCliLinkedTableDto, 'name' | 'connectorAccountId' | 'tableId'>
> &
  CreateCliLinkedTableDto;

/**
 * Query parameters for listing available tables via CLI.
 */
export class AvailableTablesQueryDto {
  @IsString()
  @IsOptional()
  connectionId?: string;

  @IsBoolean()
  @IsOptional()
  refresh?: boolean;
}

export type ValidatedAvailableTablesQueryDto = AvailableTablesQueryDto;
