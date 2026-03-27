import { Injectable, NestMiddleware } from '@nestjs/common';
import { json as bodyParserJson, urlencoded as bodyParserUrlencoded } from 'body-parser';
import { NextFunction, Request, Response, raw } from 'express';

@Injectable()
export class RawBodyMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: () => unknown): void {
    raw({ type: '*/*' })(req, res, next);
  }
}

/**
 * Middleware for parsing JSON request bodies.
 */
// Needed to have control over how we parse requests. Technique borrowed from
// https://stackoverflow.com/questions/54346465/access-raw-body-of-stripe-webhook-in-nest-js
@Injectable()
export class JsonBodyMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: () => unknown): void {
    // We want to parse *everything* as JSON, regardless of what the content type header is set to. NOTE: We've
    bodyParserJson({ type: '*/*', limit: '5mb' })(req, res, next);
  }
}

/**
 * Middleware for parsing URL-encoded request bodies (application/x-www-form-urlencoded).
 * Used by OAuth token endpoints which receive form-encoded POST requests per the OAuth spec.
 */
@Injectable()
export class UrlencodedBodyMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: () => unknown): void {
    bodyParserUrlencoded({ extended: true })(req, res, next);
  }
}

/**
 * Middleware that rewrites '/workspace' to '/workbook' in request URLs,
 * allowing all workbook endpoints to also respond to workspace paths.
 */
@Injectable()
export class WorkspaceAliasMiddleware implements NestMiddleware {
  use(req: Request, _res: Response, next: NextFunction): void {
    req.url = req.url.replace(/\/workspace(s?)\b/g, '/workbook$1');
    req.originalUrl = req.originalUrl.replace(/\/workspace(s?)\b/g, '/workbook$1');
    next();
  }
}
