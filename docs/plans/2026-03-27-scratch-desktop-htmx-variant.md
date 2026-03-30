# Scratch Desktop — HTMX + Express Variant

## Context

This is an alternative architecture for the Scratch Desktop Electron app. Instead of a React/Mantine renderer process, the Electron app runs a **local Express server (TypeScript)** that serves **server-rendered HTML with HTMX** for interactivity. The BrowserWindow simply points at `http://localhost:<port>`.

This architecture eliminates the React/Vite/Mantine build pipeline and the main↔renderer IPC bridge. The Express server has direct access to Node.js APIs (filesystem, child_process) and serves HTML templates that use HTMX for partial page updates.

> **Terminology note**: The server API and database use "workbook" internally, but the desktop app UI uses "workspace" as the user-facing term.

This module lives at `/scratch-desktop` in the monorepo and does not integrate with Turborepo initially.

### Why This Architecture

| Concern | React + electron-vite (original plan) | Express + HTMX (this plan) |
|---------|---------------------------------------|----------------------------|
| Build pipeline | Vite for main, preload, renderer | `tsc` only — no bundler needed |
| IPC complexity | contextBridge + ipcMain/ipcRenderer for every operation | None — Express handler calls Node APIs directly |
| State management | Zustand + SWR + React Context | Server-side session state — no client-side stores |
| UI interactivity | Full React component tree | HTMX attributes on HTML elements |
| Auth integration | @clerk/clerk-react in renderer | @clerk/express middleware on server + ClerkJS in browser |
| Bundle size overhead | React + Mantine + SWR + react-router | HTMX (~14KB) + minimal CSS |
| Dev iteration | Hot module reload via Vite | Nodemon restart + browser refresh (or livereload) |

### Trade-offs

- **Simpler plumbing**: No IPC bridge, no preload script, no contextBridge. The Express server can call `execFile`, read the filesystem, and manage state directly.
- **Less rich UI**: HTMX can handle most interactions (navigation, forms, live search, modals) but complex drag-and-drop or real-time editors would require sprinkling in vanilla JS or Alpine.js.
- **Familiar model**: Server-rendered HTML is well-understood. Debugging is straightforward — view source, inspect network tab, check server logs.
- **No component library**: We lose Mantine. CSS must be written manually or use a utility framework like Tailwind or a classless CSS library (Pico, Simple.css). This means the desktop app will look different from the web client.

---

## 1. Project Setup

### 1.1 Project Structure

```
scratch-desktop/
├── package.json
├── tsconfig.json
├── nodemon.json                      # Dev server auto-restart config
├── .env                              # Environment variables (gitignored)
├── src/
│   ├── main.ts                       # Electron main process — starts Express, opens BrowserWindow
│   ├── server/
│   │   ├── app.ts                    # Express app setup (middleware, routes, error handling)
│   │   ├── auth.ts                   # Clerk middleware + session management
│   │   ├── routes/
│   │   │   ├── index.ts              # Route registration
│   │   │   ├── auth.routes.ts        # GET /sign-in, POST /sign-out, GET /auth/callback
│   │   │   ├── home.routes.ts        # GET / — workspace list
│   │   │   ├── workspace.routes.ts   # GET /workspace/:id, file tree, file viewer
│   │   │   └── api.routes.ts         # Internal JSON endpoints for HTMX (if needed)
│   │   ├── services/
│   │   │   ├── scratch-api.ts        # HTTP client for Scratch server API
│   │   │   ├── cli.ts                # Rust CLI invocation (child_process.execFile)
│   │   │   ├── cli-auth.ts           # Write CLI credentials to ~/.scratchmd/credentials.yaml
│   │   │   └── filesystem.ts         # Local workspace file operations
│   │   ├── views/
│   │   │   ├── layouts/
│   │   │   │   └── main.ejs          # Base HTML layout (head, nav, HTMX script)
│   │   │   ├── partials/
│   │   │   │   ├── nav.ejs           # Top navigation bar
│   │   │   │   ├── workspace-card.ejs
│   │   │   │   ├── file-tree.ejs
│   │   │   │   ├── file-viewer.ejs
│   │   │   │   └── toast.ejs         # Notification partial
│   │   │   ├── sign-in.ejs           # Clerk sign-in page
│   │   │   ├── home.ejs              # Workspace list
│   │   │   └── workspace.ejs         # Workspace detail view
│   │   └── public/
│   │       ├── css/
│   │       │   └── styles.css        # Application styles
│   │       ├── js/
│   │       │   └── app.js            # Minimal client-side JS (Clerk init, etc.)
│   │       └── icons/                # App icons and static assets
│   └── preload.ts                    # Minimal preload (only if needed for Electron APIs)
├── resources/
│   ├── icon.icns                     # macOS app icon
│   ├── icon.png                      # Linux app icon
│   └── bin/                          # Platform-specific CLI binaries (Rust)
│       ├── darwin-arm64/scratchmd
│       ├── darwin-x64/scratchmd
│       └── linux-x64/scratchmd
├── build/
│   ├── entitlements.mac.plist        # macOS sandbox entitlements
│   └── notarize.js                   # macOS notarization script
├── electron-builder.yml              # electron-builder distribution config
└── out/                              # Build output (gitignored)
```

### 1.2 package.json

