# Desktop end-to-end tests (Playwright `_electron`)

These tests launch the **built** Electron app and drive its real renderer with the same
Playwright API the web client uses for browser tests — via Playwright's first-class
[`_electron`](https://playwright.dev/docs/api/class-electron) support. They complement (don't
replace) the fast vitest unit suites under `src/`.

## Running

```bash
cd scratch-desktop
yarn test:e2e          # builds (electron-vite) then runs the Playwright specs in e2e/
```

`test:e2e` runs `yarn build` first because `_electron` launches `out/main/index.js`. To skip
the rebuild while iterating on a test, run `yarn playwright test` directly.

The bundled `smoke.spec.ts` is **hermetic** — it needs no backend and no real token. It proves
the login-bypass seam works:

- with no seeded credentials, the app shows the **Log in** screen;
- with seeded credentials, the app **skips** login and reaches the home screen (the renderer's
  first two server calls are mocked at the network layer, so the result doesn't depend on which
  backend the build targets).

## How auth is bypassed

The desktop normally logs in via interactive **device-code OAuth** — a flow that happens in the
system browser via Clerk and that a headless test cannot drive. Instead, the main process honors
a test-only seam:

| Env var                                 | Effect                                                                                                                                                                                                                                                                                                         |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SCRATCH_DESKTOP_TEST_CREDENTIALS_JSON` | JSON credentials seeded into the auth store at startup, so the renderer's auth gate finds a valid token and skips `LoginPage`. Also points `SCRATCH_URL` (the scratchmd CLI + napi) and syncs the CLI's stored credentials. **Honored only in unpackaged/dev builds.** Source: `src/main/test-credentials.ts`. |
| `SCRATCH_DESKTOP_USER_DATA_DIR`         | Per-run throwaway Electron profile, so tests are isolated from each other and from your own dev app. Source: `src/main/setup-userdata.ts`.                                                                                                                                                                     |

The credentials JSON shape mirrors what the app stores after a real login:

```json
{
  "apiToken": "<API-Token for a dedicated test account>",
  "email": "e2e@whalesync.com",
  "tokenExpiresAt": "2099-01-01T00:00:00Z",
  "serverUrl": "https://test-api.scratch.md"
}
```

## The live suite — `test-api.scratch.md` (`live.spec.ts`)

`live.spec.ts` runs the same flow against the **deployed test backend** with a real token for a
dedicated test account (`testing@whalesync.com`). It proves the whole chain — seam → real
API-Token → live auth → the account's real workspaces — instead of mocking.

```bash
yarn test:e2e:live
```

That script builds the app with the test API baked into `VITE_SCRATCH_API_URL` (the renderer's
base URL is a build-time Vite constant) and runs **only** `live.spec.ts` with `SCRATCH_E2E_LIVE=1`.
It is kept separate from `yarn test:e2e` on purpose: the hermetic suite uses a _fake_ token, which
a real backend would `401` (bouncing it to login), so the two never share a build.

### Providing the token

The live test reads `TESTING_ACCOUNT_API_KEY` from the environment. The easiest repeatable way is a
**gitignored** `scratch-desktop/.env.e2e` (covered by the `.env.*` rule), which
`playwright.config.ts` loads automatically:

```bash
# scratch-desktop/.env.e2e   (never committed)
TESTING_ACCOUNT_API_KEY=<the test account's API-Token>
TESTING_ACCOUNT_EMAIL=testing@whalesync.com
```

Or export it inline: `TESTING_ACCOUNT_API_KEY=… yarn test:e2e:live`. Without the key the live
test **skips** (it never fails for a missing secret). Optional overrides:
`SCRATCH_TEST_API_URL` (default `https://test-api.scratch.md`) and `TESTING_ACCOUNT_EMAIL`.

### Going further: exercising the CLI (download)

`live.spec.ts` is read-only — it stops at the first-run "Download a workspace" screen. The next
layer (download a workspace → assert the grid renders the rows the `scratchmd` CLI wrote to disk)
genuinely exercises desktop ⇄ CLI, but needs the native folder-picker dialog stubbed (Playwright
can't drive a native OS dialog), so it's a deliberate follow-up rather than part of this suite.

Two caveats for the real backend:

- **Side effects are real.** Download/upload/publish operate on live test data and can publish
  back to real test external services. Use a dedicated, disposable test workbook.
- **Token longevity.** A short-lived token will expire mid-suite and bounce the app to the login
  screen. Mint one with a long (or far-future) expiry, or refresh it before the run.
