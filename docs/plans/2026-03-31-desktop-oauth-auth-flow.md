# Desktop App — Replace Clerk with OAuth Device Code Auth

## Context

Clerk does not support Electron and will not function inside a built Electron executable. The desktop app currently relies entirely on `@clerk/clerk-react` for authentication — it renders Clerk's embedded `<SignIn />` component and uses Clerk's `getToken()` to fetch fresh JWTs for every API request.

The server already implements a device-code-style authorization flow for the CLI at `POST /cli/v1/auth/{initiate,poll,verify}`. The desktop app should use this same pattern: open a browser for the user to log in on the web (where Clerk works), then receive an API token to store locally.

### Current Desktop Auth Flow (to be replaced)

1. `AppClerkProvider` loads Clerk session using `VITE_CLERK_PUBLISHABLE_KEY`
2. `<SignedOut>` renders `SignInPage` with embedded `<SignIn routing="hash" />`
3. `<SignedIn>` renders `AuthProvider` which registers `getToken()` on `API_CONFIG`
4. Every API request includes `Authorization: Bearer <clerk-jwt>` via axios interceptor
5. Session validity checked every 10s + on window focus

### Target Desktop Auth Flow

1. App starts, main process checks for stored API token (via `electron-store`)
2. If no valid token → renderer shows login screen with "Log in with Scratch" button
3. Button triggers: call `POST /cli/v1/auth/initiate` → get `userCode` + `pollingCode`
4. Open system browser to verification URL (user logs in via Clerk on the web, enters code)
5. Desktop polls `POST /cli/v1/auth/poll` until approved
6. Receive API token, store it securely via main process IPC
7. All subsequent API requests use `Authorization: API-Token <token>` header
8. On token expiry or logout → clear stored token, return to login screen

---

## 1. Server Changes

The existing CLI auth endpoints are almost entirely reusable. Only minor adjustments are needed.

### 1.1 Generalize the CLI Auth Guard to Accept Desktop

**File:** `server/src/auth/cli.strategy.ts`

The `CliStrategy` currently validates that `User-Agent` starts with `Scratch-cli/`. Update it to also accept `ScratchDesktop/`:

```typescript
// Before: only CLI
if (!userAgent || !userAgent.startsWith("Scratch-cli/")) {
  return done(null, false);
}

// After: CLI or Desktop
if (
  !userAgent ||
  (!userAgent.startsWith("Scratch-cli/") &&
    !userAgent.startsWith("ScratchDesktop/"))
) {
  return done(null, false);
}
```

This allows the desktop app to call `/cli/v1/auth/initiate` and `/cli/v1/auth/poll`.

### 1.2 Add `desktop` Token Scope

**File:** `server/src/cli/cli-auth.service.ts`

When the verify step creates/finds an API token, it currently scopes to `['cli']`. Add support for a `source` hint so the desktop gets `['desktop']` scoped tokens. This could be:

- **Option A (simple):** Add a `source` field to `AuthInitiateResponseDto` stored on the `AuthorizationCode` record. The initiate call includes the source (e.g., `"desktop"` or `"cli"`), and `verifyAuth` uses it when creating the token.
- **Option B (simpler):** Just use the same `['cli']` scope for both. Both are first-party clients using the same auth pattern. Differentiation can be added later if needed.

**Recommendation:** Start with Option B. The scope doesn't gate any functionality today. Rename or generalize later if needed.

- use option B

### 1.3 Server Changes Summary

| File                                    | Change                              | Required |
| --------------------------------------- | ----------------------------------- | -------- |
| `server/src/auth/cli.strategy.ts`       | Accept `ScratchDesktop/` User-Agent | Yes      |
| `server/src/cli/cli-auth.service.ts`    | (No change if using Option B)       | No       |
| `server/src/cli/cli-auth.controller.ts` | (No change)                         | No       |

---

## 2. Desktop Main Process — Secure Token Storage via IPC

The main process manages token persistence. The renderer never directly accesses the file system.

### 2.1 Add `electron-store` Dependency

```bash
cd scratch-desktop && yarn add electron-store
```

