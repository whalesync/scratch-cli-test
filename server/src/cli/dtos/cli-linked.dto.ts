import { IsArray, IsBoolean, IsIn, IsOptional, IsString } from 'class-validator';

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

/**
 * Body for the CLI pull endpoints (`scratchmd linked pull` / `pull-all`).
 * Selects the pull mode; omitted → `'full'` (the safe default matching
 * pre-incremental behavior). Per-folder demotion to full still happens at job
 * execution time (capability, bootstrap, `fullPullOnly`).
 */
export class CliPullDto {
  @IsOptional()
  @IsIn(['full', 'incremental'])
  mode?: 'full' | 'incremental';
}

export type ValidatedCliPullDto = CliPullDto;
