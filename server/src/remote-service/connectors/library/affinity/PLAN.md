# Affinity connector — active plans

Forward-looking, decision-tracking doc. **Each entry is one atomic plan item with a Status** — small
enough to approve, defer, or ship on its own. Holds only **active** plans; shipped items move to
[ARCHIVE.md](./ARCHIVE.md). Coverage is in [STATE.md](./STATE.md), the activity log in
[LOG.md](./LOG.md), and the open-task checklist in
[STATE.md → TODOs](./STATE.md#todos--known-pending-tasks) — **this file does not duplicate the TODO
list**, it holds the plan bodies the substantial TODOs point at.

**Status:** `APPROVED` — greenlit, execute freely · `FOR_REVIEW` — needs a human's go-ahead before
execution; add freely, but don't act on it until approved.

Refer to items by id (P3…P6). Item ids are stable; **P1 + P2 (publishing phases 1 & 2) shipped →
ARCHIVE.md**, which is why this list starts at P3.

---

## P3 · Foreign-key reshaping for CRM relationship fields

**Status:** `FOR_REVIEW` — design decision. (The clean entity-files FKs already shipped — ARCHIVE.md.)

The relationships that matter for a CRM — a person's **company**, a deal's **owner**, a company's
**contacts** — live as **decorated objects inside field values** (`entity.fields.<id>.value.data` =
`{id, firstName, …}` or `[{id,…}]`), not as scalar columns. `x-scratch-foreign-key` needs the field
_value_ to BE the bare foreign id (Copper's `primary_contact_id: <number>`); here the id is buried in
a decorated object/array, and per the connector-build playbook arrays are leaves on the editable
path — so no annotation on the current shape yields a working FK.

A real fix is the playbook's array→keyed-object pattern:

1. On **pull**, reshape each reference field's `value.data` to surface the bare id(s) as addressable
   scalar column(s), and hang `x-scratch-foreign-key` on that.
2. On **publish**, reverse the reshape into the `{type, data:[{id}]}` write payload (the
   write-translation already builds that shape).
3. Accept the **fidelity trade-off** — this is the one sanctioned exception to storing the verbatim
   API shape (the playbook allows reshaping arrays for editability), but it changes how every
   Affinity record looks on disk and interacts with the phase-1 write path. That's why it's a
   decision, not a silent refactor.

**Why deferred:** the relationships already round-trip correctly **as values** (the live write pass
confirmed person/company/-multi edits land). FK declaration here is a linking/picker UX enhancement,
not a correctness fix — recommend pairing it with P2 if/when a customer needs FK-based linking or
sync mapping on these fields.

## P4 · Platform bug — CLI field-clears (null-sets) silently dropped by publish

**Status:** `FOR_REVIEW` — hold for discussion. **Platform-level, not Affinity-specific** (affects
every connector); surfaced during this connector's write pass.

**Symptom:** clear a field to `null`, accept→upload→publish prints "Published," but the service value
is unchanged. Only null-valued edits vanish; non-null edits in the same record publish fine.

**Root cause (two layers conspire):**

- The CLI patch dialect is **JSON merge-patch**, where `null` means _delete the key_ — so a worktree
  containing `"data": null` never converges with the stored patch (the file stays "unreviewed"
  forever; you must _remove_ the key for accept to settle).
- Even once accepted, the server's `computeChangedFields` (`server/src/publish-plan/diff-utils.ts`)
  **intentionally ignores keys removed in dirty** — and merge-patch already turned the clear into a
  key removal, so the diff is empty, the record is skipped, and it reports success.

**Why it matters:** silent data divergence. Affinity itself accepts `{type, data: null}` clears fine
(verified raw), so this is purely ours.

**Options:** (a) represent an explicit clear distinctly from key-deletion (sentinel, or JSON-Patch
`replace`-with-null) so it survives both merge-patch and `computeChangedFields`; (b) make
`computeChangedFields` treat a value that went to `null`/`""` as a real change. Likely both — the
dialect mismatch is the deeper layer.

## P5 · Platform bug — multi-folder publish commits only the first folder to `main`

**Status:** `FOR_REVIEW` — hold for discussion. **Platform-level**; surfaced here.

**Symptom:** one publish touching records in two folders (a People file + a Companies file) pushes
**both** to the service, but only the first folder gets its `Publish V2 edit batch` commit on
`main`/`dirty`. The second file stays stale on `main` while the service has the new value, its patch
lingers in `files unpublished`, and every op is marked `success`. Re-publishing the leftover patch
alone heals it.

**Where to look:** the per-folder loop in `PublishRunService.runPipeline`
(`server/src/publish-plan/publish-plan-run.service.ts`, ~line 310) and the commit step in
`dispatchUpdateBatch` (`commitFilesToBranch`, ~line 1129). Hypothesis: the second folder's commit is
computed against a base that already moved, or batches race on the same ref and one is lost.

**Next step:** reproduce minimally (two folders, one edit each, single publish) on a non-Affinity
connector to confirm it's pipeline-level, then bisect the per-folder commit path.

## P6 · Platform finding — phantom pending patches after hydrated/normalized writes

**Status:** `FOR_REVIEW` — lower urgency (no data loss, confusing UX). **Platform-level**; surfaced here.

**Symptom:** a reference write (`{id}`/`{dropdownOptionId}`) or a normalized write (date snapped to
day granularity) publishes correctly and lands in the service, but the file never leaves
`files unpublished` and a `conflicts.log` entry is written — because the service reads the value back
**hydrated/normalized** (full person object + `totalCount`, or `10:30Z` → org-tz midnight) and the
CLI's value-based re-anchor never sees the sparse user edit as incorporated.

**Why lower urgency:** the write _did_ land. Workaround: `files discard` after confirming the publish.
A real fix needs the re-anchor to compare against the connector's _returned/persisted_ shape rather
than the raw user edit — overlaps with the `UPDATE_RECORDS_RETURNS_REMOTE_DATA` flag work already in
the publish path.
