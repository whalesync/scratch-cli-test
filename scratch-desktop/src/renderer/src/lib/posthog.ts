import type { User } from '@spinner/shared-types';
import { sanitizeDeepLinkSource } from './deep-link-source';

export enum PostHogEvents {
  PAGE_VIEW = '$pageview',
  OPEN_WORKSPACE = 'open_workspace',
  DOWNLOAD_WORKSPACE = 'download_workspace',
  REMOVE_LOCAL_WORKSPACE = 'remove_local_workspace',
  CREATE_WORKSPACE = 'create_workspace',
  CANCEL_PICK_PARENT_FOLDER = 'cancel_pick_parent_folder',
  REDOWNLOAD_WORKSPACE = 'redownload_workspace',
  PULL_ALL = 'pull_all',
  PULL_TABLE = 'pull_table',
  PUBLISH_ALL = 'publish_all',
  PUBLISH_UPLOAD_STARTED = 'publish_upload_started',
  PUBLISH_UPLOAD_COMPLETED = 'publish_upload_completed',
  PUBLISH_STARTED = 'publish_started',
  PUBLISH_COMPLETED = 'publish_completed',
  PUBLISH_REVIEW_ON_WEB = 'publish_review_on_web',
  REFRESH_FOLDER_DATA_GRID = 'refresh_folder_data_grid',
  SHOW_FOLDER_INFO = 'show_folder_info',
  APP_STARTED = 'app_started',
  APP_EXITED = 'app_exited',
  CHECK_FOR_UPDATES = 'check_for_updates',
  INSTALL_UPDATE = 'install_update',
  DEEP_LINK_PROCESSED = 'deep_link_processed',
  WORKSPACE_CLOUD_SYNC_DETECTED = 'workspace_cloud_sync_detected',
  OPEN_CONNECTIONS_DIALOG = 'open_connections_dialog',
  FIRST_RUN_DOWNLOAD = 'first_run_download',
  OPEN_CLAUDE_CHAT_PANEL = 'open_claude_chat_panel',
  SEND_CLAUDE_CHAT_MESSAGE = 'send_claude_chat_message',
  ADD_WORKSPACE_PERMISSION = 'add_workspace_permission',
  REMOVE_WORKSPACE_PERMISSION = 'remove_workspace_permission',
  REMOVE_WORKSPACE_INVITE = 'remove_workspace_invite',
}

export type CloudSyncSurface = 'open' | 'create';

export type PickParentFolderFlow = 'download' | 'create';

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

  // Super-properties: PostHog attaches these to every event automatically,
  // including ones we don't route through captureEvent ($pageview, $identify).
  const appVersion = await window.scratchDesktop.getAppVersion();
  posthog.register({ app_platform: 'desktop', app_version: appVersion });
  posthogInstance = posthog;
  return posthog;
}

interface CaptureEventOptions {
  /**
   * Send the event immediately via sendBeacon, bypassing the batched queue. Used for events fired
   * during app shutdown — sendBeacon is keepalive-aware so the request survives renderer tear-down.
   */
  sendImmediately?: boolean;
}

async function captureEvent(
  eventName: PostHogEvents,
  properties: Record<string, unknown> = {},
  options: CaptureEventOptions = {},
): Promise<void> {
  try {
    const posthog = await getPostHog();
    posthog?.capture(
      eventName,
      properties,
      options.sendImmediately ? { send_instantly: true, transport: 'sendBeacon' } : undefined,
    );
  } catch (e) {
    console.error('Failed to capture PostHog event', e);
  }
}

export async function initPostHog(): Promise<void> {
  await getPostHog();
}

export async function trackPageView(url: string): Promise<void> {
  await captureEvent(PostHogEvents.PAGE_VIEW, { url });
}

export async function trackOpenWorkspace(workspaceId: string): Promise<void> {
  await captureEvent(PostHogEvents.OPEN_WORKSPACE, { workspaceId });
}

export async function trackOpenClaudeChatPanel(workspaceId: string): Promise<void> {
  await captureEvent(PostHogEvents.OPEN_CLAUDE_CHAT_PANEL, { workspaceId });
}

/** Tracks the act of sending a chat message. `messageLength` only — never the message text (user content). */
export async function trackSendClaudeChatMessage(workspaceId: string, messageLength: number): Promise<void> {
  await captureEvent(PostHogEvents.SEND_CLAUDE_CHAT_MESSAGE, { workspaceId, messageLength });
}

export async function trackDownloadWorkspace(workspaceId: string): Promise<void> {
  await captureEvent(PostHogEvents.DOWNLOAD_WORKSPACE, { workspaceId });
}

export async function trackRemoveLocalWorkspace(workspaceId: string): Promise<void> {
  await captureEvent(PostHogEvents.REMOVE_LOCAL_WORKSPACE, { workspaceId });
}

export async function trackCreateWorkspace(workspaceId: string): Promise<void> {
  await captureEvent(PostHogEvents.CREATE_WORKSPACE, { workspaceId });
}

export async function trackCancelPickParentFolder(workspaceId: string, flow: PickParentFolderFlow): Promise<void> {
  await captureEvent(PostHogEvents.CANCEL_PICK_PARENT_FOLDER, { workspaceId, flow });
}

