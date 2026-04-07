# Scratch: Future Milestone Ideas

A running list of things explicitly deferred from the Scratch Desktop milestone. Collected during planning so nothing gets lost.

## Agent Integration
- Embedded agent / chat UI inside the desktop app
- Local API for structured agent access (agents call an API to read/write records instead of editing files)
- Automated feedback loops back to the agent (validation results fed back so the agent can self-correct)
- "Advertising to agents" — MCP server, tool descriptions, so agents can discover and use Scratch programmatically
- "Open in Claude" / "Open in Codex" toolbar shortcuts (depends on those tools supporting directory-based working)

## Diff Viewer & Review
- AI-generated summary of all changes ("The agent rewrote 342 descriptions, focusing on SEO keywords and shorter titles")
- Grouping changes by type / pattern ("285 records had title shortened, 57 had description completely rewritten")
- Confidence scoring per change
- Comparison stats (average description length before/after, etc.)
- Flagging outliers (changes that look very different from the rest)

## Validation
- Improved validators beyond mechanical schema checks
- Automated fixing of validation errors
- User-defined validation rules
- Deeper schema enforcement

## Connectors
- Google Sheets URL download connector
- Shopify connector (pending approvals — can demo but can't ship to real users yet)
- New connector types in general (ship Scratch Desktop with what we have)
- Let user set record file format when folder is linked (currently always JSON). Markdown with YAML frontmatter is the most interesting alternative — more readable by humans and agents, separates structured fields from long-form content naturally.

## Sync & Automation
- Ongoing live syncing (that's Whalesync core — could build toward it but not a Scratch Desktop selling point)
- Client-side sync execution (currently server-only, could move to client in future)
- Scheduled pulls, publishes, and syncs from the desktop app
- Automated/recurring agent jobs

## Web App
- Team dashboard (who's working on what)
- Automated job config and monitoring
- Lightweight web-based review/approval for stakeholders without the desktop app
- Stakeholder review flow (e.g. CEO sign-off before publish — share a review link, they approve/reject without needing the desktop app)
- Shared review links — push sends work to the server, generates a URL anyone can open in a browser to see the diff, approve/reject, and publish. No install needed. This is the viral loop: the link is the pitch. Agency sends a client a review link; intern sends their boss a review link. The gatekeeper sees value before they understand the product.

## Desktop App
- Connection management natively in desktop (OAuth flows, create/edit connectors without redirect to web)
- User-configurable local workspace path (currently fixed at ~/Documents/Scratch/{workspace name}/)
- Multi-user / real-time collaboration (workspace can share connections and data, but editing is solo for now)
- Rollback / undo after publish — open a previous snapshot, push it as a reverse diff, review and publish. Every pull and every publish already takes a snapshot, so rollback is the same flow pointed at different files. Makes experimentation cheap ("let's see if shorter descriptions convert better" becomes a real experiment with a known undo).
- Audit trail / changelog — every publish automatically records what changed, when, who approved it, and what validation rules were in place. Queryable later ("what happened to that landing page?" or "did we change anything that could explain that signup drop?").
- Offline mode (local-only editing with sync-when-reconnected)


## Diff Viewer: Future Summary Features

The diff viewer needs deeper summary capabilities beyond this milestone. Collecting ideas here for future work:

- AI-generated summary of all changes ("The agent rewrote 342 product descriptions, focusing on adding SEO keywords and shortening titles")
- Grouping changes by type / pattern (e.g., "285 records had title shortened, 57 had description completely rewritten")
- Confidence scoring per change
- Comparison stats (average description length before/after, etc.)
- Flagging outliers (changes that look very different from the pattern)