`electron-store` provides encrypted JSON storage in the user's app data directory. It's the standard approach for Electron credential storage.

### 2.2 Create Token Store Module

**New file:** `scratch-desktop/src/main/auth-store.ts`

```typescript
import Store from "electron-store";

interface AuthStoreSchema {
  apiToken: string | null;
  email: string | null;
  tokenExpiresAt: string | null; // ISO date string
  serverUrl: string | null;
}

const store = new Store<AuthStoreSchema>({
  name: "auth",
  encryptionKey: "scratch-desktop-auth", // obfuscation, not true encryption
  defaults: {
    apiToken: null,
    email: null,
    tokenExpiresAt: null,
    serverUrl: null,
  },
});

export function getCredentials() {
  return {
    apiToken: store.get("apiToken"),
    email: store.get("email"),
    tokenExpiresAt: store.get("tokenExpiresAt"),
    serverUrl: store.get("serverUrl"),
  };
}

export function saveCredentials(creds: {
  apiToken: string;
  email?: string;
  tokenExpiresAt?: string;
  serverUrl: string;
}) {
  store.set("apiToken", creds.apiToken);
  store.set("email", creds.email ?? null);
  store.set("tokenExpiresAt", creds.tokenExpiresAt ?? null);
  store.set("serverUrl", creds.serverUrl);
}

export function clearCredentials() {
  store.clear();
}

export function isTokenExpired(): boolean {
  const expiresAt = store.get("tokenExpiresAt");
  if (!expiresAt) return false; // No expiry info — assume valid
  return new Date(expiresAt) < new Date();
}
```

### 2.3 Register IPC Handlers in Main Process

**File:** `scratch-desktop/src/main/index.ts`

Add IPC handlers that the renderer can call via the preload bridge:

```typescript
import { ipcMain, shell } from "electron";
import {
  getCredentials,
  saveCredentials,
  clearCredentials,
  isTokenExpired,
} from "./auth-store";

// Auth IPC handlers
ipcMain.handle("auth:get-credentials", () => getCredentials());
ipcMain.handle("auth:save-credentials", (_, creds) => saveCredentials(creds));
ipcMain.handle("auth:clear-credentials", () => clearCredentials());
ipcMain.handle("auth:is-token-expired", () => isTokenExpired());
ipcMain.handle("auth:open-external", (_, url: string) =>
  shell.openExternal(url),
);
```

### 2.4 Expose IPC in Preload Script

**File:** `scratch-desktop/src/preload/index.ts`

Expose typed auth APIs to the renderer:

```typescript
import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("scratchAuth", {
  getCredentials: () => ipcRenderer.invoke("auth:get-credentials"),
  saveCredentials: (creds) =>
    ipcRenderer.invoke("auth:save-credentials", creds),
  clearCredentials: () => ipcRenderer.invoke("auth:clear-credentials"),
  isTokenExpired: () => ipcRenderer.invoke("auth:is-token-expired"),
  openExternal: (url: string) => ipcRenderer.invoke("auth:open-external", url),
});
```

Add corresponding type declarations in `scratch-desktop/src/preload/index.d.ts`.

---

## 3. Desktop Renderer — Auth Flow UI

### 3.1 Remove Clerk Dependencies

Remove these files and dependencies:

| Action     | Target                                                      |
| ---------- | ----------------------------------------------------------- |
| Delete     | `src/renderer/src/providers/ClerkProvider.tsx`              |
| Delete     | `src/renderer/src/pages/SignInPage.tsx`                     |
| Delete     | `src/renderer/src/hooks/use-clerk-appearance/`              |
| Remove dep | `@clerk/clerk-react` from `package.json`                    |
| Remove env | `VITE_CLERK_PUBLISHABLE_KEY` from `.env` and `.env.example` |

### 3.2 Create Auth Context Provider

**Replace:** `src/renderer/src/providers/AuthProvider.tsx`

New `AuthProvider` manages the full device-code auth lifecycle:

