import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { ConnectorAccount, DataFolder, Sync, User } from '@prisma/client';
import { ScratchPlanType } from '@spinner/shared-types';
import { PostHog } from 'posthog-node';
import { ScratchConfigService } from 'src/config/scratch-config.service';
import { WorkbookCluster } from 'src/db/cluster-types';
import { WSLogger } from 'src/logger';
import { Actor } from 'src/users/types';

type PostHogEventProperties = Record<string, unknown>;

@Injectable()
export class PostHogService implements OnModuleDestroy {
  private postHog: PostHog | undefined;

  constructor(private readonly configService: ScratchConfigService) {
    const apiKey = configService.getPostHogApiKey();
    const host = configService.getPostHogHost();

    if (apiKey && host && configService.isPosthogAnaltyicsEnabled()) {
      this.postHog = new PostHog(apiKey, {
        host,
      });

      WSLogger.info({
        source: PostHogService.name,
        message: 'PostHog Analytics are enabled',
      });
    } else {
      WSLogger.warn({
        source: PostHogService.name,
        message: 'PostHog Analytics are disabled',
      });
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.postHog) {
      await this.postHog.shutdown();
    }
  }

  captureEvent(
    eventName: PostHogEventName,
    actor: Actor | User | string,
    properties: PostHogEventProperties = {},
  ): void {
    if (!this.postHog) {
      return;
    }

    const distinctId = typeof actor === 'string' ? actor : 'userId' in actor ? actor.userId : actor.id;

    if (typeof actor === 'object' && 'authSource' in actor) {
      properties.authSource = actor.authSource;
    }

    try {
      this.postHog.capture({
        event: eventName,
        distinctId,
        properties,
      });
    } catch (err) {
      WSLogger.warn({
        source: PostHogService.name,
        message: `Failed to capture event "${eventName}"`,
        error: err,
        properties,
      });
    }
  }

  /*******************************************************
   * User events
   *******************************************************/

  /**
   * Identifies a new user to Posthog on the backend once we have created the User record and obtained an ID to use
   * as the Posthog distinctId.
   *
   * @param user User that was created
   */
  public identifyNewUser(user: User): void {
    if (!this.postHog) {
      return;
    }

    const signedUpAt = user.createdAt.toISOString().slice(0, 10);

    // Shadow users provisioned from Whalesync are flagged with a durable person property so
    // Scratch-growth dashboards and funnels can exclude them. `is_whalesync_shadow_user` is set
    // for every user (true for shadow, explicitly false for native) to keep the exclusion filter
    // unambiguous, and is set via `$set` (not `$set_once`) so it stays correct if a user is ever
    // reconciled from shadow to native later.
    const isWhalesyncShadowUser = !!user.whalesyncUserId;

    const eventProperties = {
      email: user.email,
      name: user.name,
      is_whalesync_shadow_user: isWhalesyncShadowUser,
      whalesync_user_id: user.whalesyncUserId ?? null,
      $set_once: {
        signed_up_at: signedUpAt,
      },
    };

    try {
      // First time we have seen this user so we need to identify them on Posthog
      this.postHog.identify({ distinctId: user.id, properties: eventProperties });

      // dedicated event for user creation
      this.captureEvent(PostHogEventName.ACCOUNT_USER_CREATED, user, {
        name: user.name,
        email: user.email,
        role: user.role,
        is_whalesync_shadow_user: isWhalesyncShadowUser,
        whalesync_user_id: user.whalesyncUserId ?? null,
        $set_once: {
          signed_up_at: signedUpAt,
        },
      });
    } catch (err) {
      WSLogger.warn({
        source: PostHogService.name,
        message: `Failed to identify user`,
        error: err,
        id: user.id,
      });
    }
  }

