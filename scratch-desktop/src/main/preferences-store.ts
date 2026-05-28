import Store from 'electron-store';

interface PreferencesStoreSchema {
  currentWorkspaceId: string | null;
}

const store = new Store<PreferencesStoreSchema>({
  name: 'preferences',
  defaults: {
    currentWorkspaceId: null,
  },
});

export function getCurrentWorkspaceId(): string | null {
  return store.get('currentWorkspaceId');
}

export function setCurrentWorkspaceId(id: string | null): void {
  store.set('currentWorkspaceId', id);
}
