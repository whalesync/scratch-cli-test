import { createRunId, RoutineRunId, RunId, RunContext as SharedRunContext } from '@spinner/shared-types';
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

/* eslint-disable @typescript-eslint/no-explicit-any -- required for TypeScript's infer pattern */
export type JobHandlerBuilder<TDefinition extends JobDefinitionBuilder<any, any, any, any, any>> =
  TDefinition extends JobDefinitionBuilder<any, infer TData, infer TPublicProgress, infer TJobProgress, infer TResult>
    ? {
        run: (params: {
          jobId: string;
          runId?: string;
          routineRunId?: RoutineRunId;
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
/* eslint-enable @typescript-eslint/no-explicit-any */

// export type JobHandlerBuilder2<TBullMqJob extends Job<any, any, any>> =
//   TBullMqJob extends Job<any, infer TResult, any>
//     ? {
//         run: (job: TBullMqJob) => Promise<TResult>;
//       }
//     : never;

// The canonical RunContext lives in @spinner/shared-types so the web client and desktop app can
// consume it. Intersect with JsonSafeObject on the server side so it stays assignable to the
// JSON-typed slots it flows through (BullMQ job data, Prisma `Json`) without per-call-site casts.
export type RunContext = SharedRunContext & JsonSafeObject;

export function createRunContext(
  trigger: RunContext['trigger'],
  options?: { runId?: RunId; parentJobId?: string; routineRunId?: RoutineRunId },
): RunContext {
  return {
    runId: options?.runId ?? createRunId(),
    trigger,
    ...(options?.parentJobId && { parentJobId: options.parentJobId }),
    ...(options?.routineRunId && { routineRunId: options.routineRunId }),
  };
}
