import { IsArray, IsIn, IsOptional, IsString } from 'class-validator';

export class PullFilesDto {
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  dataFolderIds?: string[];

  /**
   * Requested pull mode. Omitted → `'full'` (the safe default matching
   * pre-incremental behavior). `'incremental'` is opt-in; per-folder demotion
   * to full still happens at job execution time (capability, bootstrap).
   */
  @IsOptional()
  @IsIn(['full', 'incremental'])
  mode?: 'full' | 'incremental';
}

export type ValidatedPullFilesDto = PullFilesDto;

export interface PullFilesResponseDto {
  jobId?: string;
  jobIds?: string[];
  warning?: string;
}
