---
name: create-postmortem
description: Scaffold a new incident postmortem document in docs/ops/postmortems. Use when the user asks to create an Incident Report or Postmortem.
user-invocable: true
allowed-tools:
  - Read(docs/ops/postmortems/**)
  - Write(docs/ops/postmortems/**)
  - AskUserQuestion
---

## Context

Incident postmortems for Scratch live in [docs/ops/postmortems/](../../../docs/ops/postmortems/). Each file is named `YYYY-MM-DD-<kebab-case-slug>.md` where the date is the day the incident started. Use existing postmortems in that folder as reference for tone, structure, and level of detail.

## Your task

Gather the inputs below, then write a new postmortem file using the template in this skill. The goal is a skeleton the user can finish filling in — do not fabricate timeline events, root causes, or action items.

### Inputs to collect

Evaluate the user's request first. If any of the following are already stated clearly, use them directly. For anything missing, ask the user with a single `AskUserQuestion` call batching all unknown fields:

1. **Summary** — one or two sentences describing what happened.
2. **Start time** — when the incident started (date and time, include timezone if known).
3. **Current severity** — e.g. `Low`, `Medium`, `High`, `Critical`. Include a short qualifier if given (e.g. `High — all users impacted`).
4. **Environment** — e.g. `Production`, `spv1eu-production`, `Staging`, `Development`.
5. **Scope of impact** — who/what is affected (e.g. `All users`, `EU customers only`, `Internal tools`, `Single workbook`).

If the user answers "I don't know" (or equivalent) for any field, fill that field with the placeholder `TBD`. Never guess.

### Derive the filename

- **Date** — use the incident start date in `YYYY-MM-DD` format. If start date is `TBD`, use today's date.
- **Slug** — derive a short kebab-case slug from the summary (e.g. `scratch-git-unresponsive-prod-outage`). If the summary is `TBD`, use `incident`.
- **Path** — `docs/ops/postmortems/<date>-<slug>.md`.

Before writing, check whether the target path already exists. If it does, append a short disambiguator (`-2`, `-3`, ...) rather than overwriting.

### Template

Write the file with exactly this structure, substituting the collected inputs. Leave all other sections as placeholders for the user to complete.

```markdown
# Postmortem: <short title derived from summary, or TBD>

**Date:** <YYYY-MM-DD or TBD>
**Duration:** TBD
**Severity:** <severity or TBD>
**Environment:** <environment or TBD>
**Service:** TBD

## Summary

<summary or TBD>

## Timeline (<timezone or TBD>)

| Time          | Event |
| ------------- | ----- |
| <start time>  | Incident began |
| TBD           | TBD   |

## Root Cause

TBD

## Investigation

- TBD

## Impact

- **Scope:** <scope or TBD>
- **User experience:** TBD

## Resolution

1. TBD

## Action Items

- [ ] TBD

## Lessons Learned

- TBD
```

### After writing

1. Report the created file path to the user as a clickable link.
2. List which fields are still `TBD` so the user knows what to fill in next.
3. Offer to help fill in any remaining sections (timeline, root cause, action items) if the user wants to continue.

## Important guidelines

- **Do not invent facts.** Only populate fields the user has supplied. Everything else stays as `TBD`.
- **Do not run `gcloud` or fetch production data** while scaffolding — this is a document-creation task only.
- **Batch the prompts.** Use a single `AskUserQuestion` call for all missing fields rather than asking one at a time.
- **Preserve existing postmortems.** Never overwrite an existing file; disambiguate the filename instead.
- **Match existing style.** Headings, bold field labels, and the pipe-table timeline format should match the conventions in existing postmortems.