  /**
   * Fires when an existing Scratch user is linked (adopted) to a Whalesync identity by the
   * email-reconciliation path (`UsersService.getOrCreateShadowUserFromWhalesync`) — i.e. a native
   * Scratch account and the Whalesync user that shares its address became one account. This is a
   * link, not a creation, so it is a dedicated event rather than another ACCOUNT_USER_CREATED.
   *
   * The `whalesync_user_id` is recorded both as an event property and `$set` on the person so the
   * link is queryable. `is_whalesync_shadow_user` is deliberately left untouched (false): an adopted
   * user is a real native user, not a pure shadow user, and must not be excluded from growth funnels.
   */
  public trackWhalesyncAccountLinked(user: User, whalesyncUserId: string): void {
    this.captureEvent(PostHogEventName.WHALESYNC_ACCOUNT_LINKED, user, {
      whalesync_user_id: whalesyncUserId,
      email: user.email,
      role: user.role,
      $set: {
        whalesync_user_id: whalesyncUserId,
      },
    });
  }

  /*******************************************************
   * Workbook events
   *******************************************************/
  trackCreateWorkbook(actor: Actor, workbook: WorkbookCluster.Workbook): void {
    this.captureEvent(PostHogEventName.WORKBOOK_CREATED, actor, {
      ...mapWorkbookProperties(workbook),
    });
  }

  trackRemoveWorkbook(actor: Actor, workbook: WorkbookCluster.Workbook): void {
    this.captureEvent(PostHogEventName.WORKBOOK_REMOVED, actor, {
      ...mapWorkbookProperties(workbook),
    });
  }

  trackUpdateWorkbook(actor: Actor, workbook: WorkbookCluster.Workbook): void {
    this.captureEvent(PostHogEventName.WORKBOOK_UPDATED, actor, {
      ...mapWorkbookProperties(workbook),
    });
  }

  trackDiscardWorkbookChanges(actor: Actor, workbook: WorkbookCluster.Workbook, path?: string): void {
    this.captureEvent(PostHogEventName.WORKBOOK_CHANGES_DISCARDED, actor, {
      ...mapWorkbookProperties(workbook),
      ...(path && { path }),
    });
  }

  trackResetWorkbook(actor: Actor, workbook: WorkbookCluster.Workbook): void {
    this.captureEvent(PostHogEventName.WORKBOOK_RESET, actor, {
      ...mapWorkbookProperties(workbook),
    });
  }

  trackPushWorkbook(actor: Actor, workbook: WorkbookCluster.Workbook): void {
    this.captureEvent(PostHogEventName.WORKBOOK_PUBLISHED, actor, {
      ...mapWorkbookProperties(workbook),
    });
  }

  trackPullWorkbook(actor: Actor, workbook: WorkbookCluster.Workbook): void {
    this.captureEvent(PostHogEventName.WORKBOOK_PULLED, actor, {
      ...mapWorkbookProperties(workbook),
    });
  }

  trackPullFilesForWorkbook(
    actor: Actor,
    workbook: WorkbookCluster.Workbook,
    options: { dataFolderCount: number },
  ): void {
    this.captureEvent(PostHogEventName.WORKBOOK_PULL_FILES, actor, {
      ...mapWorkbookProperties(workbook),
      dataFolderCount: options.dataFolderCount,
    });
  }

  /**
   * Track when the user triggers publishing (pushing) of data from a workbook to data sources.
   */
  trackPublishDataFromWorkbook(
    actor: Actor,
    workbook: WorkbookCluster.Workbook,
    options: { dataFolderCount: number },
  ): void {
    this.captureEvent(PostHogEventName.WORKBOOK_PUBLISH_TRIGGERED, actor, {
      ...mapWorkbookProperties(workbook),
      dataFolderCount: options.dataFolderCount,
    });
  }