```typescript
import {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
} from "react";
import { API_CONFIG } from "../lib/api";

interface AuthState {
  isAuthenticated: boolean;
  isLoading: boolean;
  email: string | null;
  login: () => Promise<void>;
  logout: () => Promise<void>;
  // Device code flow state (while login is in progress)
  authFlow: {
    active: boolean;
    userCode: string | null;
    verificationUrl: string | null;
    error: string | null;
  };
}

const AuthContext = createContext<AuthState>(/* ... */);
export const useAuth = () => useContext(AuthContext);
```

**Login flow inside AuthProvider:**

1. Call `POST /cli/v1/auth/initiate` via the API client (with no auth token)
2. Set `authFlow.active = true`, expose `userCode` and `verificationUrl`
3. Open browser via `window.scratchAuth.openExternal(verificationUrl)`
4. Poll `POST /cli/v1/auth/poll` every 5s
5. On `status === 'approved'`:
   - Save credentials via `window.scratchAuth.saveCredentials(...)`
   - Register static token provider on `API_CONFIG`
   - Set `isAuthenticated = true`
6. On `status === 'expired'` or `'denied'`: show error, allow retry

**On app startup:**

1. Call `window.scratchAuth.getCredentials()`
2. If token exists and not expired → register on `API_CONFIG`, set authenticated
3. If token expired → clear credentials, show login screen

### 3.3 Update API Client for API Token Auth

**File:** `scratch-desktop/src/renderer/src/lib/api.ts`

Change the axios interceptor to use `API-Token` prefix instead of `Bearer`:

```typescript
this.axiosInstance.interceptors.request.use(async (config) => {
  const token = await this.tokenProvider?.();
  if (token) {
    config.headers.Authorization = `API-Token ${token}`;
  }
  return config;
});
```

Also update the `User-Agent` header to include a version:

```typescript
headers: {
  'Content-Type': 'application/json',
  'User-Agent': 'ScratchDesktop/1.0.0',
},
```

