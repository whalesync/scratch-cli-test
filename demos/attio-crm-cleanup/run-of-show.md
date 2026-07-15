# Run of show — Attio CRM cleanup demo (enrich + merge duplicates)

**Audience:** a RevOps lead / CRM admin whose Attio (or any CRM) is full of blanks and
duplicate companies — and who dreads merging dupes because every duplicate drags a tail of
contacts and deals that have to be moved by hand.
**The wow:** Scratch + Claude clean the whole CRM at once — fill in the missing data, then
**find and merge the duplicate companies *including* every contact and deal attached to them** —
reviewed, then published back into the live Attio workspace.
**Length:** ~6–8 minutes. **Surface:** Scratch Desktop (live), Attio (to prove it landed).

> One-line pitch to open with: *"Everyone's CRM has the same two problems: half the fields are
> blank, and the same company is in there three times. Watch me fix both across the whole
> database in about three minutes — and merge the duplicates without orphaning a single contact."*

---

## Pre-call checklist (do ~5 min before)

1. **Reset to baseline** (from the repo root):
   ```bash
   node demos/attio-crm-cleanup/ready.ts
   ```
   Rebuilds the Attio service to the flawed baseline **and** re-pulls the Scratch workbook.
   Expect: `Created 37 companies / 17 people / 10 deals`, workbook re-pulled.
   *(Service-only, if the stack isn't up: `DEMO_SKIP_WORKBOOK_RESET=1 node demos/attio-crm-cleanup/ready.ts`.)*
2. **Open Scratch Desktop** → workbook **"Attio CRM Cleanup Demo"** → open the **Companies** folder.
   Confirm the blanks (empty **Industry / Categories** column) and the obvious duplicates
   (`Kyoto Robotics` / `KYOTO ROBOTICS` / `Kyoto Robotics Inc.`).
3. **Have the fallback ready** (see "If something goes wrong"): know the re-prompts and the
   pre-approved patch set (T2.7).
4. Close noisy apps / notifications. Zoom the Desktop font up a notch so the grid + diffs read on a share.

---

## The arc

### 1 — Frame the pain (0:00–0:45)
**Say:** "This is a CRM with ~40 companies. Two problems every RevOps person knows: the data's
half-empty — no industry, no location — and there are **duplicates**. Same company entered two
or three times with slightly different names. And the reason nobody cleans up the dupes is that
each one has **contacts and deals hanging off it** — merge them wrong and you silently orphan a
live deal."

**Do:** In the Companies grid, point at the empty **Industry** column, then scroll to a duplicate
cluster (Kyoto Robotics ×3). Open one loser variant and show it has a contact + a deal attached.

### 2 — Enrich the blanks (warm-up) (0:45–2:00)
**Do:** Open the Claude chat in Scratch Desktop. Type the enrich prompt (verbatim below).

> **Enrich prompt:**
> *"For every company, fill in the **Industry** (the categories field) based on the company's
> name and domain — pick the closest value from the allowed list. Also set the company's
> **location** (country and city) where the domain makes it clear. Leave a field blank only if
> you genuinely can't tell."*

**Say (while it works):** "It's reading every company and filling in the industry from the name
and domain — across the whole list at once. Nothing's live yet; these are proposed edits."

**Do:** Show the Industry column filling in top to bottom (Lyon Biotech → Biotechnology, Oslo
Maritime → Maritime, …). This is the bulk-win visual.

### 3 — Merge duplicates: show ONE in detail (the trust beat) (2:00–4:30)
This is the hero. Pick the **Kyoto Robotics** cluster.

**Do:** Type the merge prompt (verbatim below).

> **Merge prompt:**
> *"Find companies that are duplicates of each other — the same real company entered more than
> once with a different name (e.g. 'Kyoto Robotics' vs 'KYOTO ROBOTICS'). For each duplicate set:
> pick the best record to keep (the one with a domain) as the survivor; copy any field the
> survivor is missing (headcount, funding, founded date) from the other copies into it; **repoint
> every Person and Deal that references one of the duplicates so it references the survivor
> instead**; then delete the duplicate records. Don't merge companies that are actually
> different."*

**Say (this is the line that lands):** "Watch what it did with the duplicates. It kept the good
record, and — this is the part you can't do by hand without missing one — it **moved every
contact and every deal off the junk copies onto the survivor**, then deleted the copies. If you
just deleted the duplicates in Attio directly, all of those contacts and deals would go blank.
Scratch rewires them first."

**Do:** Open the survivor **Kyoto Robotics** and show: it now has the `employee_range` and
founded-date that were stranded on the copies; **Hiroshi Tanaka** and **Yuki Sato** (the
contacts) now point at it; the **Automation Rollout** deal now points at it. Then show the two
duplicate rows are staged for deletion.

### 4 — Scale: show the aggregate (4:30–5:15)
**Do:** Step back to the changed-records view. Show the magnitude: **10 duplicate clusters merged,
~12 duplicate companies removed, every attached contact and deal repointed, and industry filled
across all ~40 companies** — one review pass.

**Say:** "One pass, the whole CRM cleaned. And nothing's live yet — every edit, every repoint,
every delete is a proposed change I get to approve or reject first."

### 5 — Publish back to Attio (5:15–6:00)
**Do:** Accept the changes and **Publish**. (This is *your* click in Desktop — Scratch never
publishes on its own.) Note that even the **deletes** are approved, not automatic.

**Say:** "Approved changes go straight back into Attio — the enriched fields, the repointed
contacts and deals, and the duplicate deletions. No CSV export, no manual merge, no re-import."

### 6 — Prove it landed (6:00–7:00)
**Do (the money shot):** open **Attio** in the browser → the **Kyoto Robotics** record. Show its
Industry is now set, its headcount is filled, and its **Contacts** and **Deals** tabs now list
Hiroshi, Yuki, and the Automation Rollout deal — and the duplicate `KYOTO ROBOTICS` /
`Kyoto Robotics Inc.` records are gone.

**Close:** "From a CRM full of blanks and duplicates to clean, enriched, de-duplicated data with
every relationship preserved — reviewed and live, in the time we've been talking. That's any bulk
CRM change: enrichment, normalization, re-segmentation, a migration cleanup. You describe it,
review it, ship it."

---

## If something goes wrong (fallback ladder)

1. **AI is slow (>~60s):** narrate the value while it runs; it's usually fine. Don't fill silence with apology.
2. **Merge misses a contact/deal (a loser's dependent didn't get repointed):** re-prompt:
   *"You deleted a duplicate but left a contact or deal pointing at it — find every Person and Deal
   still referencing a deleted or duplicate company and repoint it to the survivor."* (This is the
   one correctness risk: the merge is only right if EVERY dependent of a deleted duplicate is repointed.)
