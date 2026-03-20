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

  const apiKey = req.headers["x-api-key"];
  if (!apiKey) {
    res.status(401).json({
      message: "Invalid API key",
    });
    return;
  }

  next();
}
