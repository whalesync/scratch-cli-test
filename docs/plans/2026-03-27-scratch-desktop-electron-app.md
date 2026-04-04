# Scratch Desktop — Electron Application Plan

## Context

Scratch Desktop is a new Electron-based desktop application that serves as an alternative client to the Scratch system. It combines the web client's UI experience with the Scratch CLI (Rust rewrite, at `experimental/scratch-cli-2`) for local file operations. The app communicates with the Scratch server for authentication, workspace management, and connection operations. Builds target macOS and Linux only.

> **Terminology note**: The server API and database use "workbook" internally, but the desktop app UI uses "workspace" as the user-facing term.

This module lives at `/scratch-desktop` in the monorepo and does not integrate with Turborepo initially.

---

## 1. Project Setup with electron-vite

### 1.1 Scaffold the Project

Use `electron-vite` to create the initial project structure with the React TypeScript template:

```bash
cd /path/to/spinner
npm create @quick-start/electron@latest scratch-desktop -- --template react-ts
```

After scaffolding, switch to Yarn for consistency with the monorepo:

```bash
cd scratch-desktop
rm package-lock.json  # remove npm lockfile
yarn install
```

### 1.2 Project Structure

```
scratch-desktop/
├── electron.vite.config.ts          # Vite config for main, preload, renderer
├── electron-builder.yml             # electron-builder distribution config
├── package.json
├── tsconfig.json                    # Root TS config
├── tsconfig.node.json               # Main + preload TS config
├── tsconfig.web.json                # Renderer TS config
├── src/
│   ├── main/                        # Electron main process
│   │   ├── index.ts                 # App lifecycle, window creation
│   │   └── cli.ts                   # Scratch CLI integration (spawn/manage)
│   ├── preload/                     # Preload scripts (bridge main ↔ renderer)
│   │   ├── index.ts                 # Expose APIs via contextBridge
│   │   └── index.d.ts              # Type declarations for exposed APIs
│   └── renderer/                    # React application (UI)
│       ├── index.html               # HTML entry point
│       ├── src/
│       │   ├── main.tsx             # React root mount
│       │   ├── App.tsx              # Root component with providers
│       │   ├── providers/
│       │   │   ├── ClerkProvider.tsx     # Clerk auth provider
│       │   │   └── MantineProvider.tsx   # Mantine theme provider
│       │   ├── theme/
│       │   │   ├── theme.ts             # Mantine theme (copied from client)
│       │   │   ├── custom-colors.ts     # Color palettes (copied from client)
│       │   │   ├── theme.module.css     # Theme CSS modules (copied from client)
│       │   │   └── globals.css          # Global CSS variables (copied from client)
│       │   ├── pages/
│       │   │   ├── SignInPage.tsx        # Clerk sign-in
│       │   │   ├── HomePage.tsx         # Workspace selector
│       │   │   └── WorkspacePage.tsx    # Mock workspace view
│       │   ├── components/
│       │   │   ├── WorkspaceCard.tsx    # Workspace list item
│       │   │   └── Layout.tsx          # App shell / layout wrapper
│       │   ├── hooks/
│       │   │   ├── useAuth.ts           # Clerk auth hook
│       │   │   └── useWorkspaces.ts     # Fetch workspaces from server
│       │   ├── lib/
│       │   │   └── api.ts               # HTTP client for Scratch server
│       │   └── types/
│       │       └── workspace.ts         # Workspace type definitions
│       └── assets/                  # Static assets (icons, images)
├── resources/                       # electron-builder resources
│   ├── icon.icns                    # macOS app icon
│   ├── icon.png                     # Linux app icon
│   └── bin/                         # Platform-specific CLI binaries (Rust)
│       ├── darwin-arm64/scratchmd
│       ├── darwin-x64/scratchmd
│       └── linux-x64/scratchmd
├── build/
│   ├── entitlements.mac.plist       # macOS sandbox entitlements
│   └── notarize.js                  # macOS notarization script
└── out/                             # Build output (gitignored)
```

### 1.3 electron.vite.config.ts

```ts
import { resolve } from "path";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
  },
  renderer: {
    resolve: {
      alias: {
        "@": resolve("src/renderer/src"),
      },
    },
    plugins: [react()],
    css: {
      modules: {
        localsConvention: "camelCaseOnly",
      },
    },
  },
});
```

### 1.4 package.json Key Fields

