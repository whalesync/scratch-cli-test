import { WorkbookId } from '../../ids';

export type DeleteWorkbookResponseStatus = 'deletion_scheduled' | 'deleted';

export interface DeleteWorkbookResponseDto {
  status: DeleteWorkbookResponseStatus;
  workbookId: WorkbookId;
}
