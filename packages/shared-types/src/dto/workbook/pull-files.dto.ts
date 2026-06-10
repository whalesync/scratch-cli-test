import { z } from 'zod';

export const pullFilesSchema = z.object({
  dataFolderIds: z.array(z.string()).optional(),
  /**
   * Requested pull mode. Omitted → `'full'` (the safe default matching
   * pre-incremental behavior). `'incremental'` is opt-in; per-folder demotion
   * to full still happens at job execution time (capability, bootstrap).
   */
  mode: z.enum(['full', 'incremental']).optional(),
});

export type PullFilesDto = z.infer<typeof pullFilesSchema>;
export type ValidatedPullFilesDto = PullFilesDto;

export interface PullFilesResponseDto {
  jobId?: string;
  jobIds?: string[];
  warning?: string;
}