```jsonc
{
  "name": "scratch-desktop",
  "version": "0.1.0",
  "main": "./out/main/index.js",
  "scripts": {
    "dev": "electron-vite dev",
    "build": "electron-vite build",
    "preview": "electron-vite preview",
    "postinstall": "electron-builder install-app-deps",
    "build:mac": "electron-vite build && electron-builder --mac",
    "build:linux": "electron-vite build && electron-builder --linux",
  },
}
```

### 1.5 Key Dependencies

```jsonc
{
  "dependencies": {
    // Mantine (match client versions)
    "@mantine/core": "^8.3.5",
    "@mantine/hooks": "^8.3.5",
    "@mantine/notifications": "^8.3.5",
    // Clerk
    "@clerk/clerk-react": "^5.0.0", // standalone React SDK, not @clerk/nextjs
    // Routing
    "react-router-dom": "^7.0.0",
    // HTTP
    "axios": "^1.7.0",
    // YAML (for writing CLI credentials)
    "js-yaml": "^4.1.0",
    // Fonts
    "@fontsource/inter": "^5.0.0",
    "@fontsource/geist-mono": "^5.0.0",
  },
  "devDependencies": {
    "electron": "^35.0.0",
    "electron-vite": "^3.1.0",
    "electron-builder": "^26.0.0",
    "@vitejs/plugin-react": "^4.0.0",
    "postcss": "^8.0.0",
    "postcss-preset-mantine": "^1.18.0",
    "typescript": "^5.7.0",
  },
}
```

> **Note**: The client uses `@clerk/nextjs` which is Next.js-specific. The desktop app must use `@clerk/clerk-react`, Clerk's framework-agnostic React SDK. The auth flow differs (see Section 2).

---

## 2. Clerk Authentication

### 2.1 Approach

The client uses `@clerk/nextjs` with server-side middleware. Electron has no server-side rendering, so we use `@clerk/clerk-react` directly. Authentication works through Clerk's hosted UI or embedded components rendered in-app.

There are two viable strategies:

**Option A — Embedded Clerk Components (Recommended)**

Render `<SignIn />` and `<SignUp />` components directly in the Electron renderer process. This keeps the auth flow entirely within the app window and matches the client's approach.

**Option B — External Browser OAuth**

Open the system browser for sign-in, then capture the callback via a custom protocol handler (`scratch-desktop://auth/callback`). More complex but avoids loading Clerk UI in the Electron renderer.

### 2.2 Implementation (Option A)

**ClerkProvider setup** (`src/renderer/src/providers/ClerkProvider.tsx`):

```tsx
import { ClerkProvider } from "@clerk/clerk-react";

const CLERK_PUBLISHABLE_KEY = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY;

export function AppClerkProvider({ children }: { children: React.ReactNode }) {
  return (
    <ClerkProvider publishableKey={CLERK_PUBLISHABLE_KEY}>
      {children}
    </ClerkProvider>
  );
}
```

**Sign-in page** (`src/renderer/src/pages/SignInPage.tsx`):

```tsx
import { SignIn } from "@clerk/clerk-react";

export function SignInPage() {
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "center",
        alignItems: "center",
        height: "100vh",
      }}
    >
      <SignIn routing="hash" />
    </div>
  );
}
```

**Auth-gated routing**:

```tsx
import { SignedIn, SignedOut, RedirectToSignIn } from '@clerk/clerk-react';

function App() {
  return (
    <SignedOut>
      <SignInPage />
    </SignedOut>
    <SignedIn>
      <AppRouter />
    </SignedIn>
  );
}
```

**Token forwarding to Scratch server**:

The client registers a token provider on `API_CONFIG` that calls `getToken()` from Clerk. The desktop app should do the same — use Clerk's `useAuth().getToken()` to attach JWTs to all API requests to the Scratch server.

```tsx
import { useAuth } from "@clerk/clerk-react";

// In a provider or hook that configures the API client:
const { getToken } = useAuth();
api.interceptors.request.use(async (config) => {
  const token = await getToken();
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});
```

### 2.3 Post-Authentication: Loading the Scratch User

After Clerk sign-in succeeds, the app must call the Scratch server to create or load the user's Scratch credentials. This mirrors what the web client does via `ClerkAuthContextProvider` and `useScratchPadUser`.

**Flow:**