  /*******************************************************
   * Connection / Data source events
   *******************************************************/
  trackCreateDataSource(
    actor: Actor,
    dataSource: ConnectorAccount,
    options: { authType: string; healthStatus: 'ok' | 'error'; apiDomain?: string },
  ): void {
    this.captureEvent(PostHogEventName.CONNECTOR_ACCOUNT_CREATED, actor, {
      dataSourceId: dataSource.id,
      connectorService: dataSource.service,
      authType: options.authType,
      healthStatus: options.healthStatus,
      ...(options.apiDomain && { apiDomain: options.apiDomain }),
    });
  }

  trackPullTablesForDataSource(actor: Actor, dataSource: ConnectorAccount): void {
    this.captureEvent(PostHogEventName.PULL_TABLES_FOR_DATA_SOURCE, actor, {
      dataSourceId: dataSource.id,
      connectorService: dataSource.service,
    });
  }

  trackUpdateDataSource(actor: Actor, dataSource: ConnectorAccount, options?: { changedFields?: string[] }): void {
    this.captureEvent(PostHogEventName.CONNECTOR_ACCOUNT_UPDATED, actor, {
      dataSourceId: dataSource.id,
      connectorService: dataSource.service,
      authType: dataSource.authType,
      ...(options?.changedFields && { changedFields: options.changedFields }),
    });
  }

  trackRemoveDataSource(actor: Actor, dataSource: ConnectorAccount): void {
    this.captureEvent(PostHogEventName.CONNECTOR_ACCOUNT_REMOVED, actor, {
      dataSourceId: dataSource.id,
      connectorService: dataSource.service,
      authType: dataSource.authType,
    });
  }

  /*******************************************************
   * Data folder events
   *******************************************************/
  trackAddDataFolder(actor: Actor, dataFolder: DataFolder): void {
    this.captureEvent(PostHogEventName.DATA_FOLDER_ADDED, actor, {
      ...mapDataFolderProperties(dataFolder),
    });
  }

  trackRemoveDataFolder(actor: Actor, dataFolder: DataFolder): void {
    this.captureEvent(PostHogEventName.DATA_FOLDER_REMOVED, actor, {
      ...mapDataFolderProperties(dataFolder),
    });
  }

  trackPullFiles(actor: Actor, workbookId: string, dataFolderId: string): void {
    this.captureEvent(PostHogEventName.PULL_FILES, actor, {
      workbookId,
      dataFolderId,
    });
  }

  /*******************************************************
   * Record events
   *******************************************************/

  trackRecordCreated(actor: Actor, workbook: WorkbookCluster.Workbook, filePath: string): void {
    this.captureEvent(PostHogEventName.RECORD_CREATED, actor, {
      ...mapWorkbookProperties(workbook),
      filePath,
    });
  }

  trackRecordEdited(actor: Actor, workbook: WorkbookCluster.Workbook, filePath: string): void {
    this.captureEvent(PostHogEventName.RECORD_EDITED, actor, {
      ...mapWorkbookProperties(workbook),
      filePath,
    });
  }

  trackRecordDeleted(actor: Actor, workbook: WorkbookCluster.Workbook, filePath: string): void {
    this.captureEvent(PostHogEventName.RECORD_DELETED, actor, {
      ...mapWorkbookProperties(workbook),
      filePath,
    });
  }

  /*******************************************************
   * Sync events
   *******************************************************/

  trackCreateSync(actor: Actor, sync: Sync): void {
    this.captureEvent(PostHogEventName.SYNC_CREATED, actor, {
      ...mapSyncProperties(sync),
    });
  }

  trackUpdateSync(actor: Actor, sync: Sync): void {
    this.captureEvent(PostHogEventName.SYNC_UPDATED, actor, {
      ...mapSyncProperties(sync),
    });
  }

  trackRemoveSync(actor: Actor, sync: Sync): void {
    this.captureEvent(PostHogEventName.SYNC_REMOVED, actor, {
      ...mapSyncProperties(sync),
    });
  }

  trackStartSyncRun(actor: Actor, sync: Sync): void {
    this.captureEvent(PostHogEventName.START_SYNC_RUN, actor, {
      ...mapSyncProperties(sync),
    });
  }