```jsonc
{
  "name": "scratch-desktop",
  "version": "0.1.0",
  "main": "out/main.js",
  "scripts": {
    "dev": "concurrently \"tsc --watch\" \"nodemon --watch out --exec electron .\"",
    "build": "tsc",
    "start": "electron .",
    "build:mac": "tsc && electron-builder --mac",
    "build:linux": "tsc && electron-builder --linux"
  },
  "dependencies": {
    // Express + templating
    "express": "^5.1.0",
    "ejs": "^3.1.10",

    // HTMX (served as static asset, but npm for version pinning)
    "htmx.org": "^2.0.0",

    // Clerk
    "@clerk/express": "^1.0.0",      // Express middleware for token verification
    "@clerk/backend": "^1.0.0",      // Clerk backend SDK

    // HTTP client (for Scratch server API calls)
    "axios": "^1.7.0",

    // YAML (for writing CLI credentials)
    "js-yaml": "^4.1.0",

    // Utilities
    "dotenv": "^16.4.0",
    "portfinder": "^1.0.32"          // Find available port at startup
  },
  "devDependencies": {
    "electron": "^35.0.0",
    "electron-builder": "^26.0.0",
    "typescript": "^5.7.0",
    "concurrently": "^9.0.0",
    "nodemon": "^3.1.0",
    "@types/express": "^5.0.0",
    "@types/ejs": "^3.1.5",
    "@types/js-yaml": "^4.0.9"
  }
}
```

### 1.3 tsconfig.json

```jsonc
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "commonjs",
    "moduleResolution": "node",
    "outDir": "out",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "resolveJsonModule": true,
    "declaration": false,
    "sourceMap": true,
    "skipLibCheck": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "out", "dist"]
}
```

### 1.4 nodemon.json

```jsonc
{
  "watch": ["out"],
  "ext": "js",
  "ignore": ["out/server/public/*"],
  "delay": 500
}
```

> **Note on views**: EJS templates in `src/server/views/` are not compiled by TypeScript. They must be copied to `out/server/views/` at build time. Add a `postbuild` script or use a simple copy step: `"build": "tsc && cp -r src/server/views out/server/views && cp -r src/server/public out/server/public"`.

---

## 2. Electron Main Process

### 2.1 Application Lifecycle

The main process does three things:

1. Starts the Express server on an available local port
2. Opens a BrowserWindow pointing at `http://127.0.0.1:<port>`
3. Manages the application lifecycle (quit on window close, etc.)

```ts
// src/main.ts
import { app, BrowserWindow } from 'electron';
import { createServer } from './server/app';
import portfinder from 'portfinder';

let mainWindow: BrowserWindow | null = null;

async function bootstrap() {
  // Find an available port to avoid conflicts
  const port = await portfinder.getPortPromise({ port: 19400 });

  // Start Express server
  const server = createServer();
  server.listen(port, '127.0.0.1', () => {
    console.log(`Scratch Desktop server running on http://127.0.0.1:${port}`);
  });

  // Create the browser window
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    title: 'Scratch Desktop',
    webPreferences: {
      // No preload needed — the Express server handles everything
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  mainWindow.loadURL(`http://127.0.0.1:${port}`);

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(bootstrap);

app.on('window-all-closed', () => {
  app.quit();
});
```

### 2.2 Security: Binding to 127.0.0.1

The Express server binds to `127.0.0.1` (not `0.0.0.0`) so it is only accessible from the local machine. Additionally, the server should validate a shared secret on every request to prevent other local processes from accessing it:

```ts
// Generate a random secret at startup
const SESSION_SECRET = crypto.randomBytes(32).toString('hex');

// Pass it to the Express app
const server = createServer({ sessionSecret: SESSION_SECRET });

// BrowserWindow loads the URL with the secret as a cookie or query param (first request only)
mainWindow.loadURL(`http://127.0.0.1:${port}?_init=${SESSION_SECRET}`);
```

The Express app sets the secret as an HTTP-only cookie on the first request and validates it on all subsequent requests. This prevents other local applications from calling the server.

---

## 3. Express Server

### 3.1 App Setup

```ts
// src/server/app.ts
import express from 'express';
import path from 'path';
import cookieParser from 'cookie-parser';
import { authMiddleware } from './auth';
import { registerRoutes } from './routes';

interface ServerOptions {
  sessionSecret: string;
  scratchApiUrl: string;
  clerkPublishableKey: string;
  clerkSecretKey: string;
}

export function createServer(options: ServerOptions): express.Express {
  const app = express();

  // Middleware
  app.use(express.urlencoded({ extended: true }));
  app.use(express.json());
  app.use(cookieParser());

  // Static assets (CSS, JS, icons)
  app.use('/static', express.static(path.join(__dirname, 'public')));

  // Serve HTMX from node_modules
  app.use('/static/htmx.min.js', express.static(
    require.resolve('htmx.org/dist/htmx.min.js')
  ));

  // View engine
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, 'views'));

  // Local session secret validation
  app.use(localSessionGuard(options.sessionSecret));

  // Make common data available to all templates
  app.use((req, res, next) => {
    res.locals.clerkPublishableKey = options.clerkPublishableKey;
    next();
  });

  // Auth middleware (Clerk token verification)
  app.use(authMiddleware(options));

  // Routes
  registerRoutes(app);

  return app;
}
```

### 3.2 Local Session Guard

```ts
function localSessionGuard(secret: string) {
  return (req: express.Request, res: express.Response, next: express.NextFunction) => {
    // First request: set the cookie from the init param
    if (req.query._init === secret) {
      res.cookie('_scratch_local', secret, {
        httpOnly: true,
        sameSite: 'strict',
      });
      // Redirect to strip the query param
      const url = new URL(req.originalUrl, `http://${req.headers.host}`);
      url.searchParams.delete('_init');
      return res.redirect(url.pathname + url.search);
    }

    // All subsequent requests: validate the cookie
    if (req.cookies._scratch_local !== secret) {
      return res.status(403).send('Forbidden');
    }

    next();
  };
}
```

---

## 4. Clerk Authentication

### 4.1 Approach

In the HTMX model, authentication is split between two layers:

1. **Browser-side**: ClerkJS (loaded via `<script>`) handles the sign-in UI and manages the Clerk session. After sign-in, Clerk's `__session` cookie is set automatically.
2. **Server-side**: `@clerk/express` middleware verifies the Clerk session token on every request and makes the authenticated user available to route handlers.

This is simpler than the original plan's approach because there is no IPC boundary — the Express server verifies tokens directly.

### 4.2 Auth Middleware

```ts
// src/server/auth.ts
import { clerkMiddleware, requireAuth, getAuth } from '@clerk/express';
import { Request, Response, NextFunction } from 'express';
import { ScratchApiClient } from './services/scratch-api';