1. Clerk `<SignIn />` completes -> `useAuth().getToken()` returns a valid JWT
2. App calls `GET /users/current` with `Authorization: Bearer <clerk-jwt>`
3. Server runs `getOrCreateUserFromClerk()` — creates the user if first login, or returns existing
4. Response includes the full `User` entity: `id`, `email`, `name`, `apiToken`, `websocketToken`, `lastWorkbookId`, `settings`, `experimentalFlags`, etc.
5. App stores the user in React state and caches it

**Implementation** (`src/renderer/src/hooks/useScratchUser.ts`):

```tsx
import { useAuth } from "@clerk/clerk-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../lib/api";

interface ScratchUser {
  id: string;
  email?: string;
  name?: string;
  apiToken?: string;
  websocketToken?: string;
  lastWorkbookId?: string;
  isAdmin: boolean;
  settings?: Record<string, string | number | boolean>;
}

const REFRESH_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

export function useScratchUser() {
  const { getToken, isSignedIn } = useAuth();
  const [user, setUser] = useState<ScratchUser | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const intervalRef = useRef<ReturnType<typeof setInterval>>();

  const fetchUser = useCallback(async () => {
    const token = await getToken();
    if (!token) return null;
    const res = await api.get("/users/current", {
      headers: { Authorization: `Bearer ${token}` },
    });
    return res.data as ScratchUser;
  }, [getToken]);

  // Initial load
  useEffect(() => {
    if (!isSignedIn) return;
    fetchUser().then((u) => {
      setUser(u);
      setIsLoading(false);
    });
  }, [isSignedIn, fetchUser]);

  // Periodic refresh
  useEffect(() => {
    if (!isSignedIn) return;
    intervalRef.current = setInterval(async () => {
      const u = await fetchUser();
      if (u) setUser(u);
    }, REFRESH_INTERVAL_MS);
    return () => clearInterval(intervalRef.current);
  }, [isSignedIn, fetchUser]);

  // Refresh on window focus (catches token expiry after sleep/idle)
  useEffect(() => {
    const onFocus = () => {
      if (isSignedIn) fetchUser().then((u) => u && setUser(u));
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [isSignedIn, fetchUser]);

  return { user, isLoading, refetch: fetchUser };
}
```

The user object — including the `apiToken` field — is kept in memory and refreshed every 5 minutes and on window focus. This ensures the app always has a fresh Scratch user context without persisting sensitive data to disk.

### 2.4 API Token for CLI Authentication

The Scratch server can issue `USER`-type API tokens (6-month expiry) via `POST /users/current/api-token`. The desktop app uses this to authenticate the bundled CLI, avoiding the CLI's own device-code OAuth flow entirely.

**Flow:**

1. After loading the Scratch user (Section 2.3), check if `user.apiToken` exists
2. If not, call `POST /users/current/api-token` to generate one
3. Write the token to the CLI's credential file at `~/.scratchmd/credentials.yaml`
4. All subsequent CLI invocations automatically use this token via `Authorization: API-Token <token>`

**Writing CLI credentials from the main process** (`src/main/cli-auth.ts`):

```ts
import { app } from "electron";
import fs from "fs";
import path from "path";
import yaml from "js-yaml";

interface CliCredentials {
  version: "2.0.0";
  environments: Record<
    string,
    { apiToken: string; email: string; expiresAt?: string }
  >;
}

export function writeCliCredentials(
  serverUrl: string,
  apiToken: string,
  email: string,
  expiresAt?: string,
): void {
  const credDir = path.join(app.getPath("home"), ".scratchmd");
  const credPath = path.join(credDir, "credentials.yaml");

  // Parse hostname from server URL for the environment key
  const hostname = new URL(serverUrl).hostname;

  let existing: CliCredentials = { version: "2.0.0", environments: {} };
  if (fs.existsSync(credPath)) {
    const raw = fs.readFileSync(credPath, "utf-8");
    existing = yaml.load(raw) as CliCredentials;
  }

  existing.environments[hostname] = { apiToken, email, expiresAt };

  fs.mkdirSync(credDir, { recursive: true });
  fs.writeFileSync(credPath, yaml.dump(existing), { mode: 0o600 });
}
```

**Triggering from the renderer** via IPC:

