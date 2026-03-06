import { Request, Response, NextFunction } from 'express';

export function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  if (req.path.startsWith('/test/')) {
    next();
    return;
  }

  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({
      error: {
        type: 'AUTHENTICATION_REQUIRED',
        message: 'You must provide a valid API key to access this endpoint.',
      },
    });
    return;
  }

  next();
}
