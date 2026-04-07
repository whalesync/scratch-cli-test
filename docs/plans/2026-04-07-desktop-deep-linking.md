# Desktop Deep Linking — Custom Protocol Handler

## Context

Apps like Slack, Linear, and VS Code allow users to click links on the web that open directly in their installed desktop application. This is achieved through custom URI protocol schemes (e.g., `slack://`, `linear://`, `vscode://`).

Scratch should support a `scratch://` protocol so that links in the web app, emails, or shared URLs can open directly in the Scratch Desktop app. If the app is not installed, the web experience should handle it gracefully.

### Current State

- **scratch-desktop**: Electron 35 app using `electron-vite`, React 19, react-router-dom v7 with `HashRouter`. No protocol handler registration exists. App ID is `md.scratch.desktop`.
- **client (web)**: Next.js App Router. Routes are centralized in `client/src/utils/route-urls.ts`. No `scratch://` links are generated anywhere today.
- The desktop app uses device-code OAuth for authentication (browser-based flow, polls for token). Auth tokens are stored in `electron-store` (encrypted).

### Goals

1. Clicking a `scratch://` link opens the desktop app and navigates to the correct view.
2. The web app offers "Open in Desktop" affordances on key pages.
3. If the desktop app is not installed, the user stays on the web with no broken experience.

---

## 2. URL Scheme Design

### Protocol

```
scratch://<route>
```

### Supported Routes

Map directly to existing web app routes and desktop app routes:

| Deep Link URL | Desktop Action | Web Equivalent |
|---|---|---|
| `scratch://workbook/{id}` | Open workspace home | `/workbook/{id}` |
| `scratch://workbook/{id}/files` | Open files view | `/workbook/{id}/files` |
| `scratch://workbook/{id}/files/{path}` | Open specific file | `/workbook/{id}/files/{path}` |
| `scratch://workbook/{id}/connections` | Open connections | `/workbook/{id}/connections` |
| `scratch://workbook/{id}/syncs` | Open syncs | `/workbook/{id}/syncs` |
| `scratch://workbook/{id}/syncs/{syncId}` | Open specific sync | `/workbook/{id}/syncs/{syncId}` |
| `scratch://workbook/{id}/runs` | Open runs | `/workbook/{id}/runs` |

The path after `scratch://` mirrors the web URL path structure for simplicity. Query parameters are passed through (e.g., `scratch://workbook/{id}/runs?status=completed`).

---

## 3. Electron Main Process Changes

**File**: `scratch-desktop/src/main/index.ts`

### 3.1 Register the Protocol

Register `scratch` as the default protocol on app startup:

```typescript
// Early in the main process, before app.whenReady()
const PROTOCOL = 'scratch';

if (process.defaultApp) {
  // In development, register with the path to electron
  if (process.argv.length >= 2) {
    app.setAsDefaultProtocolClient(PROTOCOL, process.execPath, [path.resolve(process.argv[1])]);
  }
} else {
  app.setAsDefaultProtocolClient(PROTOCOL);
}
```

### 3.2 Handle Incoming URLs

**macOS** uses the `open-url` event. **Windows/Linux** pass the URL as a command-line argument to a second instance.

```typescript
// macOS: handle open-url event
app.on('open-url', (event, url) => {
  event.preventDefault();
  handleDeepLink(url);
});

// Windows/Linux: handle second-instance event
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    // The deep link URL is the last argument
    const url = argv.find((arg) => arg.startsWith(`${PROTOCOL}://`));
    if (url) {
      handleDeepLink(url);
    }
    // Focus the existing window
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}
```

### 3.3 Parse and Route the Deep Link

```typescript
function handleDeepLink(url: string): void {
  // Parse: scratch://workbook/abc-123/files/path/to/file
  const parsed = new URL(url);
  const route = parsed.hostname + parsed.pathname; // "workbook/abc-123/files/path/to/file"

  if (mainWindow) {
    // Send to renderer via IPC
    mainWindow.webContents.send('deep-link', route, parsed.search);
  } else {
    // Store for when the window is ready
    pendingDeepLink = { route, query: parsed.search };
  }
}
```

### 3.4 Handle Cold Start

If the app is not running when the user clicks a `scratch://` link, the URL arrives differently:

- **macOS**: via `open-url` event (fires before or after `ready`)
- **Windows/Linux**: via `process.argv`

```typescript
// Check process.argv on startup (Windows/Linux)
app.whenReady().then(() => {
  const deepLinkArg = process.argv.find((arg) => arg.startsWith(`${PROTOCOL}://`));
  if (deepLinkArg) {
    handleDeepLink(deepLinkArg);
  }
});
```

For macOS, buffer the `open-url` event if it fires before the window is created, then replay it after window creation.

---

## 4. Electron Preload & Renderer Changes

### 4.1 Preload API

**File**: `scratch-desktop/src/preload/index.ts`

Expose a listener for deep link events:

```typescript
contextBridge.exposeInMainWorld('scratchDeepLink', {
  onDeepLink: (callback: (route: string, query: string) => void) => {
    ipcRenderer.on('deep-link', (_event, route, query) => callback(route, query));
  },
});
```

### 4.2 Type Definitions

**File**: `scratch-desktop/src/preload/index.d.ts`

```typescript
interface Window {
  scratchDeepLink: {
    onDeepLink: (callback: (route: string, query: string) => void) => void;
  };
}
```

### 4.3 Renderer Deep Link Handler

**File**: New file `scratch-desktop/src/renderer/src/hooks/useDeepLink.ts`

```typescript
import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';

export function useDeepLink(): void {
  const navigate = useNavigate();

  useEffect(() => {
    window.scratchDeepLink.onDeepLink((route, query) => {
      // Map web routes to desktop routes
      // e.g., "workbook/abc-123/files" -> "/workspace/abc-123" (desktop equivalent)
      const desktopRoute = mapToDesktopRoute(route);
      navigate(desktopRoute + query);
    });
  }, [navigate]);
}
```

Note: The desktop app currently has limited routes (`/workspace/:id` and `/workspace/:id/debug`). Deep links to views that don't exist in the desktop app yet (like `/connections` or `/syncs`) should either:
- Navigate to the workspace root as a fallback
- Or open the web URL in the user's browser

---

## 5. Electron Builder Configuration

**File**: `scratch-desktop/electron-builder.yml`

### 5.1 macOS Protocol Registration

```yaml
mac:
  target:
    - dmg
    - zip
  protocols:
    - name: Scratch
      schemes:
        - scratch
```

This adds the `CFBundleURLTypes` entry to `Info.plist` during packaging.

### 5.2 Windows Protocol Registration (future)

When Windows support is added:

```yaml
win:
  target:
    - nsis
  protocols:
    - name: Scratch
      schemes:
        - scratch
```

### 5.3 Linux Protocol Registration

For Linux, the `.desktop` file needs a `MimeType` entry:

```yaml
linux:
  target:
    - AppImage
    - deb
  mimeTypes:
    - x-scheme-handler/scratch
```

---

## 6. Web App Changes

### 6.1 "Open in Desktop" Button Component

**File**: New file `client/src/app/components/open-in-desktop-button.tsx`

A reusable component that attempts to open the current page in the desktop app:

```tsx
'use client';

