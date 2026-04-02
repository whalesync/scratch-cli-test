import { useEffect, useRef } from 'react';
import { useLocation } from 'react-router-dom';
import { identifyUser, initPostHog, trackPageView } from '../lib/posthog';
import { User } from '../types/user';

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
