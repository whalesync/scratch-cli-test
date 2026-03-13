import { clerkMiddleware, createRouteMatcher } from '@clerk/nextjs/server';
import { NextFetchEvent, NextMiddleware, NextRequest, NextResponse } from 'next/server';
import { RouteUrls } from './utils/route-urls';

function createMiddleware(): NextMiddleware {
  const isPublicRoute = createRouteMatcher(RouteUrls.publicRoutePatterns);

  const clerkMiddlewareFn = clerkMiddleware(
    async (auth, req) => {
      const { userId, redirectToSignIn } = await auth();

      if (!userId && !isPublicRoute(req)) {
        return redirectToSignIn({ returnBackUrl: originalUrl(req) });
      }
    },
    { debug: false },
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
