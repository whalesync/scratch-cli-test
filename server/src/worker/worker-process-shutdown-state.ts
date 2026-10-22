/**
 * Process-wide record of whether this worker process has begun its graceful shutdown (a Cloud Run SIGTERM:
 * a deploy, or a scale-in of an autoscaled instance). Set by `QueueService.onModuleDestroy`, the first step
 * of that shutdown (DEV-11184), and cleared by `QueueService.onModuleInit`, so it lives exactly as long as
 * the worker does (in production a process starts once and then only goes on to exit; a test that builds
 * a second Nest app in the same process starts from a clean flag).
 *
 * Why it exists (DEV-12428): a job that hasn't drained within the shutdown budget keeps running until
 * SIGKILL while the Redis, Prisma and other clients it uses are closed under it, so whatever it throws from
 * then on is almost always the shutdown itself, not a real failure. Code that would otherwise persist a
 * terminal failure for such an error checks this flag and leaves its resumable state alone instead, so the
 * redelivered job resumes on the next instance — the same outcome a hard kill would have produced.
 *
 * Module-level rather than an injectable because the readers (e.g. `PublishPlanRunService`) sit below
 * `QueueService` in the dependency graph; injecting `QueueService` there would be circular.
 */
let workerProcessShutdownHasStarted = false;

export function markWorkerProcessShutdownStarted(): void {
  workerProcessShutdownHasStarted = true;
}

export function clearWorkerProcessShutdownStarted(): void {
  workerProcessShutdownHasStarted = false;
}

export function isWorkerProcessShuttingDown(): boolean {
  return workerProcessShutdownHasStarted;
}
