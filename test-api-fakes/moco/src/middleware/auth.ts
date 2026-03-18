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
  if (!authHeader || !authHeader.startsWith("Token token=")) {
    res.status(401).json({
      message: "unauthorized",
    });
    return;
  }

  next();
}