```ts
// Preload exposes:
contextBridge.exposeInMainWorld("scratchCli", {
  writeCredentials: (serverUrl: string, apiToken: string, email: string) =>
    ipcRenderer.invoke("cli:write-credentials", serverUrl, apiToken, email),
  // ... other CLI methods
});

// Main process handler:
ipcMain.handle(
  "cli:write-credentials",
  async (_event, serverUrl, apiToken, email) => {
    writeCliCredentials(serverUrl, apiToken, email);
  },
);
```

**Token refresh**: When `useScratchUser` refreshes the user and receives an updated `apiToken`, it should re-write the CLI credentials file. This keeps the CLI token in sync without requiring the user to re-authenticate.

### 2.5 Environment Variables

```env
VITE_CLERK_PUBLISHABLE_KEY=pk_live_...   # or pk_test_... for development
VITE_SCRATCH_API_URL=https://api.scratch.md
```

These go in `scratch-desktop/.env` (gitignored) and are embedded at build time by Vite's `import.meta.env`.

### 2.6 Clerk Appearance Styling

Copy the existing Clerk appearance hook and CSS from the client to maintain visual consistency:

- `client/src/hooks/use-clerk-appearance/useClerkAppearance.ts` -> adapt for `@clerk/clerk-react`
- `client/src/hooks/use-clerk-appearance/Clerk.module.css` -> copy directly

The hook uses `useMantineTheme()` which will work identically since we're using the same Mantine setup.

---

## 3. Mantine UI Integration

### 3.1 Copy Theme Files from Client

Copy these files from `client/src/app/components/theme/` into `scratch-desktop/src/renderer/src/theme/`:

| Source (client)    | Destination (scratch-desktop)             |
| ------------------ | ----------------------------------------- |
| `theme.ts`         | `src/renderer/src/theme/theme.ts`         |
| `custom-colors.ts` | `src/renderer/src/theme/custom-colors.ts` |
| `theme.module.css` | `src/renderer/src/theme/theme.module.css` |

Copy global CSS variables:

| Source (client)       | Destination (scratch-desktop)        |
| --------------------- | ------------------------------------ |
| `src/app/globals.css` | `src/renderer/src/theme/globals.css` |

### 3.2 Adapt Theme for Non-Next.js Environment

The client theme uses `next/font/google` for font loading. Since Electron doesn't use Next.js, replace with `@fontsource` packages:

```tsx
// src/renderer/src/main.tsx
import "@fontsource/inter/400.css";
import "@fontsource/inter/500.css";
import "@fontsource/inter/600.css";
import "@fontsource/inter/700.css";
import "@fontsource/geist-mono/400.css";
```

Update `theme.ts` to reference font families directly instead of CSS variable references from `next/font`:

```ts
fontFamily: 'Inter, -apple-system, BlinkMacSystemFont, sans-serif',
fontFamilyMonospace: 'Geist Mono, ui-monospace, monospace',
```

For the `Funnel Display` heading font, add `@fontsource-variable/funnel-display` or use a system font fallback if this font is not critical for the desktop app.

### 3.3 CSS Imports

In `src/renderer/src/main.tsx`:

```tsx
import "@mantine/core/styles.css";
import "@mantine/notifications/styles.css";
import "./theme/globals.css";
```

### 3.4 MantineProvider Setup

```tsx
// src/renderer/src/providers/MantineProvider.tsx
import { MantineProvider, ColorSchemeScript } from "@mantine/core";
import { Notifications } from "@mantine/notifications";
import { SCRATCHPAD_MANTINE_THEME } from "../theme/theme";

export function AppMantineProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <MantineProvider
      theme={SCRATCHPAD_MANTINE_THEME}
      defaultColorScheme="light"
    >
      <Notifications />
      {children}
    </MantineProvider>
  );
}
```

### 3.5 PostCSS Configuration

Create `scratch-desktop/postcss.config.cjs`:

```js
module.exports = {
  plugins: {
    "postcss-preset-mantine": {},
  },
};
```

---

## 4. Application Pages

### 4.1 Routing

Use `react-router-dom` with hash routing (required for Electron — no server to handle history API fallback):

```tsx
import { HashRouter, Routes, Route } from "react-router-dom";

function AppRouter() {
  return (
    <HashRouter>
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/workspace/:id" element={<WorkspacePage />} />
      </Routes>
    </HashRouter>
  );
}
```

### 4.2 Home Page — Workspace Selector

Displays a list of the user's workspaces fetched from the Scratch server API. Each workspace is a clickable card that navigates to the workspace view.

