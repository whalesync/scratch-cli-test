'use client';

import { API_CONFIG } from '@/lib/api/config';
import { SWR_KEYS } from '@/lib/api/keys';
import { MessageLogItem, SubscriptionConfirmedEvent, Subscriptions } from '@/types/workbook-websocket';
import { DataFolderId, isDataFolderId, WorkbookEvent, WorkbookId } from '@spinner/shared-types';
import { io, Socket } from 'socket.io-client';
import { mutate } from 'swr';
import { create } from 'zustand';

/**
 * A Zustand store that manages Socket.IO connections to the Workbook WebSocket service as a singleton,
 * ensuring stable connections across component lifecycles.
 *
 * - Singleton Socket: One Socket.IO connection shared across all components
 * - Automatic Reconnection: Built-in Socket.IO reconnection with exponential backoff
 * - Message History: Centralized event message log for debugging
 * - Workbook Subscriptions: Subscribe to snapshot and table events per workbook
 */

type State = {
  socket: Socket | null;
  isConnected: boolean;
  subscriptions: Subscriptions;
  messageLog: MessageLogItem[];
  currentWorkbookId: WorkbookId | null;
};

type Actions = {
  connect: (workbookId: WorkbookId) => void;
  disconnect: () => void;
  sendPing: () => void;
  _addToMessageLog: (message: string) => void;
  _setSubscriptions: (subscriptions: Partial<Subscriptions>) => void;
  _handleWorkbookEvent: (event: WorkbookEvent, workbookId: WorkbookId) => void;
};

type WorkbookWebSocketStore = State & Actions;

const MESSAGE_LOG_MAX_LENGTH = 30;

/**
 * Suppresses WebSocket-triggered folder revalidation during batch operations
 * (e.g. ChooseTablesModal creating/deleting multiple folders).
 *
 * While suppressed, incoming folder-created/folder-deleted events don't trigger
 * SWR revalidation. When unsuppressed, a single revalidation fires. A short grace
 * period absorbs late-arriving websocket events after unsuppress.
 */
let folderMutationSuppressed = false;
let suppressionTimeout: ReturnType<typeof setTimeout> | null = null;
const SUPPRESSION_SAFETY_TIMEOUT_MS = 30_000;
const SUPPRESSION_GRACE_PERIOD_MS = 2_000;

export function suppressFolderMutations() {
  folderMutationSuppressed = true;

  // Safety timeout: auto-unsuppress if caller never calls unsuppress (e.g. navigation away)
  if (suppressionTimeout) clearTimeout(suppressionTimeout);
  suppressionTimeout = setTimeout(() => {
    if (folderMutationSuppressed) {
      console.debug('Folder mutation suppression safety timeout fired');
      folderMutationSuppressed = false;
    }
  }, SUPPRESSION_SAFETY_TIMEOUT_MS);
}

export function unsuppressFolderMutations(workbookId: WorkbookId) {
  if (suppressionTimeout) {
    clearTimeout(suppressionTimeout);
    suppressionTimeout = null;
  }

  // Keep suppression active briefly to absorb late-arriving websocket events,
  // then do a single revalidation after the grace period.
  setTimeout(() => {
    folderMutationSuppressed = false;
    mutate(SWR_KEYS.dataFolders.list(workbookId), undefined, { revalidate: true });
    mutate(SWR_KEYS.workbook.detail(workbookId), undefined, { revalidate: true });
  }, SUPPRESSION_GRACE_PERIOD_MS);
}

export function resetFolderMutationSuppression() {
  folderMutationSuppressed = false;
  if (suppressionTimeout) {
    clearTimeout(suppressionTimeout);
    suppressionTimeout = null;
  }
}

const log = (message: string, data?: unknown) => {
  if (data) {
    console.debug('Workbook Websocket Event:', message, data);
  } else {
    console.debug('Workbook Websocket Event:', message);
  }
};

