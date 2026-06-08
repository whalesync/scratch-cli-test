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
  DOWNLOAD_DESKTOP_APP = 'download_desktop_app',
  DOWNLOAD_CLI = 'download_cli',
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

export function trackPullFiles(workbookId: string, mode?: 'full' | 'incremental'): void {
  captureEvent(PostHogEvents.PULL_FILES, { workbookId, mode: mode ?? 'full' });
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

/** Operating-system family a downloadable Scratch Desktop / CLI build targets. */
export type DownloadPlatform = 'MacOS' | 'Windows' | 'Linux';

/**
 * Which surface in the web app a Scratch Desktop download was initiated from.
 *
 * `downloads_page` and `desktop_download_cta` represent clicks on a real binary
 * (the `.dmg`/`.exe`/etc. starts downloading). `open_desktop_interstitial` and
 * `open_in_desktop_interstitial` are the "Download Scratch Desktop" buttons on the
 * deep-link fallback screens, which navigate the user to the downloads page rather
 * than downloading a binary directly — filter on `section` to tell them apart.
 */
export type DesktopAppDownloadSection =
  | 'downloads_page'
  | 'desktop_download_cta'
  | 'open_desktop_interstitial'
  | 'open_in_desktop_interstitial';

export function trackDownloadDesktopApp(context: {
  section: DesktopAppDownloadSection;
  platform?: DownloadPlatform;
  /** Human-readable build variant, e.g. "Apple Silicon (.dmg)". */
  variant?: string;
  /** Release asset filename, e.g. "Scratch-1.2.3-arm64.dmg". */
  assetName?: string;
  /** Release version the asset belongs to, e.g. "v1.2.3". */
  version?: string;
}): void {
  captureEvent(PostHogEvents.DOWNLOAD_DESKTOP_APP, context);
}

export function trackDownloadCli(context: {
  platform: DownloadPlatform;
  /** Human-readable build variant, e.g. "Apple Silicon (.tar.gz)". */
  variant: string;
  /** Release asset filename, e.g. "scratchmd_darwin_arm64.tar.gz". */
  assetName: string;
  /** Release version the asset belongs to, e.g. "v1.2.3". */
  version?: string;
}): void {
  // The CLI is only downloadable from the downloads page, so there is no `section` discriminator.
  captureEvent(PostHogEvents.DOWNLOAD_CLI, context);
}
