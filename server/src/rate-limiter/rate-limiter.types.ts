export interface RateLimiterSpec {
  /** Maximum number of requests (points) in the window */
  points: number;
  /** Window duration in seconds */
  duration: number;
  /**
   * The service's documented cap on *simultaneous* in-flight requests, when it
   * publishes one (e.g. QuickBooks Online allows 10 per realmId). This is a
   * separate constraint from `points`/`duration` — a service can throttle you
   * for too many at once even while you are well under its per-minute quota —
   * so callers that fan out (parallel folder pulls) must respect both.
   *
   * Leave unset when the service documents no such cap; consumers then fall back
   * to deriving a parallelism ceiling from the request rate alone.
   */
  maxConcurrency?: number;
}
