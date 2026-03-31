# Scratch Desktop — Electron App

## Overview

Scratch Desktop is an Electron-based desktop client for the Scratch system. It combines a React/Mantine renderer with Clerk authentication and will integrate the Rust CLI (`experimental/scratch-cli-2`) for local file operations. The app communicates with the Scratch server for auth, workspace management, and connections. It depends on the CLI for most operation logic, especially when download and uploading files, triggering pulls and publishing operations.

> **Terminology**: The server API uses "workbook" internally, but the desktop app UI uses "workspace" as the user-facing term.

## Architecture

- **Electron** with `electron-vite` (Vite builds for main, preload, and renderer processes)
- **Renderer**: React 19 + Mantine 8 (theme copied from `/client`) + `@clerk/clerk-react`
- **Main process**: Electron lifecycle, window management, CLI invocation (future)
- **Preload**: contextBridge for main↔renderer IPC

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
VITE_CLERK_PUBLISHABLE_KEY=pk_test_...   # Clerk publishable key
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

- Uses `@clerk/clerk-react` (not `@clerk/nextjs`) — no server-side middleware
- Uses `react-router-dom` with hash routing (not Next.js App Router)
- Fonts loaded via `@fontsource` packages (not `next/font/google`)
- No SWR or Zustand yet — will be added as features require them
- API client in `src/renderer/src/lib/api.ts` mirrors the client's `ApiConfig` pattern

## Project Structure

```
src/
├── main/                        # Electron main process
│   └── index.ts                 # App lifecycle, window creation
├── preload/                     # Preload scripts (bridge main ↔ renderer)
│   ├── index.ts                 # Expose APIs via contextBridge
│   └── index.d.ts               # Type declarations
└── renderer/                    # React application
    ├── index.html               # HTML entry point
    └── src/
        ├── main.tsx             # React root mount + CSS/font imports
        ├── App.tsx              # Root component (Clerk → Mantine → auth gate)
        ├── providers/           # ClerkProvider, MantineProvider, AuthProvider
        ├── pages/               # SignInPage, HomePage
        ├── hooks/               # Clerk appearance hook (copied from client)
        ├── lib/                 # API client with Clerk JWT injection
        └── theme/               # Mantine theme (adapted from client)
```

## Auth Flow

1. `AppClerkProvider` loads Clerk session
2. `<SignedOut>` renders `SignInPage` with embedded `<SignIn routing="hash" />`
3. `<SignedIn>` renders `AuthProvider` which registers Clerk's `getToken()` on `API_CONFIG`
4. `AuthProvider` checks session validity every 10s + on window focus
5. All API requests automatically include a fresh Clerk JWT via axios interceptor

## Enabling Devtools

Tools are always running when you start the app with `yarn dev`

For built executables you can provide an environment variable and launch the app via the command line to enable dev tools:

```bash
OPEN_DEVTOOLS=1 ./dist/mac/Scratch.app/Contents/MacOS/Scratch
```
