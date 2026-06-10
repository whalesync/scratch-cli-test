import type { User } from '@spinner/shared-types';
import { useEffect, useRef } from 'react';
import { useLocation } from 'react-router-dom';
import { identifyUser, initPostHog, trackAppExited, trackAppStarted, trackPageView } from '../lib/posthog';

interface PostHogProviderProps {
  user: User | null;
  children: React.ReactNode;
}

export function PostHogProvider({ user, children }: PostHogProviderProps) {
  const initRef = useRef(false);
  const identifiedRef = useRef(false);
  const location = useLocation();

  // Initialize PostHog once, deferred to idle time
  useEffect(() => {
    if (!initRef.current) {
      initRef.current = true;
      void initPostHog();
    }
  }, []);

  // Identify the user, then fire app_started so it lands on the user's profile
  // (PostHog is configured with `person_profiles: 'identified_only'`).
  useEffect(() => {
    if (user && !identifiedRef.current) {
      identifiedRef.current = true;
      void (async () => {
        await identifyUser(user, user.email);
        void trackAppStarted({ isPackaged: !import.meta.env.DEV });
      })();
    }
  }, [user]);

  // Capture app_exited from main's before-quit handshake. Main waits on
  // confirmQuit() (with a hard timeout) before calling app.quit() again.
  useEffect(() => {
    const unsubscribe = window.scratchDesktop.lifecycle.onWillQuit(({ sessionDurationMs }) => {
      void (async () => {
        try {
          await trackAppExited({ sessionDurationMs });
        } finally {
          window.scratchDesktop.lifecycle.confirmQuit();
        }
      })();
    });
    return unsubscribe;
  }, []);

  // Track page views on route changes
  useEffect(() => {
    void trackPageView(location.pathname);
  }, [location.pathname]);

  return <>{children}</>;
}
