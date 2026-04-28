import { Service } from '../../enums/enums';
import { WorkbookId } from '../../ids';

export interface AdminWorkbookConnectionDto {
  id: string;
  displayName: string;
  service: Service;
  authType: string;
  createdAt: string;
  repoPath: string | null;
}

export interface AdminWorkbookDto {
  id: WorkbookId;
  name: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
  organizationId: string;
  organizationName: string;
  userId: string | null;
  isPendingDelete: boolean;
  connections: AdminWorkbookConnectionDto[];
}