// Public routes that don't require authentication
const PUBLIC_PATHS = ['/sign-in', '/auth/callback', '/static'];

export function authMiddleware(options: { clerkSecretKey: string; scratchApiUrl: string }) {
  const clerk = clerkMiddleware({ secretKey: options.clerkSecretKey });
  const scratchApi = new ScratchApiClient(options.scratchApiUrl);

  return [
    // Clerk middleware — parses session token, attaches auth to request
    clerk,

    // Custom middleware — load Scratch user for authenticated requests
    async (req: Request, res: Response, next: NextFunction) => {
      if (PUBLIC_PATHS.some((p) => req.path.startsWith(p))) {
        return next();
      }

      const auth = getAuth(req);
      if (!auth?.userId) {
        return res.redirect('/sign-in');
      }

      try {
        // Get a fresh Clerk session token to forward to Scratch API
        const token = await auth.getToken();
        if (!token) {
          return res.redirect('/sign-in');
        }

        // Load the Scratch user (creates if first login)
        const scratchUser = await scratchApi.getCurrentUser(token);
        res.locals.user = scratchUser;
        res.locals.clerkToken = token;

        next();
      } catch (err) {
        console.error('Auth error:', err);
        return res.redirect('/sign-in');
      }
    },
  ];
}
```

### 4.3 Sign-In Page

The sign-in page loads ClerkJS and renders Clerk's embedded sign-in component. This is a full HTML page (not an HTMX partial) since the user is not yet authenticated.

```html
<!-- src/server/views/sign-in.ejs -->
<%- include('layouts/head', { title: 'Sign In' }) %>
<body>
  <div style="display:flex; justify-content:center; align-items:center; height:100vh;">
    <div id="clerk-sign-in"></div>
  </div>

  <script
    async
    crossorigin="anonymous"
    data-clerk-publishable-key="<%= clerkPublishableKey %>"
    src="https://cdn.jsdelivr.net/npm/@clerk/clerk-js@latest/dist/clerk.browser.js"
    type="text/javascript"
  ></script>
  <script>
    window.addEventListener('load', async () => {
      await Clerk.load();
      if (Clerk.user) {
        // Already signed in — redirect to home
        window.location.href = '/';
      } else {
        Clerk.mountSignIn(document.getElementById('clerk-sign-in'), {
          afterSignInUrl: '/',
          afterSignUpUrl: '/',
        });
      }
    });
  </script>
</body>
</html>
```

### 4.4 Auth Routes

```ts
// src/server/routes/auth.routes.ts
import { Router } from 'express';

export function authRoutes(): Router {
  const router = Router();

  router.get('/sign-in', (req, res) => {
    res.render('sign-in');
  });

  router.post('/sign-out', async (req, res) => {
    // ClerkJS handles sign-out client-side; this just redirects
    res.redirect('/sign-in');
  });

  return router;
}
```

### 4.5 Post-Authentication: Loading the Scratch User

After Clerk sign-in, every authenticated request goes through the auth middleware (Section 4.2) which calls `GET /users/current` on the Scratch server. The Scratch user object — including `apiToken` — is stored in `res.locals.user` and available to all route handlers and templates.

This mirrors the web client's `useScratchUser` flow, but happens server-side on every request (with caching — see Section 4.6).

### 4.6 User Session Cache

To avoid calling `GET /users/current` on every single HTMX request, cache the Scratch user in memory keyed by Clerk user ID, with a 5-minute TTL:

```ts
// src/server/services/user-cache.ts
interface CachedUser {
  user: ScratchUser;
  fetchedAt: number;
}

const cache = new Map<string, CachedUser>();
const TTL_MS = 5 * 60 * 1000; // 5 minutes

export function getCachedUser(clerkUserId: string): ScratchUser | null {
  const entry = cache.get(clerkUserId);
  if (!entry) return null;
  if (Date.now() - entry.fetchedAt > TTL_MS) {
    cache.delete(clerkUserId);
    return null;
  }
  return entry.user;
}

