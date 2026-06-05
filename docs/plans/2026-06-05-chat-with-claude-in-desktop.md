# Design: Chat with Claude inside Scratch desktop

- **Status:** Planned
- **Created:** 2026-06-05
- **Author:** Curtis Fonger
- **Linear:** _TBD_
- **Branch:** chat-with-claude-in-desktop
- **Affected package:** scratch-desktop
- **Source:** /office-hours design session (Startup mode), approved 2026-06-05

## Problem Statement

Scratch desktop is an "AI IDE for content marketers." Today, when customers use Scratch
with Claude, they run an alt-tab loop: chat with Claude Desktop to make content edits →
alt-tab to Scratch to review the changes → alt-tab back to Claude to chat more. The
customer is the human integration layer between two apps. Conductor (an AI IDE for
software engineers, also Electron) eliminated this for engineers by embedding Claude Code
in the center of the app — chat, review changes, chat again, no alt-tab. The bet: bring
that single-surface experience to Scratch desktop for content marketers.

A second, related pain: in the current external-Claude workflow it is annoying to tell
Claude how to look at the Scratch folder data and how to think about it. Conductor gets
leverage by controlling what context/skills are piped to the `claude` command. Owning the
in-app surface lets Scratch own that context.

## Demand Evidence

Observed daily customer behavior, not a survey (the strongest kind of demand signal):

> "When we work with customers on Scratch, their workflow is alt-tabbing between Claude
> Desktop and Scratch. They chat with Claude to make content edits, alt-tab to Scratch to
> review changes, alt-tab to Claude to chat some more, etc."

Customers are already running this workflow by hand every day — they've effectively hired
themselves as the integration glue. The product being proposed already exists in pieces;
it just is not assembled. A customer mid-workflow would be genuinely disrupted if the
pieces disappeared.

Founder's own words on the differentiator (this is the moat, not the headline):

> "in Scratch, it's annoying to tell Claude how to look at the Scratch folder data and how
> to think about it. Conductor seems to have figured something out where it gives Claude
> hints about Conductor skills... a benefit of having chat right inside [the app] and
> controlling how things are piped out to the Claude command."

## Status Quo

Claude Desktop (or Claude Code) in one window + Scratch desktop in another, mediated by the
user alt-tabbing. Scratch desktop already has a one-click launcher for this: the workspace
header's "Open in… → Claude Code / Claude Cowork / Codex" menu builds a Scratch-aware
kickoff prompt (`buildAgentPrompt(name, localPath, 'CLAUDE.md')`) and opens the **external**
agent via URL scheme (`claude://code/new?folder=<localPath>`). So "hand the on-disk
workbook to an agent" is already a shipped path — the bet is to collapse the external launch
target into an embedded panel.

## Target User & Narrowest Wedge

**User:** content marketers who are current/target Scratch customers and already reach for
Claude to draft and edit content.

**Narrowest wedge (chosen):** a Claude chat panel embedded in the center/side of the Scratch
workspace that shells out to Claude Code with `cwd` = the local workbook git checkout. Edits
Claude makes flow into Scratch's existing change-review view. Ships this week; explicitly
NOT gated on rich context-injection or in-chat review. One revision (see Premises P3): the
workspace-level agent docs are table stakes — and they **already exist**. `scratchmd
generate-docs` auto-writes `AGENTS.md` (+ a `CLAUDE.md` symlink) and `.scratch/docs/*.md`
(structure, schema — *"Must read before editing records!"* — editing-data, etc.) on
`workspaces init` and `files download`. So v1's context work is **improving** what is
already piped to Claude, not creating it.

## Constraints

- `scratch-desktop` is Electron (electron-vite) + React 19 + Mantine 8 + Zustand + SWR;
  CodeMirror for JSON, `marked` for markdown. Main / renderer / preload split.
- Performance rules (scratch-desktop/CLAUDE.md): no blocking the main thread; IPC must stay
  async; prefer streaming/file-path/incremental results over shipping large objects across
  IPC; clean up subscriptions/child processes in teardown.
- UI must use the components defined in `scratch-desktop/UI_SYSTEM.md` (not raw Mantine).
- Native Electron context menus only (already the pattern for "Open in…").
- Product principle "keep the user in control of what gets published": agent edits must land
  in the published→approved→local review ladder, never auto-publish.
- BYO-Claude auth (see P6): rely on the user's own logged-in `claude` credentials.

