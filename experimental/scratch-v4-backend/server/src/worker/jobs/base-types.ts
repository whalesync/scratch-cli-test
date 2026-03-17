import { Progress } from 'src/types/progress';
import { JsonSafeObject } from 'src/utils/objects';

export interface JobResult {
  success: boolean;
  result?: number;
  error?: string;
  executionTime: number;
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
      }
    : never;

export interface RunContext extends JsonSafeObject {
  runId: string;
  trigger: 'web' | 'scheduler' | 'cli' | 'job';
}
