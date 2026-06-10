import { z } from 'zod';

export const pullAssetsSchema = z.object({
  dataFolderIds: z.array(z.string()),
  /** When true, files are stored in Scratch (GCS). When false, only metadata and content hash are saved. */
  rehost: z.boolean().optional(),
});

export type PullAssetsDto = z.infer<typeof pullAssetsSchema>;
export type ValidatedPullAssetsDto = PullAssetsDto;

export interface PullAssetsResponseDto {
  jobIds?: string[];
  warning?: string;
}
