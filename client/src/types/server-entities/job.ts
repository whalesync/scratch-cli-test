import type { Job } from '@spinner/shared-types';

// `Job` is the shared contract; `JobEntity` is kept as an alias so existing
// `@/types/server-entities/job` importers keep working.
export type { Job } from '@spinner/shared-types';
export type JobEntity<TPublicProgress = object> = Job<TPublicProgress>;