```
┌─────────────────────────────────────────────┐
│  Scratch Desktop                     [user] │
│─────────────────────────────────────────────│
│                                             │
│  Your Workspaces                            │
│                                             │
│  ┌──────────────┐  ┌──────────────┐        │
│  │ Workspace A  │  │ Workspace B  │        │
│  │ 12 files     │  │ 48 files     │        │
│  │ Updated 2h   │  │ Updated 1d   │        │
│  └──────────────┘  └──────────────┘        │
│                                             │
│  ┌──────────────┐                           │
│  │ Workspace C  │                           │
│  │ 3 files      │                           │
│  │ Updated 5m   │                           │
│  └──────────────┘                           │
│                                             │
└─────────────────────────────────────────────┘
```

**API call**: `GET /api/workbooks` — the same endpoint the web client uses (the API uses "workbooks" internally, but the UI displays "Workspaces"). Use Clerk JWT for auth.

### 4.3 Workspace Page (Mock)

A placeholder view that shows the selected workspace's name and basic metadata. This will be replaced with a full workspace view in a later phase.

```
┌─────────────────────────────────────────────┐
│  ← Back    Workspace A              [user] │
│─────────────────────────────────────────────│
│                                             │
│  Workspace: Workspace A                     │
│  ID: wkb_abc123                             │
│  Created: 2026-03-01                        │
│  Files: 12                                  │
│  Connections: 2                             │
│                                             │
│  [Open in Browser]  [Init Locally]          │
│                                             │
│  ─── File Tree (placeholder) ───            │
│  /                                          │
│  ├── blog-posts/                            │
│  │   ├── post-1.md                          │
│  │   └── post-2.md                          │
│  └── pages/                                 │
│      └── about.md                           │
│                                             │
└─────────────────────────────────────────────┘
```

---

## 5. Scratch CLI (Rust) Integration

### 5.1 Strategy

The `scratchmd` CLI is being rewritten in Rust at `experimental/scratch-cli-2`. It produces a single static binary with no runtime dependencies (uses `rustls` for TLS). It must be bundled into the Electron app distribution so the desktop app can invoke it via `child_process.execFile` from the main process.

The desktop app manages CLI authentication directly — it generates a `USER`-type API token via the Scratch server (see Section 2.4) and writes it to `~/.scratchmd/credentials.yaml`. The CLI's own device-code OAuth flow is not used.

### 5.2 Binary Placement

Platform-specific binaries are stored in `resources/bin/` and excluded from ASAR archiving (binaries cannot be executed from within an ASAR archive):

```
resources/bin/
├── darwin-arm64/scratchmd
├── darwin-x64/scratchmd
└── linux-x64/scratchmd
```

### 5.3 electron-builder Configuration

In `electron-builder.yml`, configure `extraResources` to bundle the correct binary per platform and `asarUnpack` if placing inside the ASAR:

```yaml
extraResources:
  - from: resources/bin/${platform}-${arch}
    to: bin
    filter:
      - "**/*"
```

> `${platform}` and `${arch}` are electron-builder variables that resolve at build time (e.g., `darwin`, `arm64`).

At runtime, the binary is located at:

```ts
import { app } from "electron";
import path from "path";

function getCliPath(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, "bin", "scratchmd");
  }
  // Development: use locally-built binary or one on PATH
  return "scratchmd";
}
```

### 5.4 CLI Invocation from Main Process

Create a module in the main process that wraps CLI commands:

```ts
// src/main/cli.ts
import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

export async function runCli(
  args: string[],
  cwd?: string,
): Promise<{ stdout: string; stderr: string }> {
  const cliPath = getCliPath();
  return execFileAsync(cliPath, args, {
    cwd,
    env: { ...process.env },
    maxBuffer: 10 * 1024 * 1024, // 10MB
  });
}

// Example: list workbooks
export async function listWorkbooks(): Promise<string> {
  const { stdout } = await runCli(["workspaces", "list", "--json"]);
  return stdout;
}
```

### 5.5 Exposing CLI to Renderer via Preload

The renderer (React) cannot directly call Node.js APIs. Expose CLI operations through the preload script using `contextBridge`:

```ts
// src/preload/index.ts
import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("scratchCli", {
  run: (args: string[], cwd?: string) =>
    ipcRenderer.invoke("cli:run", args, cwd),
  initWorkspace: (workbookId: string, outputDir: string) =>
    ipcRenderer.invoke("cli:init-workspace", workbookId, outputDir),
  downloadFiles: (cwd: string) => ipcRenderer.invoke("cli:download-files", cwd),
  uploadFiles: (cwd: string) => ipcRenderer.invoke("cli:upload-files", cwd),
});
```

