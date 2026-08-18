import { NextFunction, Request, Response } from "express";
import { store, WebflowScope } from "../store";

/**
 * The scopes attached to the current request's token, resolved by
 * {@link authMiddleware} so route handlers can enforce per-endpoint scopes.
 */
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      webflowScopes?: WebflowScope[];
    }
  }
}

/** Reject anything that isn't a recognised `Authorization: Bearer <token>`. */
export function authMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (req.path.startsWith("/test/")) {
    next();
    return;
  }

  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    res.status(401).json({
      message: "Unauthorized",
      code: "unauthorized",
      externalReference: null,
      details: [],
    });
    return;
  }

  const scopes = store.scopesForToken(authHeader.slice("Bearer ".length));
  if (!scopes) {
    res.status(401).json({
      message: "Unauthorized",
      code: "unauthorized",
      externalReference: null,
      details: [],
    });
    return;
  }

  req.webflowScopes = scopes;
  next();
}

/**
 * Enforce one scope, answering exactly as Webflow does when it is missing —
 * a 403 whose body names the scope. That body is the entire reason DEV-11321
 * was fixable: it is the only place the required scope is stated.
 */
export function requireScope(scope: WebflowScope) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (req.webflowScopes?.includes(scope)) {
      next();
      return;
    }
    res.status(403).json({
      message: `OAuthForbidden: You are missing the following scopes - '${scope}'`,
      code: "missing_scopes",
      externalReference: null,
      details: [],
    });
  };
}
