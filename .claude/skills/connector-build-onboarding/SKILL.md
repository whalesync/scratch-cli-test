---
name: connector-build-onboarding
user-invocable: true
description: One-time, guided setup that gets a teammate ready to run /connector-build-prepare and /connector-build-execute. Walks them through installing + verifying the two browser options (gstack headless/headed, and the Claude-for-Chrome extension) and the gmail-whalesync MCP (the email-verification reader), then declares them ready. Assumes the Scratch dev environment is already set up. Passes when BOTH browsers (gstack + the Claude-for-Chrome extension) work AND gmail-whalesync is connected; the local voice model is optional. Use when a teammate says they want to start building connectors, asks how to set up connector-build, or runs /connector-build-onboarding.
---

# connector-build-onboarding

Run this **once** before your first `/connector-build-prepare` / `/connector-build-execute`. It leads you through the connector-build–specific setup and verifies it live. **Be conversational and interactive** — check each piece, and when something's missing, give the exact fix and re-check after they've done it. Declare them ready only when the readiness rule is met.

**Assumption:** the Scratch **dev environment is already working** — repo cloned, `yarn install` (client + server), Docker (Postgres + Redis) up, DB created + migrated, `scratchmd` built, the server runnable, node 22. This skill does **not** set that up; it only adds the connector-build extras (browser + email reader + secrets file). If a basic check fails (e.g. `scratchmd` missing), point them at the repo README and stop.

> **Overnight note to say up front:** these runs need the **machine awake** (a browser is always driven) — that's a requirement, not a bug. And tell them the gate rule (below) so they know whether they can walk away.

## What you're verifying (and the readiness rule)

Install **BOTH** browser drivers — they're each other's fallback, and an unattended overnight run must be able to switch when one flakes (gstack daemons die; the Chrome MCP can drop). This is a **requirement**, not a nicety:
1. **gstack** (headless + headed) — isolated, no window. The primary for unattended/overnight.
2. **Chrome + Claude-for-Chrome extension (headed)** — drives their real Chrome; the fallback when gstack wedges.

**READY when: gstack works AND Chrome+extension works AND `gmail-whalesync` is connected.** Both browsers required (the fallback is the whole point of robustness); `gmail-whalesync` required (it reads the email verification codes/links). The local voice model (step 4) is **optional**.

## Steps

**0. Run the bash check** to cover the secrets file + the gstack binary:
```
bash .claude/skills/connector-build-onboarding/check-setup.sh
```
Read its output with them; it tells you the secrets-file + gstack-binary state and what to fix.

**1. Secrets file — `connector-build/.env.connector-build`.** Building a **new** connector doesn't need anyone else's secrets, but the file must exist to write into. If it's missing: either copy the shared note from **1Password → "connector-build secrets"**, or `cp connector-build/.env.connector-build.sample connector-build/.env.connector-build` to start empty.

**2. Browser — get BOTH working (they're each other's fallback).**
- **gstack**: if the binary check passed, smoke-test it live — `$B connect` then `$B status` (headless), and `$B connect --headed` then `$B status --headed` (must show `Mode: headed`). If the binary is missing, walk them through installing the gstack browser, then re-check. If gstack misbehaves, use the recovery in the execute skill's preflight (single clean daemon, kill stray daemons + remove the SingletonLock).
- **Chrome extension**: have them install the **Claude-for-Chrome extension** and connect it with **`/connect-chrome`** (the agent can't trigger it). Then verify: load the tools via ToolSearch (`mcp__claude-in-chrome__tabs_context_mcp` + `tabs_create_mcp` + `navigate`), create your **own** tab, navigate it somewhere simple, confirm it loads.
- **Both must work to pass.** (Note: the Chrome extension must be re-connected with `/connect-chrome` at the start of each run; gstack persists across runs.)

**3. gmail-whalesync MCP (required).** This reads the email-verification codes/links during signup. It must be the **custom server** that returns the **raw** email body.
- **⚠️ Do NOT use the built-in `claude_ai_Gmail` — it does not work for us.** It redacts magic-link verification tokens, so link-based signups silently break. Tell them this explicitly; the custom `gmail-whalesync` server is strictly better.
- **Check whether `mcp__gmail-whalesync__*` tools exist** (try ToolSearch for `mcp__gmail-whalesync__search_emails`).
- **If a *different* Gmail/Whalesync MCP is already installed** (you spot an `mcp__*gmail*` or `mcp__*whalesync*` server that isn't `gmail-whalesync` and isn't the broken `claude_ai_Gmail`), **ask them** whether to reuse that one or set up a fresh `gmail-whalesync` — some coworkers may already have a suitable custom Gmail server. Recommend reusing it only if it returns raw bodies; otherwise set up `gmail-whalesync`.
- **If absent**, walk them through installing it: run **`.claude/skills/connector-build-prepare/gmail-setup`** — it asks only for the OAuth client JSON, which is in **1Password → "Gmail Auto-Label Desktop OAuth"** (paste it or pass the file path). It connects **their own `@whalesync.com` Gmail** (sign in as themselves). Then they **restart the Claude session** so the new MCP loads.
- **Verify live:** `mcp__gmail-whalesync__search_emails("newer_than:2d", 3)` returns their mail. (Every team member receives a copy of every `testing@whalesync.com` email, so verification mails will land in their inbox.)

**4. Local voice model (OPTIONAL — skip freely).** The skills can speak a short end-of-run debrief and gate asks via a local `/read` voice skill — pleasant for long unattended runs, but **entirely optional**: the skills already treat `/read` as optional and work fully without it. Ask if they want it; if yes, point them at installing the local voice model + `/read` skill; if no, move on. **Do not gate readiness on this.**

**5. Declare readiness.** Apply the rule (both browsers + gmail-whalesync). Tell them clearly that both browsers work and gmail-whalesync is live, then: **"You're ready — run `/connector-build-prepare <connector>` to provision a test account, then `/connector-build-execute <connector>` to build it. Pick the next connector from [`connector-build/queued-connectors.md`](/connector-build/queued-connectors.md) — **Human Picks first, but skip `research pending` rows for an unattended run; start with a researched free-tier REST service like ClickUp / Jira / Asana** (see the first-pick rule atop that doc)."** If not ready, state exactly what's missing and the one action to fix it.

**6. Before EVERY run (not just setup) — say this to them.** A few things are per-run, not per-onboarding:
- **Re-run `/connect-chrome`** at the start of each session — the Chrome-extension fallback isn't connected until you do, so a wedged gstack at 2am has nothing to fall back to.
- **If you just ran `gmail-setup` this session, restart Claude first** — the `gmail-whalesync` MCP only loads in a fresh session, so the first email gate will stall otherwise.
- **Keep the machine awake** (a browser is always driven) — `caffeinate` or disable sleep for an overnight run.

## The gate rule (tell them this — it's how they decide whether to walk away)
When they kick off a provisioning/build run, the **first thing the agent reports** is whether the run will hit a human gate:
- **"No gates — I'll work on my own."** → they can walk away.
- **"Heads up: a gate is coming (e.g. a CAPTCHA on signup). When I reach it I'll open the page; you'll have ~1 minute to pass it, then I continue autonomously."** → stick around for that one moment.

That's the whole deal: mostly hands-off, occasionally one ~1-minute human gate.
