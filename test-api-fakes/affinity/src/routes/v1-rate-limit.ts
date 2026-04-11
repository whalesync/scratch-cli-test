import { Router } from "express";
import { store } from "../store";

const router = Router();

/**
 * `GET /rate-limit` — v1-era endpoint that returns the same rate-limit info as
 * the `x-ratelimit-*` response headers, plus a `used` count.
 *
 * The body shape matches the real Affinity v1 endpoint exactly:
 *
 * ```
 * {
 *   "rate": {
 *     "api_key_per_minute": { limit, remaining, reset, used },
 *     "org_monthly":        { limit, remaining, reset, used }
 *   }
 * }
 * ```
 *
 * `reset` values are static fakes (60s for the per-minute window, ~30 days for
 * the monthly window) — the fake doesn't simulate real time windows. Counters
 * reset only on `/test/reset`. This is enough for tests that just need realistic
 * shape and live `used`/`remaining` numbers.
 */
router.get("/rate-limit", (_req, res) => {
  const userLimit = 900;
  const orgLimit = 100_000;

  const userUsed = store.userMinuteUsed;
  const orgUsed = store.orgMonthlyUsed;

  res.json({
    rate: {
      api_key_per_minute: {
        limit: userLimit,
        remaining: Math.max(0, userLimit - userUsed),
        reset: 60,
        used: userUsed,
      },
      org_monthly: {
        limit: orgLimit,
        remaining: Math.max(0, orgLimit - orgUsed),
        reset: 30 * 24 * 60 * 60,
        used: orgUsed,
      },
    },
  });
});

export default router;
