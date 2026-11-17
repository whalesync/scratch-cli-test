import { DataFolderId, WorkbookId } from '@spinner/shared-types';
import { Arguments } from 'swr';

export const SWR_KEYS = {
  connectorsMetadata: {
    all: () => ['connectors-metadata', 'all'] as const,
  },
  transformerMetadata: {
    all: () => ['transformer-metadata', 'all'] as const,
  },
  cron: {
    jobs: () => ['cron', 'jobs'] as const,
  },
  gitMaintenance: {
    config: () => ['git-maintenance', 'config'] as const,
    status: () => ['git-maintenance', 'status'] as const,
    runs: (repo: string | null) => ['git-maintenance', 'runs', repo ?? '*'] as const,
    settings: () => ['git-maintenance', 'settings'] as const,
    repos: () => ['git-maintenance', 'repos'] as const,
    ticks: () => ['git-maintenance', 'ticks'] as const,
  },
  connectorAccounts: {
    list: (workbookId: string) => ['connector-accounts', 'list', workbookId],
    detail: (workbookId: string, id: string) => ['connector-accounts', 'detail', workbookId, id],
    tables: (workbookId: string, connectorAccountId: string) => [
      'connector-accounts',
      'tables',
      workbookId,
      connectorAccountId,
    ],
    createDestinations: (workbookId: string, connectorAccountId: string) => [
      'connector-accounts',
      'create-destinations',
      workbookId,
      connectorAccountId,
    ],
    searchTables: (workbookId: string, connectorAccountId: string, searchTerm: string) => [
      'connector-accounts',
      'search-tables',
      workbookId,
      connectorAccountId,
      searchTerm,
    ],
    quota: (workbookId: string, id: string) => ['connector-accounts', 'quota', workbookId, id] as const,
  },
  workbook: {
    list: (sortBy?: string, sortOrder?: string) => ['workbook', 'list', sortBy ?? 'all', sortOrder ?? 'all'],
    listKeyMatcher: () => (key: Arguments) => Array.isArray(key) && key[0] === 'workbook' && key[1] === 'list',
    detail: (id: WorkbookId) => ['workbook', 'detail', id],
    permissions: (id: WorkbookId) => ['workbook', 'permissions', id] as const,
    invites: (id: WorkbookId) => ['workbook', 'invites', id] as const,
    organizationUsageSummary: () => ['workbook', 'organization-usage-summary'] as const,
  },
  users: {
    activeUser: () => ['users', 'activeUser'],
  },
  oauthInstall: {
    // Metadata for a marketplace-initiated ("inbound") install awaiting claim.
    pending: (installId: string) => ['oauth-install', 'pending', installId] as const,
  },
  devTools: {
    waitlistPending: () => ['dev-tools', 'waitlist-pending'] as const,
    availableMigrations: () => ['dev-tools', 'available-migrations'] as const,
    adminWorkbooks: (listParameters: object) => ['dev-tools', 'admin-workbooks', listParameters] as const,
  },
  billing: {
    plans: () => ['billing', 'plans'],
  },
  desktopRelease: {
    latest: () => ['desktop-release', 'latest'] as const,
  },
  cliRelease: {
    latest: () => ['cli-release', 'latest'] as const,
  },
  files: {
    listByFolder: (workbookId: WorkbookId, folderId: string) => ['files', 'list', workbookId, folderId] as const,
    detail: (workbookId: WorkbookId, fileId: string) => ['files', 'detail', workbookId, fileId] as const,
    // Matches all file list keys for a workbook
    listKeyMatcher: (workbookId: WorkbookId) => (key: Arguments) =>
      Array.isArray(key) && key[0] === 'files' && key[1] === 'list' && key[2] === workbookId,
    // Matches all file keys for a workbook
    allKeyMatcher: (workbookId: WorkbookId) => (key: Arguments) =>
      Array.isArray(key) && key[0] === 'files' && key[2] === workbookId,
    resolveReferences: (workbookId: WorkbookId, path: string, branch: string) =>
      ['files', 'resolve-references', workbookId, path, branch] as const,
    repoFile: (workbookId: WorkbookId, filePath: string, connectorAccountId?: string, useConfigRepo?: boolean) =>
      ['files', 'repo-file', workbookId, filePath, connectorAccountId, useConfigRepo ? 'config' : undefined] as const,
    // Flattened JSON key paths of a repo file on the default branch, used as path suggestions.
    flattenedJsonPaths: (workbookId: WorkbookId, filePath: string) =>
      ['files', 'flattened-json-paths', workbookId, filePath] as const,
    // Browse a path within a standalone scratch repo (DEV-10424): files + subdirectories on `main`.
    scratchBrowse: (workbookId: WorkbookId, gitFolderPath: string) =>
      ['files', 'scratch-browse', workbookId, gitFolderPath] as const,
  },
  git: {
    graph: (workbookId: WorkbookId, connectorAccountId?: string, useConfigRepo?: boolean) =>
      ['git', 'graph', workbookId, connectorAccountId, useConfigRepo ? 'config' : undefined] as const,
    repoFolderListing: (
      workbookId: WorkbookId,
      branch: string,
      folderPath: string,
      connectorAccountId?: string,
      useConfigRepo?: boolean,
    ) =>
      [
        'git',
        'folder-listing',
        workbookId,
        branch,
        folderPath,
        connectorAccountId,
        useConfigRepo ? 'config' : undefined,
      ] as const,
    repoFileContent: (
      workbookId: WorkbookId,
      branch: string,
      filePath: string,
      connectorAccountId?: string,
      useConfigRepo?: boolean,
    ) =>
      [
        'git',
        'file-content',
        workbookId,
        branch,
        filePath,
        connectorAccountId,
        useConfigRepo ? 'config' : undefined,
      ] as const,
  },
  jobs: {
    activeByWorkbook: (workbookId: WorkbookId) => ['jobs', 'active-by-workbook', workbookId] as const,
    allJobs: (limit?: number, offset?: number, statuses?: string[], userId?: string) =>
      ['jobs', 'all', limit, offset, statuses?.join(',') ?? 'all', userId ?? 'all'] as const,
    raw: (jobId: string) => ['jobs', 'raw', jobId] as const,
  },
  dirtyFiles: {
    list: (workbookId: WorkbookId) => ['dirty-files', 'list', workbookId] as const,
    hasDirty: (workbookId: WorkbookId) => ['dirty-files', 'has-dirty', workbookId] as const,
    count: (workbookId: WorkbookId) => ['dirty-files', 'count', workbookId] as const,
  },
  schedules: {
    list: (workbookId: WorkbookId) => ['schedules', 'list', workbookId] as const,
  },
  routines: {
    list: (workbookId: WorkbookId) => ['routines', 'list', workbookId] as const,
    file: (workbookId: WorkbookId, path: string) => ['routines', 'file', workbookId, path] as const,
    runs: (workbookId: WorkbookId, routineFilePath?: string) =>
      ['routines', 'runs', workbookId, routineFilePath ?? null] as const,
    run: (workbookId: WorkbookId, runId: string, includeJobs = false) =>
      ['routines', 'run', workbookId, runId, includeJobs] as const,
  },
  dataFolders: {
    list: (workbookId: WorkbookId) => ['data-folders', 'list', workbookId] as const,
    detail: (dataFolderId: DataFolderId) => ['data-folders', 'detail', dataFolderId] as const,
    files: (dataFolderId: DataFolderId, limit?: number, offset?: number) =>
      ['data-folders', 'files', dataFolderId, limit, offset] as const,
    publishStatus: (workbookId: WorkbookId) => ['data-folders', 'publish-status', workbookId] as const,
    schema: (dataFolderId: DataFolderId, mode: 'view' | 'refresh') =>
      ['data-folders', 'schema', dataFolderId, mode] as const,
  },
  publishPlans: {
    recordPlan: (workbookId: WorkbookId, planId: string, filePath: string) =>
      ['publish-plans', 'record-plan', workbookId, planId, filePath] as const,
    list: (workbookId: WorkbookId, page: number, pageSize: number, connectorAccountId: string | null) =>
      ['publish-plans', 'list', workbookId, page, pageSize, connectorAccountId ?? ''] as const,
    operations: (
      workbookId: WorkbookId,
      planId: string,
      page: number,
      pageSize: number,
      phase: string,
      hasError: boolean,
    ) => ['publish-plans', 'operations', workbookId, planId, page, pageSize, phase, hasError] as const,
    detail: (workbookId: WorkbookId, planId: string) => ['publish-plans', 'detail', workbookId, planId] as const,
    records: (workbookId: WorkbookId, planId: string, page: number, dataFolderId?: string, phase?: string) =>
      ['publish-plans', 'records', workbookId, planId, page, dataFolderId ?? '', phase ?? ''] as const,
    operation: (workbookId: WorkbookId, planId: string, filePath: string, phase: string) =>
      ['publish-plans', 'operation', workbookId, planId, filePath, phase] as const,
    fileIndex: (workbookId: WorkbookId, page: number) => ['publish-plans', 'file-index', workbookId, page] as const,
    refIndex: (workbookId: WorkbookId, page: number) => ['publish-plans', 'ref-index', workbookId, page] as const,
    assetIndex: (workbookId: WorkbookId, dataFolderId: string, page: number) =>
      ['publish-plans', 'asset-index', workbookId, dataFolderId, page] as const,
    changedFiles: (workbookId: WorkbookId, planId: string, from: string, to: string, page: number) =>
      ['publish-plans', 'changed-files', workbookId, planId, from, to, page] as const,
    fileDiff: (workbookId: WorkbookId, planId: string, filePath: string, from: string, to: string) =>
      ['publish-plans', 'file-diff', workbookId, planId, filePath, from, to] as const,
  },
};
