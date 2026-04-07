/**
 * Maps web-style deep link paths (after scratch://) to HashRouter paths in the desktop app.
 * Unsupported views fall back to the workspace root until the desktop app gains parity.
 */
const WORKBOOK_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;

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

  return `/workspace/${workbookId}`;
}