export function setCachedUser(clerkUserId: string, user: ScratchUser): void {
  cache.set(clerkUserId, { user, fetchedAt: Date.now() });
}
```

### 4.7 API Token for CLI Authentication

Same flow as the original plan — once the Scratch user is loaded and has an `apiToken`, the server writes it to `~/.scratchmd/credentials.yaml`. Since the Express server runs in the Electron main process (not a sandboxed renderer), it has direct filesystem access:

```ts
// src/server/services/cli-auth.ts
import fs from 'fs';
import path from 'path';
import os from 'os';
import yaml from 'js-yaml';

interface CliCredentials {
  version: '2.0.0';
  environments: Record<string, { apiToken: string; email: string; expiresAt?: string }>;
}

export function writeCliCredentials(
  serverUrl: string,
  apiToken: string,
  email: string,
  expiresAt?: string,
): void {
  const credDir = path.join(os.homedir(), '.scratchmd');
  const credPath = path.join(credDir, 'credentials.yaml');

  const hostname = new URL(serverUrl).hostname;

  let existing: CliCredentials = { version: '2.0.0', environments: {} };
  if (fs.existsSync(credPath)) {
    const raw = fs.readFileSync(credPath, 'utf-8');
    existing = yaml.load(raw) as CliCredentials;
  }

  existing.environments[hostname] = { apiToken, email, expiresAt };

  fs.mkdirSync(credDir, { recursive: true });
  fs.writeFileSync(credPath, yaml.dump(existing), { mode: 0o600 });
}
```

No IPC bridge needed — the auth middleware calls this directly after loading the Scratch user.

### 4.8 Environment Variables

```env
CLERK_PUBLISHABLE_KEY=pk_live_...     # or pk_test_... for development
CLERK_SECRET_KEY=sk_live_...          # Clerk backend secret
SCRATCH_API_URL=https://api.scratch.md
```

These go in `scratch-desktop/.env` (gitignored) and are loaded via `dotenv` at startup.

---

## 5. HTML Templates & HTMX

### 5.1 Base Layout

```html
<!-- src/server/views/layouts/main.ejs -->
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title><%= typeof title !== 'undefined' ? title + ' — Scratch' : 'Scratch Desktop' %></title>
  <link rel="stylesheet" href="/static/css/styles.css" />
  <script src="/static/htmx.min.js"></script>
</head>
<body hx-boost="true">
  <%- include('../partials/nav') %>
  <main id="content">
    <%- body %>
  </main>
</body>
</html>
```

**Key HTMX features used:**

- `hx-boost="true"` on `<body>` — all `<a>` and `<form>` elements automatically use AJAX navigation (swap the `<body>` content without full page reload)
- `hx-get` / `hx-post` — trigger AJAX requests that return HTML fragments
- `hx-target` — specify where to insert the response
- `hx-swap` — control how the response replaces content (innerHTML, outerHTML, beforeend, etc.)
- `hx-trigger` — custom event triggers (click, keyup, every 5s, etc.)
- `hx-indicator` — show a loading spinner during requests

### 5.2 Navigation

```html
<!-- src/server/views/partials/nav.ejs -->
<nav class="nav">
  <a href="/" class="nav-brand">Scratch Desktop</a>
  <div class="nav-right">
    <% if (typeof user !== 'undefined' && user) { %>
      <span class="nav-user"><%= user.email %></span>
      <form hx-post="/sign-out" hx-target="body">
        <button type="submit" class="btn btn-ghost">Sign Out</button>
      </form>
    <% } %>
  </div>
</nav>
```

### 5.3 Home Page — Workspace List

```html
<!-- src/server/views/home.ejs -->
<% layout('layouts/main') %>

<div class="workspace-list">
  <h1>Your Workspaces</h1>

  <div class="workspace-grid"
       hx-get="/workspaces/list"
       hx-trigger="load"
       hx-target="this"
       hx-indicator="#loading">
    <div id="loading" class="htmx-indicator">Loading workspaces...</div>
  </div>
</div>
```

```html
<!-- src/server/views/partials/workspace-card.ejs -->
<a href="/workspace/<%= workspace.id %>" class="workspace-card">
  <h3><%= workspace.name %></h3>
  <p><%= workspace.fileCount %> files</p>
  <p>Updated <%= workspace.updatedAtRelative %></p>
</a>
```

The workspace list partial is returned by `GET /workspaces/list` and swapped into the grid container. This means the initial page load is fast (just the shell) and the workspace data loads asynchronously.

### 5.4 Workspace Page — File Tree & Viewer

```html
<!-- src/server/views/workspace.ejs -->
<% layout('layouts/main') %>

<div class="workspace-layout">
  <!-- Sidebar: file tree -->
  <aside class="sidebar">
    <div hx-get="/workspace/<%= workspace.id %>/tree"
         hx-trigger="load"
         hx-target="this">
      Loading file tree...
    </div>
  </aside>

  <!-- Main: file viewer -->
  <section class="main-panel" id="file-viewer">
    <p class="placeholder">Select a file to view its contents.</p>
  </section>
</div>
```

```html
<!-- src/server/views/partials/file-tree.ejs -->
<ul class="file-tree">
  <% for (const folder of folders) { %>
    <li class="folder">
      <span class="folder-name"
            hx-get="/workspace/<%= workspaceId %>/tree?path=<%= folder.path %>"
            hx-target="closest li"
            hx-swap="innerHTML">
        <%= folder.name %>/
      </span>
    </li>
  <% } %>
  <% for (const file of files) { %>
    <li class="file">
      <a hx-get="/workspace/<%= workspaceId %>/file?path=<%= file.path %>"
         hx-target="#file-viewer"
         hx-push-url="true">
        <%= file.name %>
      </a>
    </li>
  <% } %>
