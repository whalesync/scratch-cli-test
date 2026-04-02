import { User } from '../types/user';

export enum PostHogEvents {
  PAGE_VIEW = '$pageview',
}

type PostHogInstance = Awaited<typeof import('posthog-js')>['default'];
let posthogInstance: PostHogInstance | null = null;

async function getPostHog(): Promise<PostHogInstance | null> {
  if (posthogInstance) return posthogInstance;

  const key = import.meta.env.VITE_POSTHOG_KEY as string;
  if (!key) {
    console.debug('PostHog key not configured, analytics disabled');
    return null;
  }

  const { default: posthog } = await import('posthog-js');
  posthog.init(key, {
    api_host: (import.meta.env.VITE_POSTHOG_HOST as string) || 'https://us.i.posthog.com',
    person_profiles: 'identified_only',
    defaults: '2025-05-24',
    capture_pageview: false,
    autocapture: false,
    disable_session_recording: true,
  });

  posthog.register({ app_platform: 'desktop' });
  posthogInstance = posthog;
  return posthog;
}

export async function initPostHog(): Promise<void> {
  await getPostHog();
}

export async function trackPageView(url: string): Promise<void> {
  try {
    const posthog = await getPostHog();
    posthog?.capture(PostHogEvents.PAGE_VIEW, { url });
  } catch (e) {
    console.error('Failed to capture PostHog event', e);
  }
}

export async function identifyUser(user: User, email: string | undefined): Promise<void> {
  try {
    const posthog = await getPostHog();
    posthog?.identify(user.id, { email });
  } catch (e) {
    console.error('Failed to identify user in PostHog', e);
  }
}
