export interface RateLimiterSpec {
  /** Maximum number of requests (points) in the window */
  points: number;
  /** Window duration in seconds */
  duration: number;
}