Add unauthenticated request support for the initiate/poll endpoints (these don't need a token):

```typescript
public getUnauthenticatedAxiosInstance(): AxiosInstance {
  return axios.create({
    baseURL: this.apiUrl,
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': 'ScratchDesktop/1.0.0',
    },
  });
}
```

### 3.4 Create Login Page

**Replace:** `src/renderer/src/pages/SignInPage.tsx` → `src/renderer/src/pages/LoginPage.tsx`

A simple branded page with:

- **Initial state:** "Log in with Scratch" button + server URL display
- **Flow active state:** Display the `userCode` in a prominent box (similar to CLI's box UI), "Waiting for authorization..." message, and a cancel button
- **Error state:** Error message + "Try again" button

No Clerk components — this is a pure React + Mantine page.

### 3.5 Update App.tsx Root Component

**File:** `scratch-desktop/src/renderer/src/App.tsx`

Replace the Clerk provider tree with the new auth provider:

```typescript
// Before
<AppClerkProvider>
  <AppMantineProvider>
    <SignedOut><SignInPage /></SignedOut>
    <SignedIn>
      <AuthProvider>
        <HashRouter>...</HashRouter>
      </AuthProvider>
    </SignedIn>
  </AppMantineProvider>
</AppClerkProvider>

// After
<AppMantineProvider>
  <AuthProvider>
    <AuthGate>
      <HashRouter>
        <PostHogProvider>
          <Routes>
            <Route element={<Layout />}>
              <Route path="/" element={<HomePage />} />
              <Route path="/workspace/:id" element={<WorkspacePage />} />
            </Route>
          </Routes>
        </PostHogProvider>
      </HashRouter>
    </AuthGate>
  </AuthProvider>
</AppMantineProvider>
```

Where `AuthGate` is a small component:

```typescript
function AuthGate({ children }) {
  const { isAuthenticated, isLoading } = useAuth();
  if (isLoading) return <LoadingScreen />;
  if (!isAuthenticated) return <LoginPage />;
  return children;
}
```

---

## 4. Token Lifecycle & Session Management

### 4.1 Token Refresh Strategy

API tokens issued by the server are valid for 6 months. Unlike Clerk JWTs (which refresh every few seconds), these are long-lived. The desktop app should:

- Check token expiry on app startup
- Check token expiry when the app window regains focus
- If the token is within 7 days of expiry, show a non-blocking banner: "Your session expires soon. Please re-authenticate."
- If expired → clear credentials, return to login screen

### 4.2 Logout Flow

1. User clicks logout in the app
2. Call `window.scratchAuth.clearCredentials()`
3. Clear `API_CONFIG` token provider
4. Reset auth state → login screen displayed

### 4.3 Server-Side Token Revocation (Future)

No server-side revocation endpoint exists today. If needed later, add `POST /cli/v1/auth/revoke` that deletes the `ApiToken` record. Not required for initial implementation.

---

## 5. Implementation Order

### Phase 1: Server (minimal)

1. Update `CliStrategy` to accept `ScratchDesktop/` User-Agent

### Phase 2: Desktop main process

2. Add `electron-store` dependency
3. Create `auth-store.ts` module
4. Register IPC handlers in `main/index.ts`
5. Update preload script with auth bridge

### Phase 3: Desktop renderer

6. Create `AuthProvider` with device-code flow logic
7. Create `LoginPage` component
8. Update `api.ts` — switch to `API-Token` header, add unauthenticated instance
9. Update `App.tsx` — remove Clerk, wire up new auth gate
10. Add token expiry checking and re-auth flow

### Phase 4: Cleanup

11. Remove `@clerk/clerk-react` dependency and all Clerk-related files
12. Remove `VITE_CLERK_PUBLISHABLE_KEY` from env files
13. Update `scratch-desktop/CLAUDE.md` to reflect new auth flow

---

## 6. Files Changed Summary

### Server

| File                              | Action                                       |
| --------------------------------- | -------------------------------------------- |
| `server/src/auth/cli.strategy.ts` | Modify — accept `ScratchDesktop/` User-Agent |

### Desktop — Main Process

| File                                     | Action                         |
| ---------------------------------------- | ------------------------------ |
| `scratch-desktop/package.json`           | Add `electron-store`           |
| `scratch-desktop/src/main/auth-store.ts` | **New** — token storage module |
| `scratch-desktop/src/main/index.ts`      | Modify — register IPC handlers |
| `scratch-desktop/src/preload/index.ts`   | Modify — expose auth bridge    |
| `scratch-desktop/src/preload/index.d.ts` | Modify — add type declarations |

### Desktop — Renderer

| File                                                           | Action                                       |
| -------------------------------------------------------------- | -------------------------------------------- |
| `scratch-desktop/src/renderer/src/providers/AuthProvider.tsx`  | **Rewrite** — device-code auth flow          |
| `scratch-desktop/src/renderer/src/providers/ClerkProvider.tsx` | **Delete**                                   |
| `scratch-desktop/src/renderer/src/pages/SignInPage.tsx`        | **Delete** (replaced by LoginPage)           |
| `scratch-desktop/src/renderer/src/pages/LoginPage.tsx`         | **New** — login UI with device code display  |
| `scratch-desktop/src/renderer/src/lib/api.ts`                  | Modify — `API-Token` header, unauth instance |
| `scratch-desktop/src/renderer/src/App.tsx`                     | Modify — remove Clerk, add auth gate         |
| `scratch-desktop/src/renderer/src/hooks/use-clerk-appearance/` | **Delete**                                   |
| `scratch-desktop/.env.example`                                 | Remove `VITE_CLERK_PUBLISHABLE_KEY`          |

---

## 7. Open Questions

1. **Token storage encryption:** `electron-store` supports an `encryptionKey` but it's obfuscation, not true encryption. For stronger security, consider `keytar` (OS keychain integration) or `safeStorage` (Electron's built-in encryption). Is obfuscation sufficient for now?

- yes use obfuscation for now.

2. **Existing user sessions:** Users currently authenticated via Clerk will need to re-authenticate after this change. Is a migration period needed, or is a clean cut acceptable?

- clean cut is acceptable

3. **PostHog user identification:** Currently PostHog may rely on Clerk's user ID. After switching, ensure PostHog identifies users via the API response (e.g., from `GET /users/current` after token auth).

- the PostHog should use the userId from the User object after token auth, not the Clerk's user ID