  trackSyncCompleted(
    actor: Actor | string,
    properties: {
      syncId: string;
      syncName: string;
      trigger?: string;
      result: 'success' | 'failure';
      totalRecordsSynced: number;
      recordsCreated: number;
      recordsUpdated: number;
      tablesProcessed: number;
      failedTableCount: number;
      /** Per-run unmatched-destination (Pass 3) counts, summed across tables. */
      unmatchedWithKeyCount?: number;
      unmatchedWithoutKeyCount?: number;
      archiveWritesCount?: number;
      unarchiveWritesCount?: number;
      /** Destination records deleted by Pass 3's `'delete'` policy, summed across tables. */
      deleteCount?: number;
    },
  ): void {
    this.captureEvent(PostHogEventName.SYNC_COMPLETED, actor, properties);
  }

  trackPublishCompleted(
    actor: Actor | string,
    properties: {
      workbookId: string;
      trigger?: string;
      result: 'success' | 'failure';
      totalRecordsPushed: number;
      creates: number;
      edits: number;
      deletes: number;
    },
  ): void {
    this.captureEvent(PostHogEventName.PUBLISH_COMPLETED, actor, properties);
  }

  /**
   * DEV-10316: a desktop publish was aborted at plan-build time because the
   * connection's dirty HEAD drifted past the client's `expectedBaseDirtyHead`
   * TOCTOU token. See {@link PostHogEventName.PUBLISH_ABORTED_DIRTY_DRIFT}.
   */
  trackPublishAbortedDirtyDrift(
    actor: Actor | string,
    properties: { workbookId: string; connectorAccountId: string; dirtyCount: number },
  ): void {
    this.captureEvent(PostHogEventName.PUBLISH_ABORTED_DIRTY_DRIFT, actor, properties);
  }

  trackPullCompleted(
    actor: Actor | string,
    properties: {
      workbookId: string;
      /** Connector type (e.g. AIRTABLE, GENERIC_API) — optional only so the legacy pull-files job can omit it; new callers should always set it. */
      connectorService?: string;
      /** Matches dataSourceId on connector_created — lets create→pull events be joined per source. */
      connectorAccountId?: string;
      trigger?: string;
      mode?: 'full' | 'incremental';
      result: 'success' | 'failure';
      totalFilesPulled: number;
      filesCreated: number;
      filesUpdated: number;
      filesDeleted: number;
      foldersProcessed: number;
      /** Set only for GENERIC_API pulls so the connector breakdowns can show which third-party APIs are being hit. */
      apiDomain?: string;
    },
  ): void {
    this.captureEvent(PostHogEventName.PULL_COMPLETED, actor, properties);
  }

  /*******************************************************
   * Subscription events
   *******************************************************/
  trackTrialStarted(actor: Actor, planType: ScratchPlanType): void {
    this.captureEvent(PostHogEventName.TRIAL_STARTED, actor, {
      planType,
    });
  }

  trackSubscriptionCancelled(actor: Actor, planType: ScratchPlanType): void {
    this.captureEvent(PostHogEventName.SUBSCRIPTION_CANCELLED, actor, {
      planType,
    });
  }
  trackSubscriptionChanged(actor: Actor, previousPlanType: ScratchPlanType, newPlanType: ScratchPlanType): void {
    this.captureEvent(PostHogEventName.SUBSCRIPTION_CHANGED, actor, {
      previousPlan: previousPlanType,
      newPlan: newPlanType,
    });
  }

  /*******************************************************
   * CLI events (user actions via CLI that are not tracked elsewhere)
   *******************************************************/
  trackCliListWorkbooks(
    actor: Actor,
    options?: { workbookCount?: number; scope?: 'list' | 'single'; workbookId?: string },
  ): void {
    this.captureEvent(PostHogEventName.CLI_LIST_WORKBOOKS, actor, {
      ...(options?.workbookCount !== undefined && { workbookCount: options.workbookCount }),
      ...(options?.scope && { scope: options.scope }),
      ...(options?.workbookId && { workbookId: options.workbookId }),
    });
  }

