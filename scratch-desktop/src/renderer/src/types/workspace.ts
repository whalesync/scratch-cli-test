/** Mirrors the server's Workbook entity, using "workspace" as the UI term. */
export interface Workspace {
  id: string;
  name: string | null;
  createdAt: string;
  updatedAt: string;
  version: number;
  userId: string | null;
  organizationId: string;
  dataFolders?: DataFolder[];
}

export interface DataFolder {
  id: string;
  name: string;
  path: string | null;
  connectorService: string | null;
  connectorDisplayName: string | null;
}
