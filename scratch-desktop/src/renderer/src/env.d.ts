/// <reference types="vite/client" />

// Short git commit hash the renderer bundle was built at, injected via Vite `define` in
// electron.vite.config.ts. Surfaced in the Settings screen footer alongside the app version.
declare const __GIT_COMMIT_HASH__: string;

// PostHog ships the bundled session-recording extension as a side-effect-only module with no
// type declarations. We import it to register __PosthogExtensions__.initSessionRecording locally
// (so the recorder is never fetched from the CDN at runtime). See lib/posthog.ts.
declare module 'posthog-js/dist/posthog-recorder';
