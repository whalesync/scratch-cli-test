import Store from 'electron-store';

export interface WorkbookSettings {
  validateEnabled?: boolean;
  /**
   * DEV-10470: when set to `false`, the desktop app does NOT automatically
   * re-download this workspace's latest server data on a schedule (on app open
   * and hourly). Absent/`undefined` is treated as ON — scheduled auto-download
   * is enabled by default; the user opts out per workspace.
   */
  autoDownloadEnabled?: boolean;
  // future per-workbook settings go here
}

/** DEV-10470: scheduled auto-download is on unless the user explicitly disabled it. */
export function isAutoDownloadEnabled(workbookId: string): boolean {
  return getWorkbookSettings(workbookId).autoDownloadEnabled !== false;
}

interface PreferencesStoreSchema {
  currentWorkspaceId: string | null;
  workbookSettings: Record<string, WorkbookSettings>;
}

const store = new Store<PreferencesStoreSchema>({
  name: 'preferences',
  defaults: {
    currentWorkspaceId: null,
    workbookSettings: {},
  },
});

export function getCurrentWorkspaceId(): string | null {
  return store.get('currentWorkspaceId');
}

export function setCurrentWorkspaceId(id: string | null): void {
  store.set('currentWorkspaceId', id);
}

export function getWorkbookSettings(workbookId: string): WorkbookSettings {
  const all = store.get('workbookSettings');
  return all[workbookId] ?? {};
}

export function setWorkbookSetting(workbookId: string, key: keyof WorkbookSettings, value: unknown): void {
  const all = store.get('workbookSettings');
  const current = all[workbookId] ?? {};
  store.set('workbookSettings', {
    ...all,
    [workbookId]: { ...current, [key]: value },
  });
}
