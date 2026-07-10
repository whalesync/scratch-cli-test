import { QueueOptions } from 'bullmq';

/**
 * The single BullMQ queue shared by the enqueuer (api-service), the worker (worker-service),
 * and the job-inspection/cancel paths in JobService.
 */
export const WORKER_QUEUE_NAME = 'worker-queue';

/**
 * Cap for the queue's events stream (`bull:worker-queue:events`). BullMQ trims this stream by
 * entry COUNT on every XADD — never by byte size — and its default of 10,000 entries let a
 * single 63-folder pull emitting a multi-hundred-KB progress payload per page fill the entire
 * 1 GB production Redis on 2026-07-10 (the stream is one key, so the growth is invisible to
 * key-count monitoring).
 *
 * 1,000 entries is 20+ minutes of history at normal event rates. The only consumer that reads
 * the stream (`job.waitUntilFinished` via the shared QueueEvents in BullEnqueuerService) tails
 * live events and never needs to read that far back.
 *
 * IMPORTANT: every `new Queue(WORKER_QUEUE_NAME, …)` instantiation rewrites this value into the
 * queue's Redis meta hash on startup (BullMQ `Queue.metaValues`), and the last writer wins. So
 * EVERY instantiation site must pass `streams: WORKER_QUEUE_STREAM_OPTIONS`, or the cap silently
 * reverts to 10,000 the next time that code path runs.
 */
export const WORKER_QUEUE_STREAM_OPTIONS: QueueOptions['streams'] = {
  events: { maxLen: 1000 },
};
