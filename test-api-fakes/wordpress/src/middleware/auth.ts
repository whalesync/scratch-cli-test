import { Request, Response, NextFunction } from "express";

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
  if (!authHeader || !authHeader.startsWith("Basic ")) {
    res.status(401).json({
      code: "rest_not_logged_in",
      message: "You are not currently logged in.",
      data: { status: 401 },
    });
    return;
  }

  next();
}