</ul>
```

Clicking a file in the tree loads its contents into the `#file-viewer` panel via HTMX — no page navigation, no client-side routing library.

### 5.5 File Viewer

```html
<!-- src/server/views/partials/file-viewer.ejs -->
<div class="file-viewer">
  <header class="file-header">
    <h2><%= file.path %></h2>
    <div class="file-actions">
      <button hx-post="/workspace/<%= workspaceId %>/file/download?path=<%= file.path %>"
              hx-swap="none"
              class="btn btn-sm">
        Download
      </button>
    </div>
  </header>

  <div class="file-content">
    <% if (file.format === 'json') { %>
      <table class="record-table">
        <% for (const [key, value] of Object.entries(file.fields)) { %>
          <tr>
            <td class="field-key"><%= key %></td>
            <td class="field-value"><%= typeof value === 'object' ? JSON.stringify(value) : value %></td>
          </tr>
        <% } %>
      </table>
    <% } else { %>
      <pre><code><%= file.content %></code></pre>
    <% } %>
  </div>
</div>
```

---

## 6. Express Routes

### 6.1 Route Registration

```ts
// src/server/routes/index.ts
import { Express } from 'express';
import { authRoutes } from './auth.routes';
import { homeRoutes } from './home.routes';
import { workspaceRoutes } from './workspace.routes';

export function registerRoutes(app: Express): void {
  app.use(authRoutes());
  app.use(homeRoutes());
  app.use('/workspace', workspaceRoutes());
}
```

### 6.2 Home Routes

```ts
// src/server/routes/home.routes.ts
import { Router } from 'express';
import { ScratchApiClient } from '../services/scratch-api';

export function homeRoutes(): Router {
  const router = Router();

  // Full page — workspace selector
  router.get('/', (req, res) => {
    res.render('home', { title: 'Home' });
  });

  // HTMX partial — workspace list (loaded async)
  router.get('/workspaces/list', async (req, res) => {
    const api = new ScratchApiClient(res.locals.clerkToken);
    const workbooks = await api.listWorkbooks();

    // Map server "workbooks" to UI "workspaces"
    const workspaces = workbooks.map((wb) => ({
      id: wb.id,
      name: wb.name,
      fileCount: wb.fileCount ?? 0,
      updatedAtRelative: formatRelativeTime(wb.updatedAt),
    }));

    res.render('partials/workspace-grid', { workspaces });
  });

  return router;
}
```

### 6.3 Workspace Routes

```ts
// src/server/routes/workspace.routes.ts
import { Router } from 'express';
import { ScratchApiClient } from '../services/scratch-api';
import { CliService } from '../services/cli';

export function workspaceRoutes(): Router {
  const router = Router();

  // Full page — workspace view
  router.get('/:id', async (req, res) => {
    const api = new ScratchApiClient(res.locals.clerkToken);
    const workspace = await api.getWorkbook(req.params.id);
    res.render('workspace', { title: workspace.name, workspace });
  });

  // HTMX partial — file tree for a folder
  router.get('/:id/tree', async (req, res) => {
    const api = new ScratchApiClient(res.locals.clerkToken);
    const folderPath = (req.query.path as string) || '/';
    const { folders, files } = await api.listFiles(req.params.id, folderPath);
    res.render('partials/file-tree', {
      workspaceId: req.params.id,
      folders,
      files,
    });
  });

  // HTMX partial — file content viewer
  router.get('/:id/file', async (req, res) => {
    const api = new ScratchApiClient(res.locals.clerkToken);
    const filePath = req.query.path as string;
    const file = await api.getFile(req.params.id, filePath);
    res.render('partials/file-viewer', {
      workspaceId: req.params.id,
      file,
    });
  });

  // CLI operations — init workspace locally
  router.post('/:id/init', async (req, res) => {
    const cli = new CliService();
    const outputDir = req.body.outputDir;
    await cli.initWorkspace(req.params.id, outputDir);
    res.render('partials/toast', {
      type: 'success',
      message: `Workspace initialized at ${outputDir}`,
    });
  });

  // CLI operations — download files
  router.post('/:id/download-files', async (req, res) => {
    const cli = new CliService();
    const cwd = req.body.cwd;
    const result = await cli.downloadFiles(cwd);
    res.render('partials/toast', {
      type: 'success',
      message: `Downloaded ${result.fileCount} files`,
    });
  });

  return router;
}
```

---

## 7. Service Layer

### 7.1 Scratch API Client

HTTP client for communicating with the Scratch server. Uses the Clerk JWT for authentication (same as the web client).

```ts
// src/server/services/scratch-api.ts
import axios, { AxiosInstance } from 'axios';

export class ScratchApiClient {
  private http: AxiosInstance;

  constructor(private clerkToken: string) {
    this.http = axios.create({
      baseURL: process.env.SCRATCH_API_URL,
      headers: { Authorization: `Bearer ${clerkToken}` },
      timeout: 30_000,
    });
  }

  async getCurrentUser(): Promise<ScratchUser> {
    const { data } = await this.http.get('/users/current');
    return data;
  }

  async listWorkbooks(): Promise<Workbook[]> {
    const { data } = await this.http.get('/workbook');
    return data;
  }

  async getWorkbook(id: string): Promise<Workbook> {
    const { data } = await this.http.get(`/workbook/${id}`);
    return data;
  }

  async listFiles(workbookId: string, folderPath: string): Promise<FileListResult> {
    const { data } = await this.http.get(`/workbooks/${workbookId}/files/list/by-folder`, {
      params: { path: folderPath },
    });
    return data;
  }

  async getFile(workbookId: string, filePath: string): Promise<FileRecord> {
    const { data } = await this.http.get(`/workbooks/${workbookId}/files/by-path`, {
      params: { path: filePath },
    });
    return data;
  }
}
```

