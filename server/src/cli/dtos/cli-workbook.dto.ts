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
  readonly path?: string | null;
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
  /**
   * The connector account's on-disk folder *structure* version (the
   * `ConnectorAccount.version` column). The CLI records this in the workspace
   * marker at `init` and compares it against the server's current value on
   * download: a change means the server restructured this connection's folder
   * layout (e.g. the DEV-9698 Webflow flat→nested migration) and the local
   * clone is stale and must be re-cloned. Generic — no connector knowledge.
   */
  readonly version?: number;
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
  readonly connectorAccounts?: CliConnectorAccountDto[];
  readonly configGitUrl?: string;
  /**
   * Git URL for the per-workbook "scratch" repo holding standalone connector-less files (DEV-10424).
   * The CLI clones this like the config repo (non-connector, materialized on `main`) so scratch
   * folders/files appear in the desktop workspace. Empty/undefined ⇒ the workbook has no scratch repo.
   */
  readonly scratchGitUrl?: string;
}

/**
 * CLI response format for listing workbooks.
 */
export class ListWorkbooksResponseDto {
  readonly workbooks?: CliWorkbookResponseDto[];
}
