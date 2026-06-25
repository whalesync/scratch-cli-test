/**
 * Maps web-style deep link paths (after scratch://) to HashRouter paths in the desktop app.
 * Unsupported views fall back to the workspace root until the desktop app gains parity.
 */
import { sanitizeDeepLinkSource } from './deep-link-source';

const WORKBOOK_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;

interface LocalWorkspaceEntry {
  id: string;
  path: string;
}

function normalizeFsPath(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/, '');
}

function isSameOrChildPath(path: string, possibleParent: string): boolean {
  return path === possibleParent || path.startsWith(`${possibleParent}/`);
}

function appendDeepLinkNonce(route: string): string {
  const [pathname, query = ''] = route.split('?');
  const params = new URLSearchParams(query);
  params.set('_dl', String(Date.now()));
  const nextQuery = params.toString();
  return nextQuery ? `${pathname}?${nextQuery}` : pathname;
}

function copySanitizedSource(from: URLSearchParams, to: URLSearchParams): void {
  const source = sanitizeDeepLinkSource(from.get('source'));
  if (source) {
    to.set('source', source);
  }
}

export function mapWebWorkbookPathToDesktopRoute(route: string): string {
  const normalized = route.replace(/^\/+|\/+$/g, '');
  const segments = normalized.split('/').filter(Boolean);

  if (segments.length < 2 || segments[0] !== 'workbook') {
    return '/';
  }

  const workbookId = segments[1];
  if (!WORKBOOK_ID_PATTERN.test(workbookId)) {
    return '/';
  }

  if (segments.length === 2) {
    return `/workspace/${workbookId}`;
  }

  const rest = segments.slice(2);
  if (rest[0] === 'debug') {
    return `/workspace/${workbookId}/debug`;
  }

  if (rest[0] === 'publish-history') {
    return `/workspace/${workbookId}/publish-history`;
  }

  if (rest[0] === 'publish-plan' && rest[1] && WORKBOOK_ID_PATTERN.test(rest[1])) {
    return `/workspace/${workbookId}/publish-plan/${rest[1]}`;
  }

  return `/workspace/${workbookId}`;
}

export async function mapDeepLinkToDesktopRoute(route: string, query: string): Promise<string> {
  const normalized = route.replace(/^\/+|\/+$/g, '');
  const segments = normalized.split('/').filter(Boolean);

  if (segments[0] === 'open') {
    const params = new URLSearchParams(query);
    const rawPath = params.get('path');
    if (!rawPath) {
      return '/';
    }

    const targetPath = normalizeFsPath(rawPath);
    const localWorkspaces = await window.scratchDesktop.getWorkspacesRegistry();
    const workspace = localWorkspaces
      .map((entry: LocalWorkspaceEntry) => ({ ...entry, normalizedPath: normalizeFsPath(entry.path) }))
      .filter((entry) => isSameOrChildPath(targetPath, entry.normalizedPath))
      .sort((a, b) => b.normalizedPath.length - a.normalizedPath.length)[0];

    if (!workspace) {
      return '/';
    }

    const relativePath =
      targetPath === workspace.normalizedPath ? '' : targetPath.slice(workspace.normalizedPath.length + 1);
    const nextParams = new URLSearchParams();
    if (relativePath) {
      nextParams.set('path', relativePath);
    }
    copySanitizedSource(params, nextParams);
    nextParams.set('_dl', String(Date.now()));
    return `/workspace/${workspace.id}${nextParams.toString() ? `?${nextParams.toString()}` : ''}`;
  }

  if (segments[0] === 'oauth-callback') {
    const params = new URLSearchParams(query);
    const nextParams = new URLSearchParams();
    for (const key of ['code', 'state', 'service', 'error', 'error_description', 'realmId']) {
      const value = params.get(key);
      if (value) nextParams.set(key, value);
    }
    nextParams.set('_dl', String(Date.now()));
    return `/oauth-callback?${nextParams.toString()}`;
  }

  if (segments[0] === 'settings') {
    // scratch://settings[/billing|user] → /settings/<sub>. Used by the UserMenu deep link and, critically, by the
    // Stripe billing return flow (the web bounce page redirects to scratch://settings/billing). Application is
    // hidden for now, so it's not an allowed target and the bare/unknown case falls back to billing.
    const allowedSubSections = new Set(['user', 'billing']);
    const requestedSubSection = segments[1];
    const subSection =
      requestedSubSection && allowedSubSections.has(requestedSubSection) ? requestedSubSection : 'billing';
    const params = new URLSearchParams(query);
    const nextParams = new URLSearchParams();
    const status = params.get('status');
    if (status === 'success' || status === 'cancel') {
      nextParams.set('status', status);
    }
    nextParams.set('_dl', String(Date.now()));
    return `/settings/${subSection}?${nextParams.toString()}`;
  }

  const workbookRoute = mapWebWorkbookPathToDesktopRoute(route);
  if (workbookRoute === '/') {
    return workbookRoute;
  }
  const params = new URLSearchParams(query);
  const source = sanitizeDeepLinkSource(params.get('source'));
  if (source) {
    params.set('source', source);
  } else {
    params.delete('source');
  }
  params.set('_dl', String(Date.now()));
  const nextQuery = params.toString();
  return appendDeepLinkNonce(nextQuery ? `${workbookRoute}?${nextQuery}` : workbookRoute);
}