### 7.2 CLI Service

Wraps the Rust CLI binary. No IPC bridge needed — the Express server calls `execFile` directly.

```ts
// src/server/services/cli.ts
import { execFile } from 'child_process';
import { promisify } from 'util';
import { app } from 'electron';
import path from 'path';

const execFileAsync = promisify(execFile);

export class CliService {
  private getCliPath(): string {
    // In packaged app, binary is in resources/bin/
    if (app.isPackaged) {
      return path.join(process.resourcesPath, 'bin', 'scratchmd');
    }
    // In development, use the binary on PATH or a local build
    return 'scratchmd';
  }

  async run(args: string[], cwd?: string): Promise<{ stdout: string; stderr: string }> {
    return execFileAsync(this.getCliPath(), args, {
      cwd,
      env: { ...process.env },
      maxBuffer: 10 * 1024 * 1024,
    });
  }

  async initWorkspace(workbookId: string, outputDir: string): Promise<void> {
    await this.run(['workspaces', 'init', workbookId, '-o', outputDir], outputDir);
  }

  async downloadFiles(cwd: string): Promise<{ fileCount: number }> {
    const { stdout } = await this.run(['files', 'download', '--json'], cwd);
    return JSON.parse(stdout);
  }

  async uploadFiles(cwd: string): Promise<{ fileCount: number }> {
    const { stdout } = await this.run(['files', 'upload', '--json'], cwd);
    return JSON.parse(stdout);
  }

  async listLocalWorkspaces(): Promise<string> {
    const { stdout } = await this.run(['workspaces', 'list', '--json']);
    return stdout;
  }
}
```

### 7.3 Filesystem Service

Direct local filesystem operations for workspace management. The Express server runs in the Electron main process, so it has full `fs` access.

```ts
// src/server/services/filesystem.ts
import fs from 'fs/promises';
import path from 'path';
import os from 'os';

const DEFAULT_WORKSPACE_ROOT = path.join(os.homedir(), 'Scratch');

export class FilesystemService {
  private workspaceRoot: string;

  constructor(workspaceRoot?: string) {
    this.workspaceRoot = workspaceRoot ?? DEFAULT_WORKSPACE_ROOT;
  }

  async ensureWorkspaceRoot(): Promise<void> {
    await fs.mkdir(this.workspaceRoot, { recursive: true });
  }

  async listLocalWorkspaces(): Promise<string[]> {
    await this.ensureWorkspaceRoot();
    const entries = await fs.readdir(this.workspaceRoot, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
  }

  async getWorkspacePath(name: string): Promise<string> {
    return path.join(this.workspaceRoot, name);
  }

  async readLocalFile(workspaceName: string, filePath: string): Promise<string> {
    const fullPath = path.join(this.workspaceRoot, workspaceName, filePath);
    return fs.readFile(fullPath, 'utf-8');
  }

  async writeLocalFile(workspaceName: string, filePath: string, content: string): Promise<void> {
    const fullPath = path.join(this.workspaceRoot, workspaceName, filePath);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, content, 'utf-8');
  }
}
```

---

## 8. HTMX Patterns

### 8.1 Navigation (hx-boost)

With `hx-boost="true"` on the `<body>`, all standard `<a>` links and `<form>` submissions are intercepted by HTMX. It fetches the new page via AJAX, extracts the `<body>` content, and swaps it in — giving SPA-like navigation without any client-side router.

This means navigating from the home page to a workspace page feels instant (no full page reload, no white flash).

### 8.2 Partial Updates

For interactions within a page (expanding a folder, viewing a file), use `hx-get` with `hx-target` to swap just the relevant portion:

```html
<!-- Clicking a folder expands it in-place -->
<span hx-get="/workspace/123/tree?path=/blog"
      hx-target="closest li"
      hx-swap="innerHTML">
  blog/
</span>
```

### 8.3 Form Submissions

File operations (init, download, upload) use `hx-post` to submit actions and receive toast notifications:

```html
<form hx-post="/workspace/123/init"
      hx-target="#notifications"
      hx-swap="beforeend">
  <input type="text" name="outputDir" placeholder="~/Scratch/my-workspace" />
  <button type="submit" class="btn">Initialize Locally</button>
</form>

<div id="notifications"></div>
```

### 8.4 Polling for Long Operations

For async operations (pull files, publish), use `hx-trigger="every 2s"` to poll for job status:

```html
<!-- Shown after triggering a pull -->
<div hx-get="/jobs/<%= jobId %>/status"
     hx-trigger="every 2s"
     hx-target="this"
     hx-swap="outerHTML">
  <div class="progress-bar">
    <div class="progress-fill" style="width: <%= progress %>%"></div>
  </div>
  <p><%= statusMessage %></p>
</div>
```

When the job completes, the server returns a fragment without `hx-trigger`, which stops the polling automatically.

### 8.5 Server-Sent Events (Alternative to Polling)

For real-time progress updates, HTMX supports SSE natively via the `sse` extension:

