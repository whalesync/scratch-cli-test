export class JobCanceledError extends Error {
  constructor(jobId: string) {
    super(`Job ${jobId} was cancelled`);
    this.name = 'JobCanceledError';
  }
}
