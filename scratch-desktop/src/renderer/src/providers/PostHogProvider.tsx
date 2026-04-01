import { useEffect, useRef } from 'react';
import { useLocation } from 'react-router-dom';
import { useCurrentUser } from '../hooks/use-current-user';
import { identifyUser, initPostHog, trackPageView } from '../lib/posthog';

export function PostHogProvider({ children }: { children: React.ReactNode }) {
  const initRef = useRef(false);
  const identifiedRef = useRef(false);
  const { user } = useCurrentUser();
  const location = useLocation();

  // Initialize PostHog once, deferred to idle time
  useEffect(() => {
    if (!initRef.current) {
      initRef.current = true;
      void initPostHog();
    }
  }, []);

  // Identify user when server user data becomes available
  useEffect(() => {
    if (user && !identifiedRef.current) {
      identifiedRef.current = true;
      void identifyUser(user, user.email);
    }
  }, [user]);

  // Track page views on route changes
  useEffect(() => {
    void trackPageView(location.pathname);
  }, [location.pathname]);

  return <>{children}</>;
}
