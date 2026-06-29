---
name: connector-build-onboarding
user-invocable: true
description: One-time, guided setup that gets a teammate ready to run /connector-build-prepare and /connector-build-execute. Walks them through installing + verifying the two browser options (gstack headless/headed, and the Claude-for-Chrome extension) and the gmail-whalesync MCP (the email-verification reader), then declares them ready. Assumes the Scratch dev environment is already set up. Passes when at least ONE browser works AND gmail-whalesync is connected. Use when a teammate says they want to start building connectors, asks how to set up connector-build, or runs /connector-build-onboarding.
---

# connector-build-onboarding

Run this **once** before your first `/connector-build-prepare` / `/connector-build-execute`. It leads you through the connector-build–specific setup and verifies it live. **Be conversational and interactive** — check each piece, and when something's missing, give the exact fix and re-check after they've done it. Declare them ready only when the readiness rule is met.

**Assumption:** the Scratch **dev environment is already working** — repo cloned, `yarn install` (client + server), Docker (Postgres + Redis) up, DB created + migrated, `scratchmd` built, the server runnable, node 22. This skill does **not** set that up; it only adds the connector-build extras (browser + email reader + secrets file). If a basic check fails (e.g. `scratchmd` missing), point them at the repo README and stop.

> **Overnight note to say up front:** these runs need the **machine awake** (a browser is always driven) — that's a requirement, not a bug. And tell them the gate rule (below) so they know whether they can walk away.

## What you're verifying (and the readiness rule)

Three run options exist; **the skill tries all three**:
1. **gstack headless** — isolated, no window. Best for unattended/overnight.
2. **gstack headed** — same engine, visible window (used when a human must pass a gate).
3. **Chrome + Claude-for-Chrome extension (headed)** — drives their real Chrome.

**READY when: (gstack works OR Chrome+extension works) AND `gmail-whalesync` is connected.** They do **not** need both browsers — one is enough — but they **do** need `gmail-whalesync` (it reads the email verification codes/links).

## Steps

**0. Run the bash check** to cover the secrets file + the gstack binary:
```
bash .claude/skills/connector-build-onboarding/check-setup.sh
```
Read its output with them; it tells you the secrets-file + gstack-binary state and what to fix.

**1. Secrets file — `connector-build/.env.connector-build`.** Building a **new** connector doesn't need anyone else's secrets, but the file must exist to write into. If it's missing: either copy the shared note from **1Password → "Scratch Connector QA — .env.connector-build"**, or `cp connector-build/.env.connector-build.sample connector-build/.env.connector-build` to start empty.

**2. Browser — get at least ONE working.**
- **gstack** (option A): if the binary check passed, smoke-test it live — `$B connect` then `$B status` (headless), and `$B connect --headed` then `$B status --headed` (must show `Mode: headed`). If the binary is missing, walk them through installing the gstack browser, then re-check. If gstack misbehaves, use the recovery in the execute skill's preflight (single clean daemon, kill stray daemons + remove the SingletonLock).
- **Chrome extension** (option B): have them install the **Claude-for-Chrome extension** and connect it with **`/connect-chrome`** (the agent can't trigger it). Then verify: load the tools via ToolSearch (`mcp__claude-in-chrome__tabs_context_mcp` + `tabs_create_mcp` + `navigate`), create your **own** tab, navigate it somewhere simple, confirm it loads.
- It's fine if only one of the two works — note which, and move on.

**3. gmail-whalesync MCP (required).** This reads the email-verification codes/links during signup (it returns the **raw** email body, unlike `claude_ai_Gmail` which redacts magic-link tokens).
- Check whether `mcp__gmail-whalesync__*` tools exist (try ToolSearch for `mcp__gmail-whalesync__search_emails`).
- **If absent**, walk them through installing it: run **`.claude/skills/connector-build-prepare/gmail-setup`** — it asks only for the OAuth client JSON, which is in **1Password → "Gmail Auto-Label Desktop OAuth"** (paste it or pass the file path). It connects **their own `@whalesync.com` Gmail** (sign in as themselves). Then they **restart the Claude session** so the new MCP loads.
- **Verify live:** `mcp__gmail-whalesync__search_emails("newer_than:2d", 3)` returns their mail. (Every team member receives a copy of every `testing@whalesync.com` email, so verification mails will land in their inbox.)

**4. Declare readiness.** Apply the rule. Tell them clearly which browser option(s) work and that gmail-whalesync is live, then: **"You're ready — run `/connector-build-prepare <connector>` to provision a test account, then `/connector-build-execute <connector>` to build it. Pick the next connector from [`connector-build/queued-connectors.md`](/connector-build/queued-connectors.md) (Human Picks first)."** If not ready, state exactly what's missing and the one action to fix it.

## The gate rule (tell them this — it's how they decide whether to walk away)
When they kick off a provisioning/build run, the **first thing the agent reports** is whether the run will hit a human gate:
- **"No gates — I'll work on my own."** → they can walk away.
- **"Heads up: a gate is coming (e.g. a CAPTCHA on signup). When I reach it I'll open the page; you'll have ~1 minute to pass it, then I continue autonomously."** → stick around for that one moment.

That's the whole deal: mostly hands-off, occasionally one ~1-minute human gate.
