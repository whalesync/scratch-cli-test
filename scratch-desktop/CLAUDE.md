# Scratch Desktop — Electron App

## Overview

Scratch Desktop is an Electron-based desktop client for the Scratch system. It combines a React/Mantine renderer with device-code OAuth authentication and integrates the Rust CLI (`scratch-git-2/src/cli/`, the `scratchmd` binary) for local file operations. The app communicates with the Scratch server for auth, workspace management, and connections. It depends on the CLI for most operation logic, especially when downloading and uploading files, triggering pulls and publishing operations.

> **Terminology**: The server API uses "workbook" internally, but the desktop app UI uses "workspace" as the user-facing term.

## Architecture

- **Electron** with `electron-vite` (Vite builds for main, preload, and renderer processes)
- **Renderer**: React 19 + Mantine 8 (theme copied from `/client`)
- **Main process**: Electron lifecycle, window management, secure token storage via `electron-store`, IPC handlers
- **Preload**: contextBridge for main↔renderer IPC (includes `scratchAuth` API for credentials)

## Commands

Run these from the `scratch-desktop/` directory (not the repo root — this package is not in Turborepo):

```bash
yarn dev          # Start dev mode with hot reload
yarn build        # Build all processes (main, preload, renderer)
yarn lint         # Lint all source files
yarn build:mac    # Build + package macOS .dmg/.zip
yarn build:linux  # Build + package Linux AppImage/.deb
```

## App icons

Packaged app icons (Dock, `.app`, installers, window/taskbar where supported) live under `build/icons/`. The canonical brand SVG in the repo is `client/public/logo-color.svg`.

