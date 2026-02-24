import { Workbook, WorkbookId } from '@spinner/shared-types';
import { create } from 'zustand';

/** NOTE - this should be merged with the new-workbook-ui-store */

export enum WorkbookModals {
  RENAME_WORKBOOK = 'rename_workbook',
  CONFIRM_DELETE = 'confirm-delete',
  PUBLISH_PLANS = 'publish_plans',
}

export type WorkbookModalParams =
  | { type: WorkbookModals.RENAME_WORKBOOK }
  | {
      type: WorkbookModals.CONFIRM_DELETE;
      workbookId: WorkbookId /** Provide explicitly to be safe from race conditions */;
    }
  | { type: WorkbookModals.PUBLISH_PLANS };

export interface WorkbookError {
  // Limit the scope of the error to a specific area of the UI. If not provided it will display on all workbook views
  scope?: 'files' | 'review' | 'syncs' | 'runs';
  title?: string;
  description: string;
  // An optional action to present the user as a way to fix the error
  // can be used to display a button to replace the close button
  action?: {
    label: string;
    onClick: () => void;
  };
  cause?: Error;
}

export interface WorkbookEditorUIState {
  // The real entities are available with useActiveWorkbook() hook.
  workbookId: WorkbookId | null;

  // UI state for the dev tools panel.
  devToolsOpen: boolean;

  activeModal: WorkbookModalParams | null;

  // Global Workbook Error
  workbookError: WorkbookError | null;
}

type Actions = {
  openWorkbook: (params: { workbookId: WorkbookId }) => void;
  closeWorkbook: () => void;
  reconcileWithWorkbook: (workbook: Workbook) => void;

  openDevTools: () => void;
  closeDevTools: () => void;

  showModal: (modal: WorkbookModalParams) => void;
  dismissModal: (modalType: WorkbookModalParams['type']) => void;

  setWorkbookError: (error: WorkbookError) => void;
  clearWorkbookError: () => void;
};

type WorkbookEditorUIStore = WorkbookEditorUIState & Actions;

const INITIAL_STATE: WorkbookEditorUIState = {
  workbookId: null,
  devToolsOpen: false,
  activeModal: null,
  workbookError: null,
};

export const useWorkbookEditorUIStore = create<WorkbookEditorUIStore>((set, get) => ({
  ...INITIAL_STATE,
  openWorkbook: (params: { workbookId: WorkbookId }) => {
    set({ workbookId: params.workbookId });
  },
  closeWorkbook: () => {
    set({ ...INITIAL_STATE });
  },
  /**
   * This is called every time the workbook is updated from the server.
   * Any state that has a dependency on the workbook's data should be updated here, to clean up any stale state.
   */
  reconcileWithWorkbook: (workbook: Workbook) => {
    const current = get();

    if (workbook.id !== current.workbookId) {
      return;
    }
    // TODO: update the state with the new workbook
  },

  openDevTools: () => set({ devToolsOpen: true }),
  closeDevTools: () => set({ devToolsOpen: false }),

  showModal: (modal: WorkbookModalParams) => set({ activeModal: modal }),
  dismissModal: (modalType: WorkbookModalParams['type'] | null) => {
    if (modalType && modalType !== get().activeModal?.type) {
      return;
    }
    set({ activeModal: null });
  },

  setWorkbookError: (error: WorkbookError) => set({ workbookError: error }),
  clearWorkbookError: () => set({ workbookError: null }),
}));