3. **AI merges two companies that are actually different:** re-prompt: *"Undo that merge — those
   are different companies. Only merge records that are clearly the same company."*
4. **Wrong industry values:** re-prompt: *"Use only values from the allowed categories list; fix the ones that aren't in it."*
5. **AI errors / refuses / total miss:** fall back to the **pre-approved patch set** (plan T2.7):
   apply the known-good enrich + merge edits, then review + publish as normal. Audience still sees
   the review-and-publish wow, just not live generation.
   > ⚠️ T2.7 isn't built yet — build it before relying on this for a high-stakes call.

---

## Setup notes & known caveats (read before your first live run)

- **Enrich the *industry* (categories) — it's the reliable field.** Attio does a sparse server-side
  auto-fill of **country** from some domains' ccTLD (observed on ~1 of 37 at seed), so lead the
  enrich beat with **Industry**, which Attio never auto-fills, and treat location as a bonus.
- **Shared workspace noise.** The demo seeds into the shared **integration-test** Attio workspace,
  which also holds ~18 pre-existing companies/people/deals. Those appear in the grid alongside the
  demo data. Work within the demo clusters (the `*-survivor` / drifted-name companies) and don't run
  "merge ALL duplicates" blind. **For a polished call, provision a dedicated demo Attio workspace +
  token** and point `ATTIO_API_KEY` at it (the seed/reset are already scoped by name, so they're safe
  either way).
- **Desktop grid legibility (verify once).** Confirm in Scratch **Desktop** that the Companies grid
  renders cleanly — Industry/Location as readable values, and the People/Deals **company** columns
  showing the referenced company **name** (not a raw id). Run `/qa-desktop-app` against the seeded
  workbook to check before a real call.

---

## After the call

Reset for the next demo:
```bash
node demos/attio-crm-cleanup/ready.ts
```

---

## Appendix — cluster map (so you can narrate the merges confidently)

The seed is **10 duplicate clusters** + 15 standalone companies. Each cluster's **survivor** holds
the domain; the drifted-name **losers** hold the strays (headcount / funding / founded date) and the
attached contacts + deals. Merging collapses each cluster to its survivor.

| Cluster (survivor) | Duplicate names | Stray on loser | Attached contacts | Attached deal |
|---|---|---|---|---|
| **Kyoto Robotics** (JP, Automation) | KYOTO ROBOTICS · Kyoto Robotics Inc. | 251-1K headcount · founded 2014 | Hiroshi Tanaka, Yuki Sato | Automation Rollout ($85k) |
| **Lyon Biotech** (FR, Biotechnology) | Lyon Biotech SA | $12M funding | Camille Laurent | Platform License ($42k) |
| **Oslo Maritime** (NO, Maritime) | Oslo Maritime AS | 51-250 headcount | Erik Johansen | — |
| **Berlin Analytics** (DE, SaaS) | Berlin Analytics GmbH | 11-50 headcount | Anna Müller, Jonas Weber | Analytics Suite ($60k) |
| **Austin Coffee Roasters** (US, Beverages) | Austin Coffee Roasters, Inc. · Austin Coffee | founded 2015 · 11-50 headcount | Sarah Mitchell, Diego Ramirez | Wholesale Supply ($15k) |
| **Toronto Fintech** (CA, Financial Services) | Toronto Fintech Inc | 1K-5K headcount | Priya Patel | Compliance Module ($120k) |
| **Madrid Solar** (ES, Renewables) | Madrid Solar S.L. | 51-250 headcount | Mateo García | — |
| **Sydney Health** (AU, Health Care) | SYDNEY HEALTH | 251-1K headcount | Olivia Brown | EHR Integration ($95k) |
| **Amsterdam Logistics** (NL, Shipping & Logistics) | Amsterdam Logistics BV | 1K-5K headcount | Lars de Vries | Route Optimization ($70k) |
| **Dublin Games** (IE, Video Games) | Dublin Games Ltd | 11-50 headcount | Aoife Kelly | — |

Use **Kyoto Robotics** for the detail beat — it's the richest (two duplicates, two contacts, a
deal, and two different stray fields to combine).