## Premises

- **P1 — The on-disk workspace checkout is the integration surface, and it already exists.**
  The desktop keeps a local git checkout at `localPath` (`~/Documents/ScratchWorkspaces/<name>`),
  already spawns CLI subprocesses against it (`scratchmd`, via `src/main/scratchmd.ts`'s
  `spawn` helpers + IPC streaming), and already hands `localPath` to external agents.
  Embedding Claude = spawn `claude` with `cwd=localPath` and stream into a panel. No new
  data plane, no new sync. *(Agreed.)*
- **P2 — Scratch's architecture makes agent edits safe by construction.** Files-in-git + the
  published→approved→local ladder + the change-review view turn every Claude edit into a
  reviewable, revertible diff approved before anything goes live. Same reason Conductor is
  safe: git makes agent edits reviewable. This is why the agent can be allowed to edit
  freely (e.g. `--permission-mode acceptEdits`) — the ladder, not a permission prompt, is
  the real guardrail. *(Agreed.)*
- **P3 (revised) — The thin wedge ships value before context-injection or in-chat review,
  and the minimal context seed already ships.** No-alt-tab is the headline. The agent docs
  are table stakes — and `scratchmd generate-docs` already materializes them (`AGENTS.md` +
  `CLAUDE.md` symlink + `.scratch/docs/*.md`) automatically on init/download, so v1 inherits
  a context seed for free and the work is **improving** it. Richer context (skills, sharper
  schema hints) and review-from-chat remain fast-follows. *(Revised per cold read; founder
  kept panel-first sequencing.)*
- **P4 — Wrap Claude Code, don't build a custom agent loop.** Conductor wraps Claude Code.
  The value-add is the Scratch-native surface + context, not a better agent engine. *(Agreed.)*
- **P5 — Distribution is already solved.** Electron + electron-updater auto-update on the
  `desktop` channel; ships in the next release, no new channel or install friction. *(Agreed.)*
- **P6 — v1 assumes BYO-Claude auth.** The marketer logs in with their own Claude Max/Pro;
  v1 relies on the `claude` CLI's own logged-in session. Whalesync-provisioned access is the
  deferred alternative (recent "shadow-user provisioning + session token API" and
  "Whalesync-to-Scratch direct API access" work points toward it later). *(Agreed, plain
  BYO — founder declined the "count Claude-sub penetration" assignment.)*

## Cross-Model Perspective

An independent cold read (Claude subagent; Codex was unauthenticated) reviewed the problem,
demand, wedge, and premises with fresh context:

- **Steelman:** "Cursor/Conductor for content marketers" — a packaging bet, not a
  new-systems bet, because the git review model makes an autonomous agent safe-by-construction
  and the on-disk checkout is a ready-made integration surface. The prize is turning Scratch
  from a sync tool into "the place the work happens."
- **Most revealing answer:** the context-injection complaint, not the alt-tab pain. "Shelling
  out `claude` with cwd=localPath is a weekend's work anyone can copy; the durable value is
  the curated CLAUDE.md, skills, and tool-piping that make Claude *fluent in Scratch's data
  model and review ladder*." → The wedge is the panel; the product is the context layer.
  Note: that context layer is **already partly shipped** (`scratchmd generate-docs`), which
  strengthens the bet — the moat is a thing you extend, not build from zero. (Folded into
  revised P3 + the C → north star.)
- **Riskiest premise:** P6 (BYO auth). If marketers don't already hold Claude subs, activation
  dies at "log in with your Claude account." Evidence to settle it: count how many current
  Scratch customers already pay for Claude. (Founder accepted the risk for the wedge and
  declined the assignment; flagged here for the production auth decision.)
- **48h prototype + landmine:** spawn `claude` in headless stream-json mode, reuse the
  scratchmd shell-out+IPC plumbing, right-side Mantine + `marked` panel, seed one CLAUDE.md,
  skip in-chat approval / multi-session / auth UX / cost UI / persistence. **Biggest landmine:
  PTY/streaming, not spawning** — `claude` detects non-TTY and buffers/hangs; a raw pipe
  appears to freeze or dumps everything at once. De-risk with
  `--print --output-format stream-json --verbose` and parse JSON events, never scrape terminal
  text. **Second-order:** kill the `claude` child on window-close / workbook-switch or orphan
  agents keep mutating the git repo.

## Approaches Considered