  trackCliListTables(actor: Actor, workbookId: string, options?: { connectionId?: string }): void {
    this.captureEvent(PostHogEventName.CLI_LIST_TABLES, actor, {
      workbookId,
      ...(options?.connectionId && { connectionId: options.connectionId }),
    });
  }

  trackCliListDataFolders(
    actor: Actor,
    workbookId: string,
    options?: { folderId?: string; scope?: 'list' | 'single' },
  ): void {
    this.captureEvent(PostHogEventName.CLI_LIST_DATA_FOLDERS, actor, {
      workbookId,
      ...(options?.folderId && { folderId: options.folderId }),
      ...(options?.scope && { scope: options.scope }),
    });
  }

  trackCliGitOperation(actor: Actor, workbookId: string, options: { method: string }): void {
    this.captureEvent(PostHogEventName.CLI_GIT_ACTION, actor, { workbookId, method: options.method });
  }

  trackCliGetJobProgress(actor: Actor, jobId: string): void {
    this.captureEvent(PostHogEventName.CLI_GET_JOB_PROGRESS, actor, { jobId });
  }

  trackCliListSyncs(actor: Actor, workbookId: string, options?: { syncId?: string; scope?: 'list' | 'single' }): void {
    this.captureEvent(PostHogEventName.CLI_LIST_SYNCS, actor, {
      workbookId,
      ...(options?.syncId && { syncId: options.syncId }),
      ...(options?.scope && { scope: options.scope }),
    });
  }
}

