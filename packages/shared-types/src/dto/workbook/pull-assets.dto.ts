import { IsArray, IsBoolean, IsOptional, IsString } from 'class-validator';

export class PullAssetsDto {
  @IsArray()
  @IsString({ each: true })
  dataFolderIds!: string[];

  /** When true, files are stored in Scratch (GCS). When false, only metadata and content hash are saved. */
  @IsOptional()
  @IsBoolean()
  rehost?: boolean;
}

export type ValidatedPullAssetsDto = PullAssetsDto;

export interface PullAssetsResponseDto {
  jobIds?: string[];
  warning?: string;
}
