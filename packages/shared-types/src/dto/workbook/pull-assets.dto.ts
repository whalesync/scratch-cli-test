import { IsString } from 'class-validator';

export class PullAssetsDto {
  @IsString()
  dataFolderId!: string;
}

export type ValidatedPullAssetsDto = PullAssetsDto;

export interface PullAssetsResponseDto {
  jobId?: string;
  warning?: string;
}
