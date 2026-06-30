# Experiments Module

## Overview

The experiments module provides a feature flagging system for the Scratch application using PostHog feature flags via the `posthog-node` SDK.

## Flag Types

### System-Wide Flags

Flags that apply globally across the application. Things like system config or tweaked settings that might change based on a scenario or that we need realtime control over instead of updating an environment variable and triggering a new deployment.

### User-Scoped Flags

These are flags that are evaluated for the user and passed to the client.

## Special Flag Handling

### DEV_TOOLBOX

- Automatically determined by user role
- ADMIN users automatically get access
- No external flag evaluation needed

### ENABLE_SCRATCH_FOLDERS

- Gates the standalone "Scratch" (connector-less) files & folders UI (DEV-10424)
- Automatically determined by the server **environment**, not per-user targeting
- TRUE in every non-production environment (development / test / staging) so it stays on for local and test dogfooding
- In production it falls back to a PostHog flag that defaults to FALSE — off for prod users today, but flippable later without a redeploy (create `ENABLE_SCRATCH_FOLDERS` in the production project to enable)
- Client-only gate: the scratch data/endpoints stay available; only the UI surfaces are hidden when false

### DESKTOP_REVIEW_SURFACE_V2

- Gates the redesigned desktop review surface — review surface v2 (DEV-10617, under DEV-10615)
- Ordinary per-user boolean flag: no role or environment special-case, so it defaults FALSE in every environment when PostHog is disabled (ships dark)
- Flippable per-user from PostHog without a redeploy (create `DESKTOP_REVIEW_SURFACE_V2` in each project to enable)
- Client-only gate: when false the existing review experience is unchanged; no server behavior depends on it

## PostHog Integration

- Requires `POSTHOG_API_KEY` and `POSTHOG_FEATURE_FLAG_API_KEY` environment variables
- When keys are not configured (local dev), all flags return their default values
- Flag evaluation errors are caught and logged — they never crash the caller

## Client Integration

The frontend receives personalized flag settings when fetching the current user information:

- Enables client-side feature gates
- Supports experimentation tracking
- Allows dynamic feature rollout

## Use Cases

- A/B testing new features
- Gradual feature rollout
- User segment targeting
- Emergency feature kill switches
- Beta feature access control

## Configuration

Flags are configured through the PostHog dashboard:

- Test: https://us.posthog.com/project/225935/feature_flags
- Production: https://us.posthog.com/project/214130/feature_flags

**Important**: Do NOT set "Persist flag across authentication steps" on PostHog flag settings — this causes FlagNotFoundError.