```html
<div hx-ext="sse"
     sse-connect="/jobs/<%= jobId %>/stream"
     sse-swap="progress">
  Waiting for updates...
</div>
```

The Express route would use SSE:

```ts
router.get('/jobs/:jobId/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');

  const interval = setInterval(async () => {
    const status = await getJobStatus(req.params.jobId);
    res.write(`event: progress\ndata: <div>${status.message} (${status.percent}%)</div>\n\n`);

    if (status.complete) {
      clearInterval(interval);
      res.end();
    }
  }, 1000);

  req.on('close', () => clearInterval(interval));
});
```

---

## 9. Styling

### 9.1 Approach

Without Mantine, the desktop app needs its own styling. Options:

**Option A — Tailwind CSS (Recommended)**
- Utility-first, no build step needed if using the CDN play version (or a simple PostCSS build)
- Fast iteration, consistent spacing/colors
- Can replicate the general feel of the web client

**Option B — Custom CSS with CSS Variables**
- Copy the CSS custom properties from the web client's `globals.css`
- Write component styles manually
- Smallest footprint, full control

**Option C — Pico CSS (Classless)**
- Drop-in stylesheet that styles semantic HTML
- Looks decent out of the box, minimal effort
- Limited customization

For Phase 1, **Option B** (custom CSS) is recommended — copy the design tokens (colors, spacing, fonts) from the web client and write minimal component styles. This keeps the desktop app visually consistent without importing a large framework.

### 9.2 Design Tokens from Web Client

```css
/* src/server/public/css/styles.css */
:root {
  /* Colors — from client globals.css */
  --color-primary: #228be6;
  --color-primary-light: #4dabf7;
  --color-background: #ffffff;
  --color-surface: #f8f9fa;
  --color-border: #dee2e6;
  --color-text: #212529;
  --color-text-muted: #868e96;
  --color-success: #40c057;
  --color-error: #fa5252;

  /* Typography */
  --font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
  --font-mono: 'Geist Mono', ui-monospace, monospace;

  /* Spacing */
  --space-xs: 4px;
  --space-sm: 8px;
  --space-md: 16px;
  --space-lg: 24px;
  --space-xl: 32px;

  /* Layout */
  --sidebar-width: 260px;
  --nav-height: 48px;
}

/* Base styles */
body {
  font-family: var(--font-family);
  color: var(--color-text);
  background: var(--color-background);
  margin: 0;
}

/* ... additional component styles */
```

---

## 10. Rust CLI Integration

### 10.1 Strategy

Identical to the original plan. The Rust CLI (`experimental/scratch-cli-2`) is bundled as a platform-specific binary. The key difference is that it's invoked directly from Express route handlers instead of going through Electron IPC.

### 10.2 Binary Placement & electron-builder

Same as original plan — see the original document's Section 5.2 and 5.3.

### 10.3 CLI Authentication

Same as original plan — the Express server writes the API token to `~/.scratchmd/credentials.yaml` directly after authenticating the user (Section 4.7). No IPC needed.

### 10.4 Building CLI Binaries

Same `scripts/build-cli.sh` as the original plan — see the original document's Section 5.6.

---

## 11. Build & Distribution

### 11.1 Build Process

The build is simpler than the original plan because there's no Vite bundling step:

1. `tsc` compiles TypeScript to JavaScript in `out/`
2. Static assets (views, CSS, JS) are copied to `out/`
3. `electron-builder` packages everything into a distributable

```jsonc
// package.json scripts
{
  "scripts": {
    "prebuild": "rm -rf out",
    "build": "tsc && cp -r src/server/views out/server/views && cp -r src/server/public out/server/public",
    "build:mac": "yarn build && electron-builder --mac",
    "build:linux": "yarn build && electron-builder --linux"
  }
}
```

### 11.2 electron-builder.yml

```yaml
appId: com.scratch.desktop
productName: Scratch Desktop
directories:
  buildResources: build
  output: dist

files:
  - "out/**/*"
  - "node_modules/**/*"
  - "!src/*"
  - "!**/*.ts"
  - "!{tsconfig.json,.eslintrc.*,.prettierrc.*}"

asarUnpack:
  - resources/**
  - out/server/views/**
  - out/server/public/**

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
  url: https://releases.scratch.md/desktop
```

> **Note**: `asarUnpack` includes the views and public directories because EJS templates and static files must be readable from the filesystem at runtime — they cannot be loaded from inside an ASAR archive.

### 11.3 macOS Entitlements & Notarization

Same as the original plan — see the original document's Sections 6.2 and 6.3.

### 11.4 CI/CD

Same workflow structure as the original plan. The only change is the build command (`tsc` instead of `electron-vite build`). See the original document's Section 6.5.

---

## 12. Monorepo Integration

### 12.1 Yarn Workspace Registration

Same as the original plan — add `scratch-desktop` to the root `package.json` workspaces array.

### 12.2 Turborepo — Not Required Initially

Same as the original plan.

### 12.3 .gitignore

```
out/
dist/
resources/bin/
*.env
```

---

## 13. Implementation Steps

### Phase 1 — Scaffold & Express Server

1. Create `scratch-desktop/` directory with `package.json`, `tsconfig.json`
2. Install dependencies (express, ejs, htmx.org, electron, electron-builder, etc.)
3. Add to root Yarn workspaces
4. Create `src/main.ts` — Electron bootstrap (start Express, open BrowserWindow)
5. Create `src/server/app.ts` — Express app with EJS view engine
6. Create base layout template (`layouts/main.ejs`) with HTMX script tag
7. Create a "Hello World" home page template
8. Verify `yarn dev` opens an Electron window showing the Express-served page

