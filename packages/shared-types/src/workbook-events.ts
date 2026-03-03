/*

Types of events to handle:

- workbook-updated
- new job started
- job completed / failed
- changes discarded (global, folder-specific)
- folder created / deleted
- file changes (add, modify, delete)
  - from different sources pull, push, sync
- sync changed

*/

export type WorkbookEventType =
  | 'workbook-updated'
  | 'job-started'
  | 'job-completed'
  | 'job-failed'
  | 'changes-discarded'
  | 'changes-published'
  | 'folder-created'
  | 'folder-deleted'
  | 'folder-updated'
  | 'folder-contents-changed'
  | 'sync-triggered'
  | 'file-changed';

export type WorkbookEventSource = 'user' | 'job' | 'cli' | 'cron';

export interface WorkbookEvent {
  type: WorkbookEventType;
  data: {
    /**
     * What triggered this event
     */
    source: WorkbookEventSource;

    /*
     the id of the entity that was related to the event such as a DataFolder, Sync or Job
    */
    entityId: string;

    /**
     * Message to accompany the event to help with debugging
     */
    message: string;
  } & Record<string, unknown>; // the rest of the data is optional and can be used to store additional context
}
