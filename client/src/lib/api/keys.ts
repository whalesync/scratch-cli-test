import { DataFolderId, WorkbookId } from '@spinner/shared-types';
import { Arguments } from 'swr';

export const SWR_KEYS = {
  connectorAccounts: {
    list: (workbookId: string) => ['connector-accounts', 'list', workbookId],
    detail: (workbookId: string, id: string) => ['connector-accounts', 'detail', workbookId, id],
    tables: (workbookId: string, connectorAccountId: string) => [
      'connector-accounts',
      'tables',
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
  },
  workbook: {
    list: (sortBy?: string, sortOrder?: string) => ['workbook', 'list', sortBy ?? 'all', sortOrder ?? 'all'],
    listKeyMatcher: () => (key: Arguments) => Array.isArray(key) && key[0] === 'workbook' && key[1] === 'list',
    detail: (id: WorkbookId) => ['workbook', 'detail', id],
    permissions: (id: WorkbookId) => ['workbook', 'permissions', id] as const,
    invites: (id: WorkbookId) => ['workbook', 'invites', id] as const,
  },
  users: {
    activeUser: () => ['users', 'activeUser'],
  },
  billing: {
    plans: () => ['billing', 'plans'],
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
    repoFile: (workbookId: WorkbookId, filePath: string, connectorAccountId?: string) =>
      ['files', 'repo-file', workbookId, filePath, connectorAccountId] as const,
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
  dataFolders: {
    list: (workbookId: WorkbookId) => ['data-folders', 'list', workbookId] as const,
    detail: (dataFolderId: DataFolderId) => ['data-folders', 'detail', dataFolderId] as const,
    files: (dataFolderId: DataFolderId, limit?: number, offset?: number) =>
      ['data-folders', 'files', dataFolderId, limit, offset] as const,
    publishStatus: (workbookId: WorkbookId) => ['data-folders', 'publish-status', workbookId] as const,
    schema: (dataFolderId: DataFolderId, mode: 'view' | 'refresh') =>
      ['data-folders', 'schema', dataFolderId, mode] as const,
  },
};