### Phase 2 — Clerk Authentication

9. Install `@clerk/express` and `@clerk/backend`
10. Set up `.env` with Clerk keys and Scratch API URL
11. Create sign-in page with ClerkJS loaded via CDN
12. Implement auth middleware (Clerk session verification + Scratch user loading)
13. Add local session guard (shared secret cookie)
14. Implement user session cache (5-minute TTL)
15. Test sign-in flow end-to-end: Clerk → Scratch user → authenticated pages

### Phase 3 — Home Page & Workspace List

16. Create home page template with workspace grid
17. Create workspace card partial
18. Implement `GET /workspaces/list` route (HTMX partial, fetches from Scratch API)
19. Add basic CSS styling (design tokens from web client)
20. Test: sign in, see workspace list, click a workspace

### Phase 4 — Workspace View & File Operations

21. Create workspace page template (sidebar + main panel layout)
22. Implement file tree partial with folder expansion via HTMX
23. Implement file viewer partial
24. Create `ScratchApiClient` service for server API calls
25. Wire up routes: `GET /workspace/:id`, `GET /workspace/:id/tree`, `GET /workspace/:id/file`
26. Test: navigate to workspace, browse file tree, view file contents

### Phase 5 — CLI Integration

27. Create `scripts/build-cli.sh` (same as original plan)
28. Implement `CliService` with `execFile` wrapper
29. Implement `writeCliCredentials` for CLI authentication
30. Add CLI credential writing to auth middleware (after Scratch user load)
31. Add workspace init route (`POST /workspace/:id/init`)
32. Add file download/upload routes
33. Test: init workspace locally, download files, upload files

### Phase 6 — Polish & Build

34. Add toast notification system (HTMX partial + CSS animations)
35. Add job progress polling for long-running operations
36. Configure `electron-builder.yml`
37. Create macOS entitlements plist
38. Test local production build
39. Create CI workflow for automated builds
40. Document the build process in a README

---

## 14. Comparison: What's Simpler vs. What's Lost

### Simpler in This Architecture

| Area | Original (React) | This (HTMX) |
|------|-------------------|--------------|
| IPC bridge | Preload script + contextBridge + ipcMain handlers for every operation | None — Express calls Node APIs directly |
| Build tooling | electron-vite (Vite for 3 targets: main, preload, renderer) | `tsc` + copy static files |
| State management | Zustand stores + SWR + React Context | Server-side `res.locals` + simple in-memory cache |
| Routing | react-router-dom (hash mode) | Express routes + `hx-boost` |
| Auth token flow | Clerk React SDK → axios interceptor → IPC for CLI creds | Clerk Express middleware → direct `fs.writeFile` |
| Dependencies | ~20 packages (React, Mantine, SWR, Zustand, etc.) | ~8 packages (Express, EJS, HTMX, Clerk, axios) |

### Lost / Harder in This Architecture

| Area | Impact | Mitigation |
|------|--------|------------|
| Mantine component library | No pre-built UI components; must write CSS manually | Use design tokens from web client; consider Tailwind later |
| Rich text editing | No React-based editor components | Use a vanilla JS editor (CodeMirror, Monaco) loaded via `<script>` if needed |
| Drag-and-drop | HTMX doesn't handle complex drag UIs | Use Sortable.js or similar vanilla library for specific interactions |
| Optimistic updates | HTMX waits for server response before updating UI | Use `hx-swap="outerHTML settle:0"` or `htmx:beforeSwap` for instant feedback |
| Component reuse with web client | No shared React components | Templates could be shared via a partial library, but realistically the two UIs diverge |
| Real-time WebSocket updates | Web client uses Socket.io for live progress | Use SSE from Express (Section 8.5) or HTMX polling |

---

## 15. Resolved & Open Questions

### Resolved

1. **No IPC bridge needed**: The Express server runs in Electron's main process and has full Node.js access. No preload/contextBridge/ipcMain plumbing required.
2. **Clerk works with Express**: `@clerk/express` provides middleware for session verification. ClerkJS (browser SDK) handles the sign-in UI.
3. **CLI auth**: Same as original plan — write API token to `~/.scratchmd/credentials.yaml` directly from Express.
4. **HTMX in Electron**: Electron's Chromium fully supports HTMX. No compatibility issues.
5. **No React dependency**: The entire renderer is HTML + CSS + HTMX (~14KB). Alpine.js can be added for minor client-side state if needed.

### Open

1. **Rust CLI location**: Same as original plan — should `experimental/scratch-cli-2` be promoted to a top-level directory?
2. **API token expiry handling**: Same as original plan — proactive regeneration vs. reactive 401 handling?
3. **Offline mode**: Same as original plan.
4. **Styling approach**: Should we invest in Tailwind CSS upfront or start with minimal custom CSS and iterate?
5. **EJS vs. other template engines**: EJS is the simplest choice, but alternatives like Handlebars or Nunjucks offer template inheritance. EJS with `include()` should be sufficient for Phase 1.
6. **Electron `app` import in Express**: The `CliService` imports `app` from Electron to get `process.resourcesPath`. This creates a coupling between the Express server and Electron. Alternative: pass the CLI path as a constructor argument so the server code can be tested independently.
