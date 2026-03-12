import { createRunId, RunId } from '@spinner/shared-types';
import { Progress } from 'src/types/progress';
import { JsonSafeObject } from 'src/utils/objects';

export interface JobResult {
  success: boolean;
  result?: number;
  error?: string;
  executionTime: number;
  workbookCount?: number;
}

export type JobDefinitionBuilder<
  TKey extends string,
  TData extends JsonSafeObject,
  TPublicProgress extends JsonSafeObject,
  TJobProgress extends JsonSafeObject,
  TResult,
> = {
  type: TKey;
  data: TData & { type: TKey };
  publicProgress: TPublicProgress;
  result: TResult;
  initialPublicProgress: TPublicProgress;
  initialJobProgress: TJobProgress;
};

// export type RunFn<T extends JobDefinitionBuilder<any, any, any>> =
//   T extends JobDefinitionBuilder<any, infer X, infer Z> ? (data: X, job: JoBullMqJob<T>) => Promise<Z> : never;

// export type JobHandlerRunParams<TDefinition extends JobDefinitionBuilder<any, any, any>> =
//   TDefinition extends JobDefinitionBuilder<any, infer TData, any>
//     ? { data: TData; updateProgress: (progress: JsonSafeObject) => Promise<void> }
//     : never;

export type { Progress };

export type JobHandlerBuilder<TDefinition extends JobDefinitionBuilder<any, any, any, any, any>> =
  TDefinition extends JobDefinitionBuilder<any, infer TData, infer TPublicProgress, infer TJobProgress, infer TResult>
    ? {
        run: (params: {
          jobId: string;
          runId?: string;
          data: TData;
          checkpoint: (progress: Omit<Progress<TPublicProgress, TJobProgress>, 'timestamp'>) => Promise<void>;
          progress: Progress<TPublicProgress, TJobProgress>;
          abortSignal: AbortSignal;
        }) => Promise<TResult>;
        terminate?: (params: {
          jobId: string;
          reason: 'canceled' | 'termina-failure';
          data: TData;
          progress: Progress<TPublicProgress>;
        }) => Promise<TResult>;
      }
    : never;

// export type JobHandlerBuilder2<TBullMqJob extends Job<any, any, any>> =
//   TBullMqJob extends Job<any, infer TResult, any>
//     ? {
//         run: (job: TBullMqJob) => Promise<TResult>;
//       }
//     : never;

// TODO: create a shared-type for this context
export interface RunContext extends JsonSafeObject {
  runId: string;
  trigger: 'web' | 'scheduler' | 'cli' | 'job';
  parentJobId?: string; // The DBJob ID of the job that triggered this job
}

export function createRunContext(
  trigger: RunContext['trigger'],
  options?: { runId?: RunId; parentJobId?: string },
): RunContext {
  return {
    runId: options?.runId ?? createRunId(),
    trigger,
    ...(options?.parentJobId && { parentJobId: options.parentJobId }),
  };
}