With corresponding IPC handlers in the main process:

```ts
// src/main/index.ts
import { ipcMain } from "electron";
import { runCli } from "./cli";

ipcMain.handle("cli:run", async (_event, args: string[], cwd?: string) => {
  return runCli(args, cwd);
});

ipcMain.handle(
  "cli:init-workspace",
  async (_event, workbookId: string, outputDir: string) => {
    return runCli(
      ["workspaces", "init", workbookId, "-o", outputDir],
      outputDir,
    );
  },
);
```

### 5.6 Building CLI Binaries for Bundling

Before building the Electron app, the appropriate CLI binary must be built from the Rust source at `experimental/scratch-cli-2`. Add a script to automate this:

```bash
#!/bin/bash
# scripts/build-cli.sh — Build scratchmd (Rust) for the current platform
set -e

PLATFORM=$(uname -s | tr '[:upper:]' '[:lower:]')
ARCH=$(uname -m)

# Normalize arch names for electron-builder directory convention
case "$ARCH" in
  x86_64) ARCH="x64" ; RUST_TARGET="" ;;  # native build, no cross-compile needed
  arm64|aarch64) ARCH="arm64" ; RUST_TARGET="" ;;
esac

case "$PLATFORM" in
  darwin) PLATFORM_DIR="darwin-${ARCH}" ;;
  linux) PLATFORM_DIR="linux-${ARCH}" ;;
  *) echo "Unsupported platform: $PLATFORM"; exit 1 ;;
esac

mkdir -p resources/bin/${PLATFORM_DIR}

echo "Building scratchmd (Rust) for ${PLATFORM_DIR}..."
cd ../experimental/scratch-cli-2
cargo build --release
cp target/release/scratchmd ../../scratch-desktop/resources/bin/${PLATFORM_DIR}/scratchmd
echo "Built scratchmd for ${PLATFORM_DIR}"
```

For cross-compilation (e.g., building Linux binaries on macOS), use Rust cross-compilation targets:

```bash
# Install target (one-time)
rustup target add x86_64-unknown-linux-gnu

# Cross-compile
cargo build --release --target x86_64-unknown-linux-gnu
```

> **Note**: Cross-compiling Rust for Linux from macOS may require a linker toolchain (e.g., via `cross` or `zig cc`). CI runners building on native platforms avoid this complexity.

### 5.7 CLI Authentication

The desktop app manages CLI auth entirely — the CLI's built-in device-code OAuth flow is **not used**. Instead:

1. After Clerk sign-in, the app calls `POST /users/current/api-token` to obtain a `USER`-type API token (6-month expiry)
2. The app writes this token to `~/.scratchmd/credentials.yaml` in the v2 multi-environment format (see Section 2.4)
3. All CLI invocations (`child_process.execFile`) automatically pick up this token via the credential file
4. When the token is refreshed (via `useScratchUser` periodic refresh), the credential file is updated

This means the user signs in once via Clerk and the CLI works immediately — no separate `scratchmd auth login` step.

---

## 6. Build & Distribution

### 6.1 electron-builder.yml

```yaml
appId: com.scratch.desktop
productName: Scratch Desktop
directories:
  buildResources: build
  output: dist

files:
  - "!**/.vscode/*"
  - "!src/*"
  - "!electron.vite.config.*"
  - "!{.eslintignore,.eslintrc.cjs,.prettierignore,.prettierrc.yaml,dev-app-update.yml,CHANGELOG.md,README.md}"
  - "!{tsconfig.json,tsconfig.node.json,tsconfig.web.json}"

asarUnpack:
  - resources/**

extraResources:
  - from: resources/bin/${platform}-${arch}
    to: bin
    filter:
      - "**/*"

mac:
  entitlementsInherit: build/entitlements.mac.plist
  extendInfo:
    - NSDocumentsFolderUsageDescription: Scratch Desktop needs access to manage your workspace files.
  artifactName: "${productName}-${version}-${arch}.${ext}"
  target:
    - target: dmg
      arch:
        - arm64
        - x64
    - target: zip
      arch:
        - arm64
        - x64

linux:
  target:
    - AppImage
    - deb
  maintainer: Whalesync
  category: Office

publish:
  provider: generic
  url: https://releases.scratch.md/desktop # placeholder — configure when ready
```

