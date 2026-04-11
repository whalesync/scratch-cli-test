import { Request, Response, NextFunction } from "express";
import { store } from "../store";

/**
 * Tokens matching this regex are treated as "obviously invalid" sentinels and
 * rejected with 401, even though they're well-formed Bearer tokens. This lets
 * the same integration test ("rejects invalid credentials") exercise both the
 * real Affinity API and the fake — the real API rejects them because they
 * aren't real keys, and the fake rejects them by name.
 *
 * Smoke fixtures use `fake-smoke-test-key` and pre-baked seed scripts use
 * arbitrary tokens — none of those match this pattern, so they pass.
 */
const OBVIOUSLY_INVALID_TOKEN = /(^|[-_])(not-?a-?real|invalid|bad-token)([-_]|$)/i;

/**
 * Validate `Authorization: Bearer <non-empty-token>` and decrement live quota
 * counters. Skips `/test/*` routes (test admin is unauthenticated by convention).
 *
 * We don't check the actual token value against any real key — fakes don't
 * validate keys, they just confirm the auth header is well-formed and not an
 * obvious test sentinel.
 */
export function authMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (req.path.startsWith("/test/")) {
    next();
    return;
  }

  const reject = (message: string): void => {
    res
      .status(401)
      .set("WWW-Authenticate", 'Bearer realm="api.affinity.co"')
      .json({ errors: [{ code: "unauthenticated", message }] });
  };

  const header = req.headers.authorization;
  if (!header || typeof header !== "string") {
    reject("Missing Authorization header");
    return;
  }

  const match = header.match(/^Bearer\s+(.+)$/);
  if (!match || match[1].trim().length === 0) {
    reject("Invalid Authorization header");
    return;
  }

  const token = match[1].trim();
  if (OBVIOUSLY_INVALID_TOKEN.test(token)) {
    reject("Invalid API key");
    return;
  }

  // Successful auth — count it against quota.
  store.consumeQuota();
  next();
}