export const useWorkbookWebSocketStore = create<WorkbookWebSocketStore>((set, get) => ({
  // Initial state
  socket: null,
  isConnected: false,
  subscriptions: {
    workbook: false,
    tables: [],
  },
  messageLog: [],
  currentWorkbookId: null,

  _addToMessageLog: (message: string) => {
    set((state) => ({
      messageLog: [{ message, timestamp: new Date() }, ...state.messageLog].slice(0, MESSAGE_LOG_MAX_LENGTH),
    }));
  },

  _setSubscriptions: (updates: Partial<Subscriptions>) => {
    set((state) => ({
      subscriptions: {
        ...state.subscriptions,
        ...updates,
      },
    }));
  },

  _handleWorkbookEvent: (event: WorkbookEvent, workbookId: WorkbookId) => {
    console.debug('Workbook event received:', event);

    if (event.type === 'workbook-updated') {
      get()._addToMessageLog('Mutate workbook SWR keys');
      mutate(SWR_KEYS.workbook.detail(workbookId), undefined, {
        revalidate: true,
      });
      mutate(SWR_KEYS.workbook.list());
      return;
    }

    if (event.type === 'job-started' || event.type === 'job-completed' || event.type === 'job-failed') {
      get()._addToMessageLog('Mutate job status SWR keys');
      mutate(SWR_KEYS.jobs.activeByWorkbook(workbookId), undefined, {
        revalidate: true,
      });
      return;
    }

    if (event.type === 'changes-discarded') {
      get()._addToMessageLog('Mutate changes discarded SWR keys');
      mutate(SWR_KEYS.dirtyFiles.list(workbookId), undefined, {
        revalidate: true,
      });
      return;
    }

    if (event.type === 'changes-published') {
      get()._addToMessageLog('Mutate changes published SWR keys');
      mutate(SWR_KEYS.dirtyFiles.list(workbookId), undefined, { revalidate: true });
      mutate(SWR_KEYS.dirtyFiles.hasDirty(workbookId), undefined, { revalidate: true });
      mutate(SWR_KEYS.dirtyFiles.count(workbookId), undefined, { revalidate: true });
      return;
    }

    if (event.type === 'folder-created' || event.type === 'folder-deleted') {
      if (folderMutationSuppressed) {
        get()._addToMessageLog('Folder mutation suppressed (batch in progress)');
        return;
      }
      get()._addToMessageLog('Mutate folder list and workbook detail SWR keys');
      mutate(SWR_KEYS.dataFolders.list(workbookId), undefined, { revalidate: true });
      mutate(SWR_KEYS.workbook.detail(workbookId), undefined, { revalidate: true });
      return;
    }

    if (event.type === 'folder-updated') {
      get()._addToMessageLog('Mutate folder updated SWR keys');
      mutate(SWR_KEYS.dataFolders.detail(event.data.entityId as DataFolderId), undefined, {
        revalidate: true,
      });
      return;
    }

    if (event.type === 'folder-contents-changed') {
      get()._addToMessageLog('Mutate file list and folder detail SWR keys');

      if (event.data.entityId && isDataFolderId(event.data.entityId)) {
        mutate(SWR_KEYS.dataFolders.files(event.data.entityId as DataFolderId), undefined, {
          revalidate: true,
        });
        mutate(SWR_KEYS.files.listByFolder(workbookId, event.data.entityId as DataFolderId), undefined, {
          revalidate: true,
        });
      }

      return;
    }

    if (event.type === 'file-changed') {
      // TODO: Mutate file detail SWR key
      return;
    }
  },

  connect: (workbookId: WorkbookId) => {
    const state = get();

    // If already connected to the same workbook, do nothing
    if (state.socket && state.isConnected && state.currentWorkbookId === workbookId) {
      console.debug('Already connected to workbook:', workbookId);
      return;
    }

    // Disconnect existing socket if connecting to a different workbook
    if (state.socket && state.currentWorkbookId !== workbookId) {
      console.debug('Disconnecting from previous workbook:', state.currentWorkbookId);
      state.socket.disconnect();
      resetFolderMutationSuppression();
    }

    console.debug('Creating Socket.IO connection for workbook:', workbookId);

    // Create Socket.IO connection
    const newSocket = io(API_CONFIG.getApiUrl(), {
      transports: ['websocket'],
      path: '/workbook-events',
      auth: {
        token: API_CONFIG.getSnapshotWebsocketToken(),
      },
      // Configure timeouts to be more resilient to browser throttling
      timeout: 60000, // 60 seconds - increased from default 20s
      // Enable reconnection with exponential backoff
      reconnection: true,
      reconnectionAttempts: 5,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
    });

    // Connection event handlers
    newSocket.on('connect', () => {
      log('connected');
      set({ isConnected: true });

      // Subscribe to workbook events when connected
      newSocket.emit('subscribe', { workbookId });
    });

    newSocket.on('disconnect', (reason, description) => {
      log('disconnected', { reason, description });
      set({
        isConnected: false,
        subscriptions: { workbook: false, tables: [] },
      });
    });

    newSocket.on('connect_error', (error) => {
      log('connection error', error);
    });

    newSocket.on('exception', (error) => {
      log('exception', error);
      get()._addToMessageLog('Socket exception: ' + (error.message || 'Unknown error'));
    });

    // Handle different messages:
    newSocket.on('pong', (data) => {
      log('Received message:', data);
      get()._addToMessageLog(typeof data === 'string' ? data : JSON.stringify(data));
    });

    newSocket.on('snapshot-event-subscription-confirmed', (data) => {
      const confirmedEvent = data as SubscriptionConfirmedEvent;
      get()._addToMessageLog(confirmedEvent.message);
      get()._setSubscriptions({ workbook: true });
    });

    newSocket.on('record-event-subscription-confirmed', (data) => {
      const confirmedEvent = data as SubscriptionConfirmedEvent;
      get()._addToMessageLog(`${confirmedEvent.message}: ${confirmedEvent.tableId}`);
      const tableId = confirmedEvent.tableId;
      if (tableId) {
        set((state) => ({
          subscriptions: {
            ...state.subscriptions,
            tables: [...state.subscriptions.tables, tableId],
          },
        }));
      }
    });

    newSocket.on('workbook-event', (data) => {
      get()._addToMessageLog(typeof data === 'string' ? data : JSON.stringify(data));
      get()._handleWorkbookEvent(data as WorkbookEvent, workbookId);
    });

    set({
      socket: newSocket,
      currentWorkbookId: workbookId,
      messageLog: [], // Clear message log when connecting to new workbook
      subscriptions: { workbook: false, tables: [] },
    });
  },

  disconnect: () => {
    const state = get();
    console.debug('Disconnecting Socket.IO');

    if (state.socket) {
      state.socket.disconnect();
      set({
        socket: null,
        isConnected: false,
        currentWorkbookId: null,
        subscriptions: { workbook: false, tables: [] },
      });
    }
  },

  sendPing: () => {
    const state = get();
    if (state.socket && state.isConnected) {
      state.socket.emit('ping');
    }
  },
}));

// Selector hooks for optimized re-renders
export const useWorkbookWebSocketConnection = () =>
  useWorkbookWebSocketStore((state) => ({
    isConnected: state.isConnected,
    subscriptions: state.subscriptions,
  }));

export const useWorkbookWebSocketMessageLog = () => useWorkbookWebSocketStore((state) => state.messageLog);

export const useWorkbookWebSocketActions = () =>
  useWorkbookWebSocketStore((state) => ({
    sendPing: state.sendPing,
    connect: state.connect,
    disconnect: state.disconnect,
  }));
