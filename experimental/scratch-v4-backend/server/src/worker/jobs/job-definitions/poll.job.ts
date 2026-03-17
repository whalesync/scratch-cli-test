import { JsonSafeObject } from 'src/utils/objects';
import { JobDefinitionBuilder, JobResult } from '../base-types';

export type PollJobDefinition = JobDefinitionBuilder<
  'poll',
  {
    workbookId: string;
    connectorAccountId: string;
    userId: string;
  },
  { filesProcessed: number },
  JsonSafeObject,
  JobResult
>;