export async function trackRedownloadWorkspace(workspaceId: string): Promise<void> {
  await captureEvent(PostHogEvents.REDOWNLOAD_WORKSPACE, { workspaceId });
}

export async function trackWorkspaceCloudSyncDetected(
  workspaceId: string,
  provider: string,
  surface: CloudSyncSurface,
): Promise<void> {
  await captureEvent(PostHogEvents.WORKSPACE_CLOUD_SYNC_DETECTED, { workspaceId, provider, surface });
}

export async function trackPullAll(workspaceId: string, mode: 'full' | 'incremental' = 'incremental'): Promise<void> {
  await captureEvent(PostHogEvents.PULL_ALL, { workspaceId, mode });
}

export async function trackPullTable(
  workspaceId: string,
  dataFolderId: string,
  mode: 'full' | 'incremental' = 'full',
): Promise<void> {
  await captureEvent(PostHogEvents.PULL_TABLE, { workspaceId, dataFolderId, mode });
}

export async function trackPublishAll(workspaceId: string): Promise<void> {
  await captureEvent(PostHogEvents.PUBLISH_ALL, { workspaceId });
}

export async function trackPublishUploadStarted(workspaceId: string): Promise<void> {
  await captureEvent(PostHogEvents.PUBLISH_UPLOAD_STARTED, { workspaceId });
}

export async function trackPublishUploadCompleted(
  workspaceId: string,
  props: { filesCreated: number; filesUpdated: number; filesDeleted: number; connectionCount: number },
): Promise<void> {
  await captureEvent(PostHogEvents.PUBLISH_UPLOAD_COMPLETED, { workspaceId, ...props });
}

export async function trackPublishStarted(workspaceId: string, connectionCount: number): Promise<void> {
  await captureEvent(PostHogEvents.PUBLISH_STARTED, { workspaceId, connectionCount });
}

export async function trackPublishCompleted(
  workspaceId: string,
  props: { successCount: number; failedCount: number; noDiffCount: number },
): Promise<void> {
  await captureEvent(PostHogEvents.PUBLISH_COMPLETED, { workspaceId, ...props });
}

export async function trackPublishReviewOnWeb(workspaceId: string): Promise<void> {
  await captureEvent(PostHogEvents.PUBLISH_REVIEW_ON_WEB, { workspaceId });
}

export async function trackRefreshFolderDataGrid(workspaceId: string, folderPath: string | null): Promise<void> {
  await captureEvent(PostHogEvents.REFRESH_FOLDER_DATA_GRID, { workspaceId, folderPath });
}

export async function trackShowFolderInfo(workspaceId: string, dataFolderId: string): Promise<void> {
  await captureEvent(PostHogEvents.SHOW_FOLDER_INFO, { workspaceId, dataFolderId });
}

export async function trackAppStarted(props: { isPackaged: boolean }): Promise<void> {
  await captureEvent(PostHogEvents.APP_STARTED, props);
}

export async function trackAppExited(props: { sessionDurationMs: number }): Promise<void> {
  await captureEvent(PostHogEvents.APP_EXITED, props, { sendImmediately: true });
}

export async function trackCheckForUpdates(): Promise<void> {
  await captureEvent(PostHogEvents.CHECK_FOR_UPDATES);
}

export async function trackInstallUpdate(props: { targetVersion: string }): Promise<void> {
  // sendImmediately: quitAndInstall() restarts the app moments after the click,
  // so we need the request to leave via sendBeacon rather than the batch queue.
  await captureEvent(PostHogEvents.INSTALL_UPDATE, props, { sendImmediately: true });
}

export async function trackDeepLinkProcessed(props: {
  workspaceId: string;
  targetType: 'workspace' | 'folder' | 'record';
  source?: string;
  pathDepth?: number;
}): Promise<void> {
  const { source, ...rest } = props;
  const sanitizedSource = sanitizeDeepLinkSource(source);
  await captureEvent(PostHogEvents.DEEP_LINK_PROCESSED, sanitizedSource ? { ...rest, source: sanitizedSource } : rest);
}

export async function trackOpenConnectionsDialog(workbookId: string): Promise<void> {
  await captureEvent(PostHogEvents.OPEN_CONNECTIONS_DIALOG, { workbookId });
}

export async function trackAddWorkspacePermission(workbookId: string): Promise<void> {
  await captureEvent(PostHogEvents.ADD_WORKSPACE_PERMISSION, { workbookId });
}

export async function trackRemoveWorkspacePermission(workbookId: string): Promise<void> {
  await captureEvent(PostHogEvents.REMOVE_WORKSPACE_PERMISSION, { workbookId });
}

export async function trackRemoveWorkspaceInvite(workbookId: string): Promise<void> {
  await captureEvent(PostHogEvents.REMOVE_WORKSPACE_INVITE, { workbookId });
}

export async function trackFirstRunDownload(workspaceId: string): Promise<void> {
  await captureEvent(PostHogEvents.FIRST_RUN_DOWNLOAD, { workspaceId });
}

export async function identifyUser(user: User, email: string | undefined): Promise<void> {
  try {
    const posthog = await getPostHog();
    posthog?.identify(user.id, { email });
  } catch (e) {
    console.error('Failed to identify user in PostHog', e);
  }
}
