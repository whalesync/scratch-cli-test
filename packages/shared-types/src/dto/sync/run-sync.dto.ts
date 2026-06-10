/** Response for `POST /workbooks/:workbookId/syncs/:syncId/run`. */
export interface RunSyncResponse {
  success: boolean;
  jobId: string;
  message: string;
}
