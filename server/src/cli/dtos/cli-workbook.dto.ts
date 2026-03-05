import { IsIn, IsOptional, IsString } from 'class-validator';

/**
 * DTO for creating a workbook via CLI.
 */
export class CreateCliWorkbookDto {
  @IsString()
  @IsOptional()
  name?: string;
}

export type ValidatedCreateCliWorkbookDto = CreateCliWorkbookDto;

/**
 * Query parameters for listing workbooks via CLI.
 */
export class ListWorkbooksQueryDto {
  @IsString()
  @IsOptional()
  @IsIn(['name', 'createdAt', 'updatedAt'])
  sortBy?: 'name' | 'createdAt' | 'updatedAt';

  @IsString()
  @IsOptional()
  @IsIn(['asc', 'desc'])
  sortOrder?: 'asc' | 'desc';
}

export type ValidatedListWorkbooksQueryDto = ListWorkbooksQueryDto;

/**
 * CLI response format for a data folder.
 */
export class CliDataFolderDto {
  readonly id?: string;
  readonly name?: string;
}

/**
 * CLI response format for a connector account (V2 workbooks).
 */
export class CliConnectorAccountDto {
  readonly id?: string;
  readonly displayName?: string;
  readonly service?: string;
  readonly repoPath?: string;
  readonly gitUrl?: string;
  readonly dataFolders?: CliDataFolderDto[];
}

/**
 * CLI response format for a workbook.
 * Simplified version for CLI output.
 */
export class CliWorkbookResponseDto {
  readonly id?: string;
  readonly name?: string;
  readonly createdAt?: string;
  readonly updatedAt?: string;
  readonly tableCount?: number;
  readonly version?: number;
  readonly dataFolders?: CliDataFolderDto[];
  readonly connectorAccounts?: CliConnectorAccountDto[];
  readonly gitUrl?: string;
}

/**
 * CLI response format for listing workbooks.
 */
export class ListWorkbooksResponseDto {
  readonly workbooks?: CliWorkbookResponseDto[];
}