function OpenInDesktopButton({ workbookId, path }: { workbookId: string; path?: string }) {
  const deepLink = `scratch://workbook/${workbookId}${path ? `/${path}` : ''}`;

  const handleClick = () => {
    // Attempt to open the deep link
    window.location.href = deepLink;
  };

  return <Button onClick={handleClick} variant="subtle">Open in Desktop</Button>;
}
```

### 6.2 Route URL Helpers

**File**: `client/src/utils/route-urls.ts`

Add deep link URL generators alongside existing web URL generators:

```typescript
// Deep link URLs
static desktopDeepLink = (webPath: string) => `scratch://${webPath.replace(/^\//, '')}`;
static workbookDesktopUrl = (id: string) => `scratch://workbook/${id}`;
static workbookFilesDesktopUrl = (id: string) => `scratch://workbook/${id}/files`;
```

### 6.3 Placement

Add "Open in Desktop" affordances on:
- Workbook files page (primary use case — users want local file access)
- Workbook header/toolbar (persistent access)

Gate behind feature flag initially (e.g., `SHOW_OPEN_IN_DESKTOP`).

---

## 7. Graceful Fallback When App Is Not Installed

The simplest reliable approach: use a **redirect page** with timeout detection.

**File**: New route `client/src/app/open/[...path]/page.tsx`

This page serves as a universal "open in desktop" intermediary:

1. On load, attempt to open the `scratch://` deep link.
2. Start a short timeout (~2 seconds).
3. If the page is still visible after the timeout, the app likely isn't installed. Show a message with:
   - A download link for the desktop app
   - A "Continue in browser" link to the equivalent web route

```
https://app.scratch.md/open/workbook/abc-123/files
  -> tries scratch://workbook/abc-123/files
  -> falls back to /workbook/abc-123/files if app not installed
```

This intermediary URL is what you'd share in emails, notifications, etc.

---

## 8. Implementation Phases

### Phase 1: Protocol Registration & Basic Handling
1. Register `scratch` protocol in Electron main process (`index.ts`)
2. Add single-instance lock with deep link forwarding
3. Handle `open-url` (macOS) and `second-instance` (Windows/Linux) events
4. Add cold-start URL handling (buffered `open-url` + `process.argv` check)
5. Update `electron-builder.yml` with protocol config for macOS and Linux
6. Add preload API for deep link events
7. Add `useDeepLink` hook in renderer to navigate on incoming links

**Testing**: Build the app, install it, click `scratch://workbook/test` in a browser. Verify the app opens and navigates.

### Phase 2: Web App Integration
1. Add `desktopDeepLink` helpers to `RouteUrls`
2. Create `OpenInDesktopButton` component
3. Add button to workbook pages behind feature flag
4. Create `/open/[...path]` redirect page with fallback

### Phase 3: Polish
1. Add analytics tracking for deep link opens (PostHog)
2. Handle edge cases: app open but user not logged in (show login, then navigate after auth)
3. Handle unsupported routes gracefully (open web URL in browser as fallback)
4. Add "Always open in Desktop" preference (stored in localStorage, auto-redirects)

---

## 9. Key Considerations

### Authentication
When a deep link arrives and the user is not logged in to the desktop app, the app should:
1. Store the intended destination
2. Run the normal device-code auth flow
3. Navigate to the stored destination after auth completes

### Route Mapping
The desktop app currently only supports `/workspace/:id` and `/workspace/:id/debug`. Until more views are added, deep links to unsupported views should navigate to the workspace root. Track this mapping in a single place so it's easy to extend.

### Security
- Validate and sanitize all incoming deep link URLs before navigation
- Only handle the `scratch://` scheme — ignore unexpected schemes
- Don't pass sensitive data (tokens, secrets) in deep link URLs
- Rate-limit or debounce rapid deep link events to prevent abuse

### Platform Differences
| | macOS | Windows | Linux |
|---|---|---|---|
| Protocol delivery | `open-url` event | `second-instance` argv | `second-instance` argv |
| Registration | `setAsDefaultProtocolClient` + builder `protocols` | `setAsDefaultProtocolClient` + registry | `setAsDefaultProtocolClient` + `.desktop` `MimeType` |
| Cold start URL | Buffered `open-url` | `process.argv` | `process.argv` |

### Testing Plan
- **Unit**: Test URL parsing function with various `scratch://` URLs
- **Integration**: Test IPC flow from main process to renderer navigation
- **Manual**: Test on macOS (primary target) — click links in browser, email, Slack
- **Edge cases**: App not running, app running but minimized, app running with no auth, malformed URLs
