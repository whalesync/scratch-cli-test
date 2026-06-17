import { createConfiguredAxiosInstance, createHttp } from './http';
import { createAuthApi } from './resources/auth';
import { createBugReportApi } from './resources/bug-report';
import { createCliAuthApi } from './resources/cli-auth';
import { createCodeMigrationsApi } from './resources/code-migrations';
import { createConnectorAccountsApi } from './resources/connector-accounts';
import { createConnectorsMetadataApi } from './resources/connectors-metadata';
import { createDataFoldersApi } from './resources/data-folders';
import { createDesktopReleaseApi } from './resources/desktop-release';
import { createDevToolsApi } from './resources/dev-tools';
import { createFilesApi } from './resources/files';
import { createGenericApi } from './resources/generic';
import { createGitApi } from './resources/git';
import { createJobApi } from './resources/job';
import { createMcpAuthApi } from './resources/mcp-auth';
import { createOauthApi } from './resources/oauth';
import { createPaymentApi } from './resources/payment';
import { createPermissionsApi } from './resources/permissions';
import { createProgressApi } from './resources/progress';
import { createPublishApi } from './resources/publish';
import { createRoutineApi } from './resources/routine';
import { createScheduleApi } from './resources/schedule';
import { createSchemaApi } from './resources/schema';
import { createSyncApi } from './resources/sync';
import { createSyncDraftsApi } from './resources/sync-drafts';
import { createTransformerMetadataApi } from './resources/transformer-metadata';
import { createUsersApi } from './resources/users';
import { createWorkspacesApi } from './resources/workspaces';
import { ScratchApiClientConfig } from './types';

/**
 * The shared Scratch REST client. One long-lived instance per app, with namespaced resource
 * access (`client.users.activeUser()`). SWR-agnostic: every method returns a plain promise.
 */
export type ScratchApiClient = ReturnType<typeof createScratchApiClient>;

/**
 * Construct a configured client from injected platform config (base URL, auth token source,
 * optional 401/logging hooks). Construction is cheap, stateless beyond the config + token-getter,
 * and idempotent — an identity change is handled by `auth.getToken`, never by rebuilding.
 */
export function createScratchApiClient(config: ScratchApiClientConfig) {
  const http = createHttp(createConfiguredAxiosInstance(config, { withAuth: true }));
  const httpUnauthenticated = createHttp(createConfiguredAxiosInstance(config, { withAuth: false }));

  return {
    bugReport: createBugReportApi(http),
    cliAuth: createCliAuthApi(http),
    codeMigrations: createCodeMigrationsApi(http),
    connectorAccounts: createConnectorAccountsApi(http),
    connectorsMetadata: createConnectorsMetadataApi(http),
    dataFolders: createDataFoldersApi(http),
    desktopRelease: createDesktopReleaseApi(http),
    devTools: createDevToolsApi(http),
    files: createFilesApi(http),
    generic: createGenericApi(http),
    git: createGitApi(http),
    job: createJobApi(http),
    mcpAuth: createMcpAuthApi(http),
    oauth: createOauthApi(http),
    payment: createPaymentApi(http),
    permissions: createPermissionsApi(http),
    progress: createProgressApi(http),
    publish: createPublishApi(http),
    routine: createRoutineApi(http),
    schedule: createScheduleApi(http),
    schema: createSchemaApi(http),
    sync: createSyncApi(http),
    syncDrafts: createSyncDraftsApi(http),
    transformerMetadata: createTransformerMetadataApi(http),
    users: createUsersApi(http),
    workspaces: createWorkspacesApi(http),
    // Unauthenticated device-code login path (no Authorization header).
    auth: createAuthApi(httpUnauthenticated),
  };
}
