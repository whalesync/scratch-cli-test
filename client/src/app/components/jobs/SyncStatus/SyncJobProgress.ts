export type TableStatus = 'pending' | 'in_progress' | 'completed' | 'failed';

export type SyncDataFoldersPublicProgress = {
  totalFilesSynced: number;
  tables: {
    id: string;
    name: string;
    connector: string;
    creates: number;
    updates: number;
    deletes: number;
    skipped: number;
    status: TableStatus;
  }[];
};