### Approach A — Thin CLI shell-out panel (minimal viable)
Reuse the `scratchmd.ts` spawn+IPC pattern. Per user message, spawn
`claude -p "<msg>" --output-format stream-json --verbose --permission-mode acceptEdits
--resume <sessionId>` with `cwd=localPath`. Parse stream-json events → render in a
right-side Mantine panel with `marked`. The existing `fs.watch`-based
`WorkspaceFileWatchService` already watches the checkout, so Claude's edits surface in the
change-review view automatically — **as long as the agent's writes are treated as *external*
mutations** (do NOT wrap them in `beginInternalWorkspaceMutation`; that guard, plus the
watcher's ~500ms debounce / ~1500ms grace, is what de-dupes Scratch's own writes from the
user's). Track and SIGTERM the `claude` child on window-close / workbook-switch — model it
on `startScratchmdLiveCommand`'s child-tracking, or orphaned agents keep mutating the repo.
- Effort: human ~3–5 days / CC ~½–1 day. Risk: Med.
- Reuses: `scratchmd.ts` spawn helpers + `startScratchmdLiveCommand` streaming/teardown
  pattern, IPC streaming, the `fs.watch`-based `WorkspaceFileWatchService`, change-review
  view, `buildAgentPrompt` + the auto-generated workspace docs, native context-menu plumbing.
- Pros: ships this week; proves the magic; near-zero new deps; literally the wedge.
- Cons: hand-rolls the streaming/session/permission glue; multi-turn bolted on via `--resume`;
  partly throwaway when moving to B.

### Approach B — Embed the Claude Agent SDK in main (ideal architecture)
Add the Claude Agent SDK to the Electron main process (configured to use the local Claude
Code subscription auth for BYO). Long-lived streaming session per workspace; structured
assistant / tool-use / permission events forwarded over IPC. Scratch owns the system prompt,
tool allowlist, and context piping — the moat (built on the already-generated `.scratch/docs`
+ `CLAUDE.md`). Same panel UI; edits still flow `WorkspaceFileWatchService` → change-review.
v1 ships with the panel + the (already auto-generated) workspace docs.
- Effort: human ~1.5–2.5 weeks / CC ~2–4 days. Risk: Med.
- Reuses: IPC streaming pattern, `WorkspaceFileWatchService` (`fs.watch`), change-review,
  auto-generated workspace docs, auth-store pattern.
- Pros: solves the streaming/session/permission landmine natively; the foundation the
  "reshape the product" bet needs; structured events make Approach C incremental, not a rewrite.
- Cons: more upfront; **must verify the SDK supports BYO Claude *subscription* auth (Max/Pro)
  rather than requiring an API key** — if it demands a key, drive the `claude` binary instead
  (hybrid A/B) to preserve P6; new main-process dependency.

### Approach C — MCP-driven Scratch action cards (creative / lateral — the 10-star)
Stand up a Scratch MCP server exposing typed tools (`list_folders`, `read_record`,
`edit_record_field`, `sync_folder`, `build_publish_plan`, `accept`, `publish`). Claude drives
Scratch through tools, not raw file edits. Each tool call renders as a Scratch-native action
card with inline approve/reject — fusing chat and the review ladder into one stream. "The
product is the context layer," made literal.
- Effort: human ~3–5 weeks / CC ~1–2 weeks (built on B). Risk: High.
- Pros: the actual differentiation; turns Scratch into "the place the work happens."
- Cons: too much for first ship; design risk around the "no connector knowledge in the
  frontend" principle — action cards must stay generic/declarative, computed server-side.

## Recommended Approach

**Spike A now → build B as v1 → C is the north star.**

Ship Approach A this week as a magic-moment spike: it proves the no-alt-tab value in days
and de-risks the real landmine (non-TTY streaming, session continuity, process lifecycle)
with the plumbing the team already knows. Then build Approach B as the v1 architecture — the
Agent SDK gives natively what A hand-rolls (streaming, multi-turn, permissions) and is the
foundation the "reshape the product" bet requires, so the moat (C) becomes incremental rather
than a rewrite. Approach C is the sequenced north star: the context layer that is hard to copy.

This honors the founder's thin-wedge instinct and the cold read's foundation argument at once.

## Open Questions

1. **BYO-subscription auth through the Agent SDK (B):** does the SDK use the user's logged-in
   Claude Code/Max session, or does it require `ANTHROPIC_API_KEY`? If the latter, B must drive
   the `claude` binary (hybrid) to keep P6 intact. Resolve before committing to B.
2. **Session continuity in A:** `claude -p` is one-shot per invocation — confirm the
   `--resume`/`--session-id` story gives a clean multi-turn chat, and where the session id is
   stored per workspace.
3. **Permission posture:** `--permission-mode acceptEdits` (or skip-permissions) leans entirely
   on the review ladder (P2). Confirm that is acceptable, and that destructive shell tools
   (if any) are constrained — file edits are safe via git, arbitrary `Bash` is not.
4. **Where the panel lives:** center pane vs. right rail vs. toggleable. Conductor puts chat in
   the center; Scratch's center is the data grid. Decide whether chat displaces or flanks it.
5. **Workspace docs content (mostly answered):** `scratchmd generate-docs` already authors
   and auto-materializes `AGENTS.md` + `CLAUDE.md` + `.scratch/docs/*.md` on init/download.
   Open part is *quality*: are the generated structure/schema/editing-data docs good enough
   for an embedded agent, do they stay in sync as connectors evolve, and what do we add to
   make Claude fluent in the review ladder (accept/approve/publish) — the C work starts here.
6. **Production auth (deferred, not v1):** if BYO penetration is low, when does
   Whalesync-provisioned access become the real v1?

## Success Criteria

- A content marketer completes a real content-edit task (chat → Claude edits records → review
  diffs → accept) **without leaving Scratch desktop** — zero alt-tabs to an external Claude app.
- The chat streams token-by-token in the panel (no freeze/dump), survives multi-turn
  conversation, and never orphans a `claude` process on window-close or workbook-switch.
- Claude's edits appear in the existing change-review view and move through the
  published→approved→local ladder unchanged (nothing auto-publishes).
- For the spike: a working demo against a real workbook within ~1 week.

## Distribution Plan

Existing deployment pipeline covers this. It ships inside `scratch-desktop`, which auto-updates
via electron-updater on the `desktop` (stable) / `desktop-test` channels from GitHub releases.
No new distribution channel, registry, or install step. The feature reaches users in the next
desktop release; gate behind a flag/test channel for staged rollout if desired.

## Dependencies

- The `claude` CLI must be present on the user's machine (BYO). Decide: detect + prompt to
  install (there is precedent — the external launcher already falls back to
  `https://claude.ai/download`), or bundle/manage it.
- Reuses `src/main/scratchmd.ts` spawn+IPC patterns (incl. `startScratchmdLiveCommand`'s
  streaming/child-teardown model), the `fs.watch`-based `WorkspaceFileWatchService`
  (`src/main/workspace-file-watch.ts`), the change-review view, `buildAgentPrompt` + the
  auto-generated workspace docs (`scratchmd generate-docs`), native context-menu plumbing,
  and the PostHog tracking conventions.
- For B: the Claude Agent SDK as a new main-process dependency.

## The Assignment

Before writing v1 code: **run the Approach A spike against one real customer workbook and sit
behind a content marketer (or screen-share) while they use it — silently.** You already have
the strongest demand signal (observed alt-tabbing); the spike's job is to surface where Claude
trips on the Scratch data model so the generated workspace docs (`.scratch/docs` / `CLAUDE.md`)
— and later the context layer / MCP tools — are shaped by real failure, not a guess. Watch for the first moment Claude does the wrong
thing with a record or schema — that moment is your Approach C backlog.

## What I noticed about how you think

- You found the moat before I asked for it. You didn't stop at "no alt-tab" — you said the
  annoying part is "telling Claude how to look at the Scratch folder data," and that Conductor
  wins by "controlling how things are piped out to the Claude command." That is the durable,
  hard-to-copy part, and you named it unprompted.
- You picked the thin wedge without flinching ("Ship it") and held panel-first sequencing even
  when the cold read argued the context layer is the real product. That is the right instinct:
  you ship to learn, not to be complete.
- You read your own commits as evidence. The auth fork (BYO vs Whalesync-provisioned) maps
  exactly onto work you're already doing ("shadow-user provisioning", "direct API access"),
  and you chose the thin BYO path deliberately rather than gold-plating v1.
- You reasoned by structural analogy — "Conductor is to engineers as this is to marketers" —
  and the analogy holds at the architecture level (git checkout, reviewable diffs, embedded
  agent), not just the vibe level. That is why this is a packaging bet and not a moonshot.