**Generate platform assets** with [electron-icon-builder](https://www.npmjs.com/package/electron-icon-builder) (PNG in, `.icns` / `.ico` / PNG set out):

```bash
cd scratch-desktop
npx electron-icon-builder --input=./icon-1024.png --output=./build/icons
```

This writes `build/icons/mac/icon.icns`, `build/icons/win/icon.ico`, and `build/icons/png/` (multiple sizes).

## Environment Variables

Copy `.env.example` to `.env` and configure:

```
VITE_SCRATCH_API_URL=http://localhost:3010  # Scratch server URL
VITE_SCRATCH_WEB_URL=http://localhost:3000  # Scratch web client URL (for external browser links)
```

These are embedded at build time via Vite's `import.meta.env`.

## UI Components

Before implementing or modifying any React UI in the renderer, read [`UI_SYSTEM.md`](UI_SYSTEM.md). It defines the standard text, button, icon, and color components that must be used instead of raw Mantine imports or inline styles.

## Code Conventions

- Same code style as the rest of the monorepo: Prettier with single quotes, semicolons, 120-char width, trailing commas
- `kebab-case` filenames, `PascalCase` components/classes
- ESLint with `typescript-eslint` type-checked rules, `react-hooks`, and `react-refresh` plugins
- Do not use `as any` — use proper type assertions (`as string`, etc.)
- Use `console.debug` for development logging, not `console.log`

## Key Differences from the Web Client (`/client`)

- Uses device-code OAuth flow (not Clerk) — auth happens in the system browser
- Uses `react-router-dom` with hash routing (not Next.js App Router)
- Fonts loaded via `@fontsource` packages (not `next/font/google`)
- API client in `src/renderer/src/lib/api.ts` uses `API-Token` header (not Clerk JWT)

## Project Structure

```
src/
├── main/                        # Electron main process
│   ├── index.ts                 # App lifecycle, window creation, IPC handlers
│   └── auth-store.ts            # Secure token storage (electron-store)
├── preload/                     # Preload scripts (bridge main ↔ renderer)
│   ├── index.ts                 # Expose electron + scratchAuth APIs via contextBridge
│   └── index.d.ts               # Type declarations (Window.scratchAuth)
└── renderer/                    # React application
    ├── index.html               # HTML entry point
    └── src/
        ├── main.tsx             # React root mount + CSS/font imports
        ├── App.tsx              # Root component (Mantine → AuthProvider → AuthGate)
        ├── providers/           # AuthProvider (device-code flow), MantineProvider, PostHogProvider
        ├── pages/               # LoginPage, HomePage, WorkspacePage
        ├── lib/                 # API client with API-Token auth
        └── theme/               # Mantine theme (adapted from client)
```

## Auth Flow

1. On startup, main process loads stored credentials from `electron-store`
2. If no valid token → renderer shows `LoginPage` with "Log in with Scratch" button
3. User clicks login → app calls `POST /cli/v1/auth/initiate` to get a user code
4. System browser opens to the verification URL (user logs in via Clerk on the web)
5. App polls `POST /cli/v1/auth/poll` until the user approves
6. API token is stored securely via IPC to main process
7. All subsequent API requests include `Authorization: API-Token <token>` header
8. Token expiry is checked on startup and window focus; expired tokens trigger re-auth

## Enabling Devtools

Tools are always running when you start the app with `yarn dev`

For built executables you can provide an environment variable and launch the app via the command line to enable dev tools:

```bash
OPEN_DEVTOOLS=1 ./dist/mac/Scratch.app/Contents/MacOS/Scratch
```

## Native Context Menus

Always use native Electron context menus — never Mantine `<Menu>` dropdowns — for right-click menus and action menus (kebab/three-dot buttons, "Open in..." buttons, etc.). Use the generic `window.scratchDesktop.showNativeContextMenu(items, onClick)` API exposed via preload, which sends items to the main process `scratch:show-native-context-menu` IPC handler and returns the clicked item id via callback.

## Auto-Update (`electron-updater`)

The app pulls updates from the `desktop` (stable) or `desktop-test` (test) channels on `whalesync/scratch-cli` GitHub releases. The channel is baked in at packaging time via the `UPDATE_CHANNEL` env var read by `electron-builder.yml`'s `publish.channel`.

- **Main**: [src/main/updater.ts](src/main/updater.ts) wires `autoUpdater` and forwards events to the renderer.
- **Renderer**: [src/renderer/src/providers/UpdaterProvider.tsx](src/renderer/src/providers/UpdaterProvider.tsx) shows a persistent "Restart & install" toast when an update finishes downloading.
- **Menu**: Help → Check for Updates… (and the macOS app menu) triggers an ad-hoc check.

Skipped automatically when:

- The build is not packaged (`!app.isPackaged`) — use `dev-app-update.yml` to test locally.
- `process.platform === 'darwin'` — macOS auto-update is gated on Developer ID signing (planned follow-up).
- `SCRATCH_DESKTOP_DISABLE_AUTO_UPDATE=1` is set (use this on QA boxes that need to stay on a specific version).

### Local testing

`dev-app-update.yml` in this directory points at the `desktop-test` channel. To exercise the update flow without notarization:

1. Bump a `*-desktop-test` release to a higher version on GitHub (or pick an existing one).
2. Set `package.json#version` to a value *lower* than that release.
3. Run a packaged build (`yarn build:linux` or `yarn build:mac:local`) and launch it. The updater is gated on `app.isPackaged`, so `yarn dev` won't trigger it — temporarily flip the guard in `updater.ts` if you need to test the IPC surface in dev.

Don't test against real GitHub from CI; the vitest suite in `src/main/__tests__/updater.spec.ts` stubs `autoUpdater` instead.

## Performance (agent guidelines)

When generating or changing `scratch-desktop` code, follow these constraints unless the user explicitly asks otherwise.

- **Main process** — Do not block the Electron main thread with heavy synchronous work (large disk I/O, big JSON parse/transform, crypto batches). Use async APIs, offload to workers/child processes, or move non-window-critical work out of the hot path. Do not add synchronous IPC handlers that run expensive logic.
- **IPC** — Do not use synchronous renderer↔main IPC (`invoke`/`handle` must stay async; never introduce `sendSync` or equivalent). Prefer a single batched or debounced call over many rapid-fire IPC messages. Avoid shipping large objects across IPC when a file path, stream, or incremental result suffices.
- **Preload** — Keep preload thin: expose minimal surfaces via `contextBridge`. Do not import heavy dependency trees or run one-off expensive setup in preload unless required for security; push logic to main (async) or renderer as appropriate.
- **React renderer** — Split or narrow context value updates so high-level providers do not force full-app re-renders on every tick. For long lists or tables, use virtualization (or equivalent) instead of rendering thousands of nodes. Do not put unbounded work in `useEffect` on every render; stabilize dependency arrays and guard expensive paths. Use `React.lazy` / route-level code splitting for heavy pages or features when adding new routes or large dependencies.
- **Assets and network** — Prefer bundled/local static assets for UI. Do not add remote-loaded UI dependencies without a clear need. Avoid loading huge images or fonts eagerly in the root entry when they are only needed on a sub-route.
- **Windows and Electron options** — Do not add extra `BrowserWindow` instances for work that a hidden renderer or main-process job can do. Do not disable hardware acceleration or relaxed security flags as a performance fix without explicit user direction.
- **Lifecycle** — Clean up subscriptions, intervals, and IPC listeners in matching teardown (`useEffect` return, window `closed`, etc.) so new code does not leak handlers across navigations or HMR.
- **Verification** — When changing performance-sensitive paths, note in the response that dev (`yarn dev`) is noisier than production; recommend validating behavior on `yarn build` output when the change targets startup or steady-state jank.
