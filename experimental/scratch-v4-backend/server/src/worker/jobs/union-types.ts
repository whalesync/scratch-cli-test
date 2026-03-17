import { PollJobDefinition } from './job-definitions/poll.job';

export type JobDefinition = PollJobDefinition;
export type JobData = JobDefinition['data'];
export type JobTypes = JobDefinition['type'];
