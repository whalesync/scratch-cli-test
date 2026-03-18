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
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    res.status(401).json({
      Fault: {
        type: "AuthenticationFault",
        Error: [
          {
            Message:
              "message=AuthenticationFailed; errorCode=003200; statusCode=401",
            code: "003200",
          },
        ],
      },
    });
    return;
  }

  next();
}
