import Store from 'electron-store';

export interface WorkbookSettings {
  validateEnabled?: boolean;
  // future per-workbook settings go here
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
