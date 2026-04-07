import { ScratchPadUser } from '@/hooks/useScratchpadUser';
import { ScratchPlanType } from '@spinner/shared-types';
import posthog from 'posthog-js';

export enum PostHogEvents {
  PAGE_VIEW = '$pageview',
  CLICK_MANAGE_SUBSCRIPTION = 'click_manage_subscription',
  CLICK_NEW_PLAN_CHECKOUT = 'click_new_plan_checkout',
  TOGGLE_DISPLAY_MODE = 'toggle_display_mode',
  RUN_SYNC = 'run_sync',
  PULL_FILES = 'pull_files',
  PUBLISH_ALL = 'publish_all',
  DISCARD_CHANGES = 'discard_changes',
  PULL_FILES_FROM_SOURCE = 'pull_files_from_source',
  WHALESYNC_IMPORT = 'whalesync_import',
  DELETE_WORKBOOK = 'delete_workbook',
  CLICK_OPEN_IN_DESKTOP = 'click_open_in_desktop',
  OPEN_IN_DESKTOP_INTERSTITIAL_FALLBACK = 'open_in_desktop_interstitial_fallback',
}

export function captureEvent(eventName: PostHogEvents, additionalProperties: Record<string, unknown> = {}): void {
  // Analytics functions should NEVER throw errors
  try {
    posthog.capture(eventName, additionalProperties);
  } catch (e) {
    console.error('Failed to capture event', e);
  }
}

/**
 * Send an exception to PostHog outside of the default error handling flow
 * @param error The error to send
 * @param properties Set of extra KVPs to send with the exception
 */
export function captureException(error: Error, properties: Record<string, unknown> = {}): void {
  try {
    posthog.captureException(error, properties);
  } catch (e) {
    console.error('Failed to capture exception in Posthog', e);
  }
}

export function getSessionRecordingStatus(): string {
  const sessionRecording = posthog.sessionRecording;
  return sessionRecording?.status || 'Unknown';
}

export function getSessionId(): string | undefined {
  return posthog.get_session_id();
}

export function getSessionReplayUrl(): string | undefined {
  return posthog.get_session_replay_url();
}

export function trackPageView(url: string): void {
  captureEvent(PostHogEvents.PAGE_VIEW, { url });
}

export function trackToggleDisplayMode(mode: 'light' | 'dark'): void {
  captureEvent(PostHogEvents.TOGGLE_DISPLAY_MODE, { mode });
}

export function trackClickManageSubscription(): void {
  captureEvent(PostHogEvents.CLICK_MANAGE_SUBSCRIPTION, {});
}

export function trackClickNewPlanCheckout(planType: ScratchPlanType): void {
  captureEvent(PostHogEvents.CLICK_NEW_PLAN_CHECKOUT, { planType });
}

/**
 * Posthog tracking to identify user on sign-in
 */
export function trackUserSignIn(user: ScratchPadUser): void {
  if (user && user.user && user.clerkUser) {
    const userId = user.user.id;
    const email = user.clerkUser.emailAddresses[0].emailAddress;

    try {
      posthog.identify(userId, { email });
    } catch (error) {
      console.error('Error tracking user sign in', error);
    }
  }
}

export function trackRunSync(syncId: string, workbookId: string): void {
  captureEvent(PostHogEvents.RUN_SYNC, { syncId, workbookId });
}

export function trackPullFiles(workbookId: string): void {
  captureEvent(PostHogEvents.PULL_FILES, { workbookId });
}

export function trackPublishAll(workbookId: string, folderCount: number): void {
  captureEvent(PostHogEvents.PUBLISH_ALL, { workbookId, folderCount });
}

export function trackDiscardChanges(workbookId: string): void {
  captureEvent(PostHogEvents.DISCARD_CHANGES, { workbookId });
}

export function trackPullFilesFromSource(workbookId: string, dataFolderId: string): void {
  captureEvent(PostHogEvents.PULL_FILES_FROM_SOURCE, { workbookId, dataFolderId });
}

export function trackWhalesyncImport(workbookId: string, syncCount: number): void {
  captureEvent(PostHogEvents.WHALESYNC_IMPORT, { workbookId, syncCount });
}

export function trackDeleteWorkbook(workbookId: string): void {
  captureEvent(PostHogEvents.DELETE_WORKBOOK, { workbookId });
}

export function trackClickOpenInDesktop(context: { section: 'toolbar' | 'workspace_connections' }): void {
  captureEvent(PostHogEvents.CLICK_OPEN_IN_DESKTOP, context);
}

export function trackOpenInDesktopInterstitialFallback(context: { reason: 'timeout' | 'invalid_path' }): void {
  captureEvent(PostHogEvents.OPEN_IN_DESKTOP_INTERSTITIAL_FALLBACK, context);
}