### 6.2 macOS Entitlements

Create `build/entitlements.mac.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>com.apple.security.cs.allow-jit</key>
  <true/>
  <key>com.apple.security.cs.allow-unsigned-executable-memory</key>
  <true/>
  <key>com.apple.security.cs.allow-dyld-environment-variables</key>
  <true/>
  <key>com.apple.security.network.client</key>
  <true/>
  <key>com.apple.security.files.user-selected.read-write</key>
  <true/>
</dict>
</plist>
```

### 6.3 macOS Notarization (Optional — for Distribution)

Create `build/notarize.js` for notarizing macOS builds:

```js
const { notarize } = require("@electron/notarize");

exports.default = async function notarizing(context) {
  const { electronPlatformName, appOutDir } = context;
  if (electronPlatformName !== "darwin") return;

  const appName = context.packager.appInfo.productFilename;
  await notarize({
    appBundleId: "com.scratch.desktop",
    appPath: `${appOutDir}/${appName}.app`,
    appleId: process.env.APPLE_ID,
    appleIdPassword: process.env.APPLE_ID_PASSWORD,
    teamId: process.env.APPLE_TEAM_ID,
  });
};
```

### 6.4 Local Build Instructions

#### Prerequisites

- Node.js >= 22 (via nvm)
- Yarn 1.x
- Rust toolchain (for building scratch-cli-2: `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh`)

#### Development

```bash
cd scratch-desktop
yarn install

# Build the CLI binary for your platform (one-time or after CLI changes)
./scripts/build-cli.sh

# Start dev mode with hot reload
yarn dev
```

#### Production Build (Current Platform)

```bash
cd scratch-desktop

# Build CLI binary
./scripts/build-cli.sh

# Build Electron app
yarn build

# Package for current platform
yarn build:mac    # macOS .dmg + .zip
yarn build:linux  # Linux AppImage + .deb
```

Output appears in `scratch-desktop/dist/`.

#### Cross-Platform Build

```bash
# macOS (both architectures — builds natively)
yarn build:mac

# Linux (build on a Linux machine or CI runner for best results)
yarn build:linux
```

> **Note**: Building Linux targets from macOS requires Docker or a cross-compilation toolchain. Prefer building on native CI runners per platform.

### 6.5 CI/CD Release Workflow

Create `.github/workflows/release-desktop.yml` (or equivalent for GitLab CI):

```yaml
name: Release Desktop App
on:
  push:
    tags:
      - "desktop-v*.*.*"

jobs:
  build:
    strategy:
      matrix:
        include:
          - os: macos-latest
            platform: mac
          - os: ubuntu-latest
            platform: linux
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: 22

      - uses: dtolnay/rust-toolchain@stable

      - name: Build CLI binary (Rust)
        working-directory: scratch-desktop
        run: bash scripts/build-cli.sh

      - name: Install dependencies
        working-directory: scratch-desktop
        run: yarn install --frozen-lockfile

      - name: Build and package
        working-directory: scratch-desktop
        run: yarn build:${{ matrix.platform }}
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          # macOS signing (only on macos runner)
          APPLE_ID: ${{ secrets.APPLE_ID }}
          APPLE_ID_PASSWORD: ${{ secrets.APPLE_ID_PASSWORD }}
          APPLE_TEAM_ID: ${{ secrets.APPLE_TEAM_ID }}
          CSC_LINK: ${{ secrets.MAC_CERT_P12 }}
          CSC_KEY_PASSWORD: ${{ secrets.MAC_CERT_PASSWORD }}

      - name: Upload artifacts
        uses: actions/upload-artifact@v4
        with:
          name: desktop-${{ matrix.platform }}
          path: scratch-desktop/dist/*
```

---

## 7. Monorepo Integration

### 7.1 Yarn Workspace Registration

Add `scratch-desktop` to the root `package.json` workspaces array:

```jsonc
{
  "workspaces": [
    "client",
    "server",
    "scratch-desktop", // <-- add
    "scratch-cli-tests",
    "packages/*",
    "test-api-fakes/*",
    "smoke-tests",
  ],
}
```

### 7.2 Turborepo — Not Required Initially

The plan explicitly states no Turborepo integration is needed initially. The `scratch-desktop` module will be built independently using its own `yarn dev` / `yarn build` scripts.

