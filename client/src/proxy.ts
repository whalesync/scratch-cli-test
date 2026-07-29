import { clerkMiddleware, createRouteMatcher } from '@clerk/nextjs/server';
import { NextFetchEvent, NextMiddleware, NextRequest, NextResponse } from 'next/server';
import { RouteUrls } from './utils/route-urls';

// DEV-11008 / pentest SCR-013 — start the Content-Security-Policy in Report-Only so violations can
// be reviewed in the test env's DevTools console, then flip to false to enforce. A nonce-based
// `strict: true` policy is the planned follow-up hardening (this Phase 1 leaves script-src permissive).
const CSP_REPORT_ONLY = true;

function createMiddleware(): NextMiddleware {
  const isPublicRoute = createRouteMatcher(RouteUrls.publicRoutePatterns);

  // Origins the app talks to, sourced from the same env vars the app itself reads. Clerk merges these
  // onto its own defaults (which already cover Clerk's frontend API, telemetry, Turnstile and Stripe).
  const apiHttpOrigin = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3010';
  const apiWebSocketOrigin = apiHttpOrigin.replace(/^http/, 'ws');
  const postHogHost = process.env.NEXT_PUBLIC_POSTHOG_HOST || 'https://us.i.posthog.com';

  const clerkMiddlewareFn = clerkMiddleware(
    async (auth, req) => {
      const { userId, redirectToSignIn } = await auth();

      if (!userId && !isPublicRoute(req)) {
        return redirectToSignIn({ returnBackUrl: originalUrl(req) });
      }
    },
    {
      debug: false,
      contentSecurityPolicy: {
        reportOnly: CSP_REPORT_ONLY,
        directives: {
          // XHR / fetch / WebSocket targets. Clerk auto-adds its own frontend API + telemetry.
          'connect-src': [
            'self',
            apiHttpOrigin,
            apiWebSocketOrigin,
            postHogHost,
            'https://*.i.posthog.com',
            'https://*.google-analytics.com',
            'https://*.analytics.google.com',
            'https://www.googletagmanager.com',
          ],
          // Connector / model / OS icons served from the static bucket; Clerk auto-adds img.clerk.com.
          'img-src': ['self', 'https://static.scratch.md', 'data:', 'https://*.google-analytics.com'],
          // Hardening Clerk's defaults omit; frame-ancestors complements the LB's X-Frame-Options: DENY.
          'frame-ancestors': ['none'],
          'object-src': ['none'],
          'base-uri': ['self'],
        },
      },
    },
  );

  return async (req: NextRequest, event: NextFetchEvent) => {
    // Check for maintenance mode
    const maintenanceMode = process.env.MAINTENANCE_MODE_ENABLED === 'true';
    // prevent infinite redirect loop
    const isMaintenancePage = req.nextUrl.pathname === '/maintenance.html';
    if (maintenanceMode && !isMaintenancePage) {
      return NextResponse.redirect(new URL('/maintenance.html', req.url));
    }

    // Continue with regular middleware authentication logic
    return clerkMiddlewareFn(req, event);
  };
}

export default createMiddleware();

export const config = {
  matcher: ['/((?!.+\\.[\\w]+$|_next).*)', '/', '/(api|trpc)(.*)'],
};

function originalUrl(req: NextRequest): string {
  const url = new URL(req.url);

  const forwardedHost = req.headers.get('x-forwarded-host');
  if (forwardedHost) {
    url.hostname = forwardedHost;
    url.port = '';
  }

  return url.toString();
}
