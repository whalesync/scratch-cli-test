import { IsArray, IsString } from 'class-validator';

export class PullAssetsDto {
  @IsArray()
  @IsString({ each: true })
  dataFolderIds!: string[];
}

export type ValidatedPullAssetsDto = PullAssetsDto;

export interface PullAssetsResponseDto {
  jobIds?: string[];
  warning?: string;
}
