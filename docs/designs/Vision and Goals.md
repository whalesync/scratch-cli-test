# Scratch: Vision & Goals

## Problem: AI Anxiety gap

Agents and AI can now edit data at scale — rewrite 500 product descriptions, reclassify a whole catalog, update every listing in a database. But that data is often **live, public, or high-value**, and the edits are **untrustworthy by default**. Nobody wants to push 500 AI-written descriptions straight to their Shopify storefront without reviewing them first.

Scratch exists to close that gap: give users the confidence to actually **publish** what AI produces, by making the review step fast, clear, and safe.

## Solution: Core Loop

Everything in Scratch serves this loop:

**Ingest:** Connect to a source of truth (Shopify, Airtable, etc.) and pull data into a local sandbox where agents can work without breaking production.

**Edit → Review → Repeat** (this is where users live):

- **Edit:** An agent makes changes — rewrites, reclassifications, bulk updates.
- **Review:** The user reviews the diff, batch-approving or tweaking the agent's work.
- Repeat until confident. This loop should be fast enough to run many times, not once.

**Publish:** Push the verified data back to the source of truth.

## Examples

**SEO overhaul for a Shopify catalog.** You have 400 products on Shopify and the titles and descriptions are terrible for search. Today you'd either rewrite them one-by-one in the Shopify admin (takes a week), or dump them into a spreadsheet, run them through ChatGPT, and bulk-import the CSV back — praying nothing breaks and with no way to review what actually changed before it goes live on your storefront.

With Scratch: Ingest your Shopify catalog. Point an agent at the titles and descriptions with a prompt like "rewrite for SEO, keep the brand voice." The agent rewrites all 400. You review the diff — original title vs new title, side by side, for every product. A few are off, you flag them, the agent takes another pass. Once you're confident, you publish and 400 products get updated.

**Merging scraped LinkedIn data into HubSpot.** Your sales team scraped 2,000 LinkedIn profiles and you need to merge them into your HubSpot CRM — matching against existing contacts, filling in missing fields, and flagging duplicates. Today this is a nightmare of spreadsheet VLOOKUPs, manual deduplication, and a terrifying CSV import where you find out what went wrong after it's already in your CRM.

With Scratch: Ingest your HubSpot contacts as the source of truth. Import the LinkedIn CSV as a set of proposed changes. An agent matches records, merges fields, and flags conflicts. You review the diff — which contacts are new, which are updates, which are duplicates the agent resolved. You adjust the ones that look wrong, run another review pass, and publish when you're confident.

## Pillars

1. **Confidence to publish is Job 0** — Our users are pointing AI at data they're nervous about: public storefronts, live databases, high-stakes content. The reason they need Scratch is that they don't trust the output enough to publish it directly. Everything we build should increase the user's confidence that what's about to go live is correct. If a user hesitates at the publish button, we've failed.

2. **The edit→review loop is the product** — Users spend their time in a tight cycle: make changes (or have an agent make changes), review the diff, adjust, repeat. This loop needs to be fast enough to run many times — not a single pass. Sometimes the user is driving the edits manually, sometimes an agent is proposing changes and the user is reviewing, sometimes the agent is doing automated review passes on its own. All of these are the same loop, and it needs to be tight in all cases.

3. **Humans judge, not author** — Scratch is not a manual data editor. It's not an unattended sync tool (that's Whalesync core). Scratch is for **large-scale automated edits that require human review before publish**. The editing is done by agents, AI, or other automated tools (like syncs). The human's job is to review, adjust, and approve. Features that don't serve this workflow are out of scope.

## Platform split (desktop vs web)

The core loop is between the agent and the review, so they need to be next to each other. The best part of the Scratch prototype last summer was the tight loop between the agent and data, next to each other in the browser. Now that we are focusing on 3rd party agents, operating on disk, the review needs to be there too.

- The primary experience is Desktop. A "Power Editor", with high performance, local file access, so the human and agent can hit flow state while doing the heavy lifting.

- The web is a secondary experience for future non-core features that need it, for example: automated jobs, team sharing, or lightweight final sign-off approvals for hands-off stakeholders. This doesn't mean we can't use our servers for branches, publishing, and other places that it's convenient, appropriate, or we already have written.

## What's out

- Our own agent. We integrate with them, we don't build our own.
- Rich manual editing or data entry. The editing focus is always in the context of reviewing changes.
- Ongoing live syncing. That's whalesync. We can build toward it, but it's an emergent feature, not day 1 selling point.
- Web based editing scenario. It's not part of the core loop.
- Real-time multi-user scenarios. A workspace can share connections, credentials and data hubs, but the editing experience is solo.
