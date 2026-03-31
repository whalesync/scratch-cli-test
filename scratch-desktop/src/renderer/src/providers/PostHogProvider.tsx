import { useUser } from '@clerk/clerk-react';
import { useEffect, useRef } from 'react';
import { useLocation } from 'react-router-dom';
import { useCurrentUser } from '../hooks/use-current-user';
import { identifyUser, initPostHog, trackPageView } from '../lib/posthog';

export function PostHogProvider({ children }: { children: React.ReactNode }) {
  const initRef = useRef(false);
  const identifiedRef = useRef(false);
  const { user } = useCurrentUser();
  const { user: clerkUser } = useUser();
  const location = useLocation();

  // Initialize PostHog once
  useEffect(() => {
    if (!initRef.current) {
      initPostHog();
      initRef.current = true;
    }
  }, []);

  // Identify user when server user data becomes available
  useEffect(() => {
    if (user && !identifiedRef.current) {
      const email = user.email ?? clerkUser?.primaryEmailAddress?.emailAddress;
      identifyUser(user, email);
      identifiedRef.current = true;
    }
  }, [user, clerkUser]);

  // Track page views on route changes
  useEffect(() => {
    trackPageView(location.pathname);
  }, [location.pathname]);

  return <>{children}</>;
}
