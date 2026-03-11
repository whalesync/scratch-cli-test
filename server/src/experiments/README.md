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
