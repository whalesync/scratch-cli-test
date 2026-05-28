import Store from 'electron-store';
import { setCurrentWorkspaceId } from './preferences-store';

interface AuthStoreSchema {
  apiToken: string | null;
  email: string | null;
  tokenExpiresAt: string | null; // ISO date string
  serverUrl: string | null;
}

const store = new Store<AuthStoreSchema>({
  name: 'auth',
  encryptionKey: 'scratch-desktop-auth',
  defaults: {
    apiToken: null,
    email: null,
    tokenExpiresAt: null,
    serverUrl: null,
  },
});

export interface StoredCredentials {
  apiToken: string | null;
  email: string | null;
  tokenExpiresAt: string | null;
  serverUrl: string | null;
}

export function getCredentials(): StoredCredentials {
  return {
    apiToken: store.get('apiToken'),
    email: store.get('email'),
    tokenExpiresAt: store.get('tokenExpiresAt'),
    serverUrl: store.get('serverUrl'),
  };
}

export function saveCredentials(creds: {
  apiToken: string;
  email?: string;
  tokenExpiresAt?: string;
  serverUrl: string;
}): void {
  // If the user changed (different email), clear the stored workspace — it belongs to the old account.
  const previousEmail = store.get('email');
  if (previousEmail && creds.email && previousEmail !== creds.email) {
    setCurrentWorkspaceId(null);
  }

  store.set('apiToken', creds.apiToken);
  store.set('email', creds.email ?? null);
  store.set('tokenExpiresAt', creds.tokenExpiresAt ?? null);
  store.set('serverUrl', creds.serverUrl);
}

export function clearCredentials(): void {
  store.clear();
  setCurrentWorkspaceId(null);
}

export function isTokenExpired(): boolean {
  const expiresAt = store.get('tokenExpiresAt');
  if (!expiresAt) return false;
  return new Date(expiresAt) < new Date();
}