When Turborepo integration is desired later, add to `turbo.json`:

```jsonc
{
  // In the pipeline, scratch-desktop tasks would be configured like other packages
  // but this is deferred
}
```

### 7.3 .gitignore

Add to the root `.gitignore` or create `scratch-desktop/.gitignore`:

```
out/
dist/
resources/bin/
*.env
```

`resources/bin/` is gitignored because CLI binaries are built at dev/CI time, not checked in.

---

## 8. Implementation Steps

### Phase 1 — Scaffold & Foundation

1. Scaffold the electron-vite project with React TypeScript template
2. Configure `package.json` with correct dependencies (Mantine, Clerk, react-router-dom, axios)
3. Add to root Yarn workspaces
4. Run `yarn install` from repo root
5. Verify `yarn dev` launches a blank Electron window

### Phase 2 — Mantine Theme

6. Copy theme files from client (`theme.ts`, `custom-colors.ts`, `theme.module.css`, `globals.css`)
7. Install `@fontsource` packages to replace `next/font`
8. Adapt theme.ts font references for non-Next.js environment
9. Set up `MantineProvider` wrapper with the copied theme
10. Configure PostCSS for Mantine
11. Verify Mantine components render correctly in the Electron window

### Phase 3 — Clerk Authentication & Scratch User

12. Install `@clerk/clerk-react`
13. Set up `.env` with `VITE_CLERK_PUBLISHABLE_KEY` and `VITE_SCRATCH_API_URL`
14. Create `ClerkProvider` wrapper
15. Build `SignInPage` with embedded `<SignIn />` component
16. Add auth gating — show sign-in when signed out, app when signed in
17. Copy and adapt Clerk appearance hook from client
18. Set up API client with Clerk JWT injection (axios interceptor)
19. Implement `useScratchUser` hook — call `GET /users/current` after Clerk sign-in
20. Add periodic user refresh (5-minute interval + window focus)
21. Generate API token via `POST /users/current/api-token` and write to `~/.scratchmd/credentials.yaml` for CLI auth

### Phase 4 — Home Page & Workbook View

22. Create `HomePage` with workspace list (fetched from `GET /api/workbooks`, displayed as "Workspaces")
23. Create `WorkspaceCard` component using Mantine components
24. Set up hash-based routing with react-router-dom
25. Create mock `WorkspacePage` with workspace metadata display
26. Wire up navigation between home and workspace pages

### Phase 5 — CLI Integration (Rust)

27. Create `scripts/build-cli.sh` to build Rust `scratchmd` from `experimental/scratch-cli-2` into `resources/bin/`
28. Implement `src/main/cli.ts` with `execFile` wrapper
29. Implement `src/main/cli-auth.ts` to write API token to CLI credentials file
30. Set up preload script with `contextBridge` exposing CLI operations + credential writing
31. Add IPC handlers in main process
32. Test CLI invocation from renderer (e.g., `scratchmd --version`)

### Phase 6 — Build & Distribution

33. Configure `electron-builder.yml` with macOS and Linux targets
34. Create macOS entitlements plist
35. Add `build:mac`, `build:linux` scripts
36. Test local production build on macOS
37. Create CI workflow for automated builds (macOS + Linux runners)
38. Document the full build process in a README

---

## 9. Resolved & Open Questions

### Resolved

1. **Shared types**: Use `@spinner/shared-types` for workbook/connection types.
2. **Auto-update**: Manual downloads initially; auto-update deferred.
3. **CLI auth**: The desktop app generates a `USER`-type API token via `POST /users/current/api-token` and writes it to `~/.scratchmd/credentials.yaml`. No separate CLI login needed.
4. **Code signing**: Apple Developer signing will be available. Windows not needed (no Windows builds).
5. **App icon**: Use the web app's favicon as a placeholder.
6. **Windows**: Not targeting Windows — macOS and Linux only.

### Open

1. **Rust CLI location**: The Rust CLI currently lives at `experimental/scratch-cli-2`. Should it be moved to a top-level directory (e.g., `scratch-cli-rs`) before the desktop app depends on it for builds?
2. **API token expiry handling**: The `USER` token expires after 6 months. Should the desktop app proactively regenerate it before expiry, or handle 401 errors reactively?
3. **Offline mode**: Should the app have any offline capabilities (cached workbook list, local-only CLI operations) or require connectivity at all times?
