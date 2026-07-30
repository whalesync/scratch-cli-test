import { clerkMiddleware, createRouteMatcher } from '@clerk/nextjs/server';
import { NextFetchEvent, NextMiddleware, NextRequest, NextResponse } from 'next/server';
import { RouteUrls } from './utils/route-urls';

// DEV-11008 / pentest SCR-013 — CSP now ENFORCED (blocking). Report-Only bake on test+prod is
// complete; the one violation found ('unsafe-eval' from gtag.js) is allowed below. A nonce-based
// `strict: true` policy is the planned follow-up hardening (this Phase 1 leaves script-src permissive).
const CSP_REPORT_ONLY = false;

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
          // Google Analytics' gtag.js (and PostHog add-on scripts) evaluate strings at runtime, which
          // the non-strict Phase 1 policy must allow. Clerk unions this onto its default script-src
          // (self, unsafe-inline, https:, http:, Stripe, maps). Removed by the planned strict-dynamic
          // nonce hardening (DEV-11125 §3), where strict-dynamic replaces the host allowlist entirely.
          'script-src': ['unsafe-eval'],
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
