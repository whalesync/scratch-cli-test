import { RouteUrls } from '@/utils/route-urls';

export const SETTINGS_RETURN_PATH_STORAGE_KEY = 'scratch:settingsReturnPath';

export function isUnderSettingsPath(pathname: string): boolean {
  return pathname === RouteUrls.settingsPageUrl || pathname.startsWith(`${RouteUrls.settingsPageUrl}/`);
}

function isSafeInternalPath(path: string): boolean {
  if (!path.startsWith('/') || path.startsWith('//')) {
    return false;
  }
  if (path.includes('://')) {
    return false;
  }
  return true;
}

/** Returns the path only if it is safe to pass to the router (guards tampered session storage). */
export function safeSettingsReturnPath(stored: string | null): string | null {
  if (stored === null || !isSafeInternalPath(stored)) {
    return null;
  }
  return stored;
}

export function safePathForSettingsReturnStorage(path: string): string | null {
  return isSafeInternalPath(path) ? path : null;
}