export enum PostHogEventName {
  ACCOUNT_USER_CREATED = 'account_user_created',
  /**
   * DEV-10331: an existing Scratch user was linked (adopted) to a Whalesync identity by the
   * email-reconciliation path — a native account and the same-email Whalesync user became one.
   * Distinct from ACCOUNT_USER_CREATED (creation, not linking). Properties:
   * { whalesync_user_id, email, role } and a `$set` of `whalesync_user_id` on the person.
   */
  WHALESYNC_ACCOUNT_LINKED = 'whalesync_account_linked',
  CONNECTOR_ACCOUNT_CREATED = 'connector_created',
  CONNECTOR_ACCOUNT_UPDATED = 'connector_updated',
  CONNECTOR_ACCOUNT_REMOVED = 'connector_deleted',
  CONNECTOR_ACCOUNT_REAUTHORIZED = 'connector_reauthorized',
  WORKBOOK_CREATED = 'workbook_created',
  WORKBOOK_UPDATED = 'workbook_updated',
  WORKBOOK_CHANGES_DISCARDED = 'workbook_changes_discarded',
  WORKBOOK_REMOVED = 'workbook_deleted',
  WORKBOOK_RESET = 'workbook_reset',
  WORKBOOK_PULLED = 'workbook_pulled',
  WORKBOOK_PULL_FILES = 'workbook_pull_files',
  WORKBOOK_PUBLISH_TRIGGERED = 'workbook_publish_triggered',
  WORKBOOK_PUBLISHED = 'workbook_published',
  /**
   * DEV-10316: the dirty gate refused a desktop/CLI publish because the
   * connection still had unpublished changes on the server. The fire rate is
   * the signal for whether the gate hits the common case — i.e. how urgent the
   * deeper fix (publish only the approved subset) is. Properties:
   * { connectorAccountId, dirtyCount }.
   */
  DESKTOP_PUBLISH_BLOCKED_DIRTY = 'desktop_publish_blocked_dirty',
  /**
   * DEV-10316 publish-time TOCTOU abort: the publish-plan build found the
   * connection's `dirty` HEAD had drifted past the `expectedBaseDirtyHead` the
   * client captured at upload (the server changed while the user was reviewing
   * "Ready to publish"), so the plan was aborted before `rebaseDirty` rather
   * than ship the surprise. Complements DESKTOP_PUBLISH_BLOCKED_DIRTY (which is
   * the upload-time gate); together they bound how often the wall fires.
   * Properties: { workbookId, connectorAccountId, dirtyCount }.
   */
  PUBLISH_ABORTED_DIRTY_DRIFT = 'publish_aborted_dirty_drift',
  AGENT_CREDENTIAL_CREATED = 'agent_credential_created',
  AGENT_CREDENTIAL_DELETED = 'agent_credential_deleted',
  TRIAL_STARTED = 'trial_started',
  SUBSCRIPTION_CANCELLED = 'subscription_cancelled',
  SUBSCRIPTION_CHANGED = 'subscription_changed',
  DATA_FOLDER_ADDED = 'data_folder_added',
  DATA_FOLDER_REMOVED = 'data_folder_removed',
  SYNC_CREATED = 'sync_created',
  SYNC_UPDATED = 'sync_updated',
  SYNC_REMOVED = 'sync_removed',
  START_SYNC_RUN = 'start_sync_run',
  SYNC_COMPLETED = 'sync_completed',
  PUBLISH_COMPLETED = 'publish_completed',
  PULL_COMPLETED = 'pull_completed',
  PULL_FILES = 'pull_files',
  RECORD_CREATED = 'record_created',
  RECORD_EDITED = 'record_edited',
  RECORD_DELETED = 'record_deleted',
  PULL_TABLES_FOR_DATA_SOURCE = 'pull_tables_for_data_source',
  CLI_TEST_CONNECTION = 'cli_test_connection',
  CLI_LIST_TABLES = 'cli_list_tables',
  CLI_LIST_WORKBOOKS = 'cli_list_workbooks',
  CLI_LIST_DATA_FOLDERS = 'cli_list_data_folders',
  CLI_GIT_ACTION = 'cli_download',
  CLI_PULL = 'cli_pull',
  CLI_UPLOAD = 'cli_upload',
  CLI_VALIDATE_FILES = 'cli_validate_files',
  CLI_UPLOAD_FOLDER = 'cli_upload_folder',
  CLI_GET_JOB_PROGRESS = 'cli_get_job_progress',
  CLI_LIST_SYNCS = 'cli_list_syncs',
  WORKSPACE_PERMISSION_CREATED = 'workspace_permission_created',
  WORKSPACE_PERMISSION_UPDATED = 'workspace_permission_updated',
  WORKSPACE_PERMISSION_REMOVED = 'workspace_permission_removed',
}

/*******************************************************
 * Helper functions
 *******************************************************/

function mapWorkbookProperties(workbook: WorkbookCluster.Workbook): PostHogEventProperties {
  try {
    return {
      workbookId: workbook.id,
      numTables: workbook.dataFolders.length,
      connectors: workbook.dataFolders.map((t) => t.connectorAccount?.service),
    };
  } catch (err) {
    WSLogger.warn({
      source: PostHogService.name,
      message: 'Failed to map workbook properties for PostHog',
      error: err,
      workbookId: workbook?.id,
    });
    return {};
  }
}

function mapDataFolderProperties(dataFolder: DataFolder): PostHogEventProperties {
  try {
    return {
      dataFolderId: dataFolder.id,
      name: dataFolder.name,
      connectorService: dataFolder.connectorService,
    };
  } catch (err) {
    WSLogger.warn({
      source: PostHogService.name,
      message: 'Failed to map data folder properties for PostHog',
      error: err,
      dataFolderId: dataFolder?.id,
    });
    return {};
  }
}

function mapSyncProperties(sync: Sync): PostHogEventProperties {
  try {
    return {
      syncId: sync.id,
      name: sync.displayName,
    };
  } catch (err) {
    WSLogger.warn({
      source: PostHogService.name,
      message: 'Failed to map sync properties for PostHog',
      error: err,
      syncId: sync?.id,
    });
    return {};
  }
}
