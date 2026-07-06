/// <reference types="vite/client" />

// PostHog ships the bundled session-recording extension as a side-effect-only module with no
// type declarations. We import it to register __PosthogExtensions__.initSessionRecording locally
// (so the recorder is never fetched from the CDN at runtime). See lib/posthog.ts.
declare module 'posthog-js/dist/posthog-recorder';
