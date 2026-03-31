import posthog from 'posthog-js';
import { User } from '../types/user';

export enum PostHogEvents {
  PAGE_VIEW = '$pageview',
}

export function initPostHog(): void {
  const key = import.meta.env.VITE_POSTHOG_KEY as string;
  const host = (import.meta.env.VITE_POSTHOG_HOST as string) || 'https://us.i.posthog.com';

  if (!key) {
    console.debug('PostHog key not configured, analytics disabled');
    return;
  }

  posthog.init(key, {
    api_host: host,
    person_profiles: 'identified_only',
    defaults: '2025-05-24',
    capture_pageview: false, // we track page views manually via route changes
  });

  // Tag every event with the app platform so desktop events are distinguishable from web client events
  posthog.register({ app_platform: 'desktop' });

  // TODO: Set the app version as well once we have that in the build process
}

function captureEvent(eventName: PostHogEvents, properties: Record<string, unknown> = {}): void {
  try {
    posthog.capture(eventName, properties);
  } catch (e) {
    console.error('Failed to capture PostHog event', e);
  }
}

export function trackPageView(url: string): void {
  captureEvent(PostHogEvents.PAGE_VIEW, { url });
}

export function identifyUser(user: User, email: string | undefined): void {
  try {
    posthog.identify(user.id, { email });
  } catch (e) {
    console.error('Failed to identify user in PostHog', e);
  }
}
