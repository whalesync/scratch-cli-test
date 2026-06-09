import { WorkbookId, Workspace } from '@spinner/shared-types';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';

// Define the global modals that can be show from anywhere in the workbook UI
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

// Define the global error that can be shown from anywhere in the workbook UI
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

export interface WorkbookUIState {
  // The real entities are available with useActiveWorkbook() hook.
  workbookId: WorkbookId | null;

  activeModal: WorkbookModalParams | null;

  // Global Workspace Error
  workbookError: WorkbookError | null;

  // Selection state is URL-driven (from route params), not stored here
  expandedNodes: Set<string>;
  showHiddenConnections: Set<string>;
  hiddenFileFolders: Set<string>;
  sidebarWidth: number;
  tableFilters: Record<string, string>; // folderId -> filter text
}

type Actions = {
  openWorkbook: (params: { workbookId: WorkbookId }) => void;
  closeWorkbook: () => void;
  reconcileWithWorkbook: (workbook: Workspace) => void;

  showModal: (modal: WorkbookModalParams) => void;
  dismissModal: (modalType: WorkbookModalParams['type']) => void;

  setWorkbookError: (error: WorkbookError) => void;
  clearWorkbookError: () => void;

  toggleNode: (nodeId: string) => void;
  expandNode: (nodeId: string) => void;
  collapseNode: (nodeId: string) => void;
  expandAll: (nodeIds: string[]) => void;
  collapseAll: () => void;
  toggleHiddenFiles: (connectorAccountId: string) => void;
  setSidebarWidth: (width: number) => void;
  setTableFilter: (folderId: string, filter: string) => void;
  clearTableFilter: (folderId: string) => void;
  reset: () => void;
};

type WorkbookUIStore = WorkbookUIState & Actions;

const INITIAL_STATE: WorkbookUIState = {
  workbookId: null,
  activeModal: null,
  workbookError: null,
  expandedNodes: new Set<string>(),
  showHiddenConnections: new Set<string>(),
  hiddenFileFolders: new Set<string>(),
  sidebarWidth: 320,
  tableFilters: {},
};

export const useWorkbookUIStore = create<WorkbookUIStore>()(
  persist(
    (set, get) => ({
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
      reconcileWithWorkbook: (workbook: Workspace) => {
        const current = get();

        if (workbook.id !== current.workbookId) {
          return;
        }
        // TODO: update the state with the new workbook
      },

      showModal: (modal: WorkbookModalParams) => set({ activeModal: modal }),
      dismissModal: (modalType: WorkbookModalParams['type'] | null) => {
        if (modalType && modalType !== get().activeModal?.type) {
          return;
        }
        set({ activeModal: null });
      },

      setWorkbookError: (error: WorkbookError) => set({ workbookError: error }),
      clearWorkbookError: () => set({ workbookError: null }),

      toggleNode: (nodeId: string) => {
        const { expandedNodes } = get();
        const newExpanded = new Set(expandedNodes);
        if (newExpanded.has(nodeId)) {
          newExpanded.delete(nodeId);
        } else {
          newExpanded.add(nodeId);
        }
        set({ expandedNodes: newExpanded });
      },

      expandNode: (nodeId: string) => {
        const { expandedNodes } = get();
        const newExpanded = new Set(expandedNodes);
        newExpanded.add(nodeId);
        set({ expandedNodes: newExpanded });
      },

      collapseNode: (nodeId: string) => {
        const { expandedNodes } = get();
        const newExpanded = new Set(expandedNodes);
        newExpanded.delete(nodeId);
        set({ expandedNodes: newExpanded });
      },

      expandAll: (nodeIds: string[]) => {
        set({ expandedNodes: new Set(nodeIds) });
      },

      collapseAll: () => {
        set({ expandedNodes: new Set() });
      },

      toggleHiddenFiles: (connectorAccountId: string) => {
        const { showHiddenConnections } = get();
        const newSet = new Set(showHiddenConnections);
        if (newSet.has(connectorAccountId)) {
          newSet.delete(connectorAccountId);
        } else {
          newSet.add(connectorAccountId);
        }
        set({ showHiddenConnections: newSet });
      },

      setSidebarWidth: (width: number) => {
        // Clamp between 220 and 500
        const clampedWidth = Math.min(500, Math.max(220, width));
        set({ sidebarWidth: clampedWidth });
      },

      setTableFilter: (folderId: string, filter: string) => {
        const { tableFilters } = get();
        set({ tableFilters: { ...tableFilters, [folderId]: filter } });
      },

      clearTableFilter: (folderId: string) => {
        const { tableFilters } = get();
        const newFilters = { ...tableFilters };
        delete newFilters[folderId];
        set({ tableFilters: newFilters });
      },

      reset: () => {
        set(INITIAL_STATE);
      },
    }),
    {
      name: 'workbook-ui-store',
      // Custom serialization for Set
      storage: {
        getItem: (name) => {
          const str = localStorage.getItem(name);
          if (!str) return null;
          const parsed = JSON.parse(str) as {
            state: {
              expandedNodes?: string[];
              showHiddenConnections?: string[];
              hiddenFileFolders?: string[];
            };
          };
          return {
            ...parsed,
            state: {
              ...parsed.state,
              expandedNodes: new Set(parsed.state.expandedNodes ?? []),
              showHiddenConnections: new Set(parsed.state.showHiddenConnections ?? []),
              hiddenFileFolders: new Set(parsed.state.hiddenFileFolders ?? []),
            },
          };
        },
        setItem: (name, value) => {
          const toStore = {
            ...value,
            state: {
              ...value.state,
              expandedNodes: Array.from(value.state.expandedNodes || []),
              showHiddenConnections: Array.from(value.state.showHiddenConnections || []),
              hiddenFileFolders: Array.from(value.state.hiddenFileFolders || []),
            },
          };
          localStorage.setItem(name, JSON.stringify(toStore));
        },
        removeItem: (name) => localStorage.removeItem(name),
      },
    },
  ),
);
