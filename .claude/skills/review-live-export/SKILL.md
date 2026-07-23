---
name: review-live-export
description: The adversarial PASS/FAIL gate for a Live Export source audited by /test-live-export. A fresh reviewer with NO build context re-proves the LIVE_EXPORT_AUDIT.md gate checkmarks against the live services — re-runs the harness on the same workbook, re-reads destination data via the destination service's own API, re-checks the CRUD/no-op claims, and audits the filed Linear issues for correct LAYER attribution (a [core] issue that is really a [view] gap is a finding). `/review-live-export <source> <dest1>[,<dest2>…]` — re-prove EVERY destination section the audit doc claims, not just one. Assume every ✅ is a lie until re-proven. A source service is not launch-ready until this returns PASS with zero real findings.
user-invocable: true
---

# review-live-export — re-prove the audit

You are the reviewer, not the author. You did not run the audit; do not trust it. Your job is to
try to **break** `server/src/remote-service/connectors/library/<source>/LIVE_EXPORT_AUDIT.md`.

Preflight is the same as /test-live-export (server, `local/audit-creds/`, Linear MCP) — run the
harness preflight and stop with the checklist if the environment isn't ready.

## What to re-prove (spot-check hard, sample broadly)

1. **Every checked gate** in the audit doc. Re-derive it from the evidence ids: fetch the routine
   runs (`GET /workbooks/:wb/routine-runs/:id?includeJobs=true`), re-read the report file, and
   where the claim is about destination data, read the destination **through its own public API**
   with the creds in `local/audit-creds/` — never through our own pull. A ✅ whose evidence you
   cannot reproduce is a finding.
2. **Fresh end-to-end run, per destination workbook**: `node tools/live-export-audit/audit.mjs --workbook <wkb> --rerun`.
   Zero publish failures expected (or exactly the filed, still-open ones). Then your OWN small
   CRUD probe via the source service API (different records than the audit used) → `--rerun` →
   verify on the destination.
3. **Second-run no-op**: trigger the routine twice with no source changes; the second publish must
   execute 0 operations (unless DEV-10556 is still open — then it must be referenced in the doc).
4. **Downgrade judgments**: for every "accepted downgrade", look at the sampled values yourself.
   If the samples show a pluckable inner value or a declarable type, the acceptance was wrong —
   finding.
5. **Layer attribution on filed issues** (this matters as much as the bugs): for each issue the
   audit filed, check the `[layer]` tag against the evidence — including the cross-destination
   differential: a `[dest-pack]` claim must NOT reproduce on the other audited destination, and an
   upstream (`[view]`/`[picker]`/`[core]`) claim should. Misattribution — especially a
   per-service View/editorialization gap dressed up as `[picker]`/`[core]`, or a proposed shared-
   code fix without a second-service reproduction — is a finding: comment the correction on the
   issue and re-tag it. The default View is the editorial layer; core fixes need cross-service
   evidence.
6. **Dedup discipline**: no issue filed for something in the known-generics list
   (DEV-10952/10953/10954/10955/10956/10957/10959/10960/10962, DEV-10556) or duplicating another
   `live-export-qa` issue.

## Verdict

Append a review section to LIVE_EXPORT_AUDIT.md:

```
## Review — <date>

Verdict: PASS | FAIL
Re-proved: <gates re-proved, with your fresh evidence ids>
Findings: <numbered; each = what the audit claimed, what you observed, layer, action taken>
Human remainder confirmed outstanding: <list>
```

FAIL if any gate's evidence didn't reproduce, any real finding surfaced, or issue layering was
materially wrong. On FAIL, file/correct issues yourself (same conventions: project
`[MAJOR] Live Export`, label `live-export-qa`, `[<SOURCE>→<DEST>][<layer>]` title), then hand back
to /test-live-export. PASS only with zero real findings — then the remaining launch steps are the
doc's "Human remainder" list.
