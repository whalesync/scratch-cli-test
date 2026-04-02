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
```

These are embedded at build time via Vite's `import.meta.env`.

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
