import { z } from 'zod';

export const createBugReportSchema = z.object({
  title: z.string().optional(),
  bugType: z.string().optional(),
  userDescription: z.string().optional(),
  replayUrl: z.string().optional(),
  sessionId: z.string().optional(),
  pageUrl: z.string().optional(),
  workbookId: z.string().optional(),
  snapshotTableId: z.string().optional(),
  screenshot: z.string().optional(),
  additionalContext: z.record(z.string(), z.unknown()).optional(),
});

export type CreateBugReportDto = z.infer<typeof createBugReportSchema>;

export type ValidatedCreateBugReportDto = Required<
  Pick<CreateBugReportDto, 'title' | 'bugType' | 'userDescription' | 'pageUrl'>
> &
  Pick<
    CreateBugReportDto,
    'additionalContext' | 'replayUrl' | 'sessionId' | 'workbookId' | 'snapshotTableId' | 'screenshot'
  >;
