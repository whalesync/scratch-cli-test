'use client';

import { FullPageLoader } from '@/app/components/FullPageLoader';
import { useScratchPadUser } from '@/hooks/useScratchpadUser';
import { API_CONFIG } from '@/lib/api/config';
import { trackUserSignIn } from '@/lib/posthog';
import { RouteUrls } from '@/utils/route-urls';
import { useAuth, useUser } from '@clerk/nextjs';
import { usePathname, useRouter } from 'next/navigation';
import { JSX, ReactNode, useCallback, useEffect, useRef, useState } from 'react';

const JWT_TOKEN_REFRESH_MS = 10000; // 10 seconds

/**
 * Single gate for auth + routing. Shows one spinner while user data loads,
 * then decides destination (waitlist / last workbook / render children).
 */
export const ScratchPadUserProvider = ({ children }: { children: ReactNode }): JSX.Element => {
  const scratchPadUser = useScratchPadUser();
  const pathname = usePathname();
  const router = useRouter();

  useEffect(() => {
    if (scratchPadUser) {
      trackUserSignIn(scratchPadUser);
    }
  }, [scratchPadUser]);

  const isReady = !scratchPadUser.isLoading && !!scratchPadUser.user;
  const user = scratchPadUser.user;

  const needsRedirect =
    isReady &&
    ((!user?.waitlistApproved && pathname !== RouteUrls.waitlistPageUrl) || pathname === RouteUrls.homePageUrl);

  useEffect(() => {
    if (!isReady || !user) return;

    if (!user.waitlistApproved && pathname !== RouteUrls.waitlistPageUrl) {
      router.replace(RouteUrls.waitlistPageUrl);
      return;
    }

    // `/` routes to the user's last workbook (if any), else the picker.
    if (pathname === RouteUrls.homePageUrl) {
      if (user.lastWorkbookId) {
        router.replace(RouteUrls.workbookFilesPageUrl(user.lastWorkbookId));
      } else {
        router.replace(RouteUrls.workbookPickerPageUrl);
      }
    }
  }, [isReady, user, pathname, router]);

  if (!isReady || needsRedirect) {
    return <FullPageLoader />;
  }

  return <>{children}</>;
};

/**
 * This provider handles combining Clerk auth with Scratch auth.
 * It registers a token provider on API_CONFIG so every API request fetches a fresh JWT on-demand,
 * and periodically checks session validity to detect sign-outs.
 */
export const ClerkAuthContextProvider = (props: { children: ReactNode }): JSX.Element => {
  const { getToken, signOut } = useAuth();
  const { isLoaded, isSignedIn } = useUser();
  const pathname = usePathname();
  const router = useRouter();
  const [tokenLoaded, setTokenLoaded] = useState(false);
  const hadTokenRef = useRef(false);

  const loadToken = useCallback(async () => {
    /*
     * Check session validity by calling getToken(). The actual token is fetched
     * on-demand by the token provider registered on API_CONFIG, so we don't need
     * to store it here — this is purely for sign-out detection.
     */
    const newToken = await getToken();

    if (newToken) {
      hadTokenRef.current = true;
      setTokenLoaded(true);
    } else if (hadTokenRef.current) {
      // Session expired — we previously had a valid token but Clerk now returns null.
      // Sign out and redirect to sign-in so the user can re-authenticate.
      await signOut();
      router.push(RouteUrls.signInPageUrl);
    }
  }, [getToken, signOut, router]);

  // Register the token provider so every API request fetches a fresh token on-demand
  useEffect(() => {
    if (isLoaded && isSignedIn) {
      API_CONFIG.setTokenProvider(() => getToken());
    }
    return () => {
      API_CONFIG.setTokenProvider(null);
    };
  }, [isLoaded, isSignedIn, getToken]);

  // Check session validity when auth state changes
  useEffect(() => {
    if (isLoaded && isSignedIn) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- async Clerk session check; setState happens in callback after await
      loadToken().catch(console.error);
    }
  }, [isLoaded, isSignedIn, loadToken]);

  /*
   * Periodically check session validity so we detect sign-outs promptly
   */
  useEffect(() => {
    const interval = setInterval(() => {
      loadToken().catch(console.error);
    }, JWT_TOKEN_REFRESH_MS);

    return () => clearInterval(interval);
  }, [loadToken]);

  /*
   * Refresh the token when the browser regains focus
   * This ensures the token is fresh when the user returns to the tab and catches situations where the interval
   * isn't running
   */
  useEffect(() => {
    const handleFocus = () => {
      if (isLoaded && isSignedIn) {
        loadToken().catch(console.error);
      }
    };

    window.addEventListener('focus', handleFocus);
    return () => window.removeEventListener('focus', handleFocus);
  }, [isLoaded, isSignedIn, loadToken]);

  if (RouteUrls.isPublicRoute(pathname)) {
    // Public pages just pass through and can get rendered w/o auth state initialized
    // NOTE: these pages should not attempt to access any user or auth data
    return <>{props.children}</>;
  }

  if (!tokenLoaded) {
    /*
     * Session not authorized and/or user is not yet identified, show a loading screen while we wait for that workflow
     *  to complete
     */
    return <FullPageLoader />;
  }

  /*
   * Session exist, we have a valid JWT, clerk user is loaded AND whalesync user identified
   * AUTH is complete -- any dependant pages are safe to render and utilize user data
   */
  return <ScratchPadUserProvider>{props.children}</ScratchPadUserProvider>;
};
