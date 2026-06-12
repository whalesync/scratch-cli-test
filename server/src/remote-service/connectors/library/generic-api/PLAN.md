# GENERIC_API connector — improvement plans

Connector-wide improvement plans promoted from per-service coverage docs (`coverage/<service>.md`) through the **generality gate**. Only **GENERAL** candidates live here — gaps expected to recur across a meaningful share of services. Service-specific quirks stay declared UNSUPPORTED in their coverage doc and never reach this file.

Flow (same as `/connector-build`): a candidate enters as `FOR_REVIEW`. A human approves → `APPROVED` → built → moved to `ARCHIVE.md`. **Every item leads with a concrete before/after example**; the prose is secondary.

Status: `FOR_REVIEW` (awaiting human) · `APPROVED` (build it) · `BLOCKED`.

---

## 1. CLI can set up GENERIC_API connections & tables (run the probe server-side)
**Status:** `FOR_REVIEW` · **Source:** `coverage/companycam.md` (2026-06-12) · **Generality:** every generic-connector CLI user, every service.

**Here is what happens now:**

Creating a generic table from the CLI fails — the create path never runs the probe the connector needs:

```
$ scratchmd linked add --connection-id coa_XXX \
    --table-id "GET,https://api.companycam.com/v2/projects?page=1&per_page=100" --name Projects
Error: Server error (500): Generic API error: Endpoint
  "GET,https://api.companycam.com/v2/projects?page=1&per_page=100" has not been
  probed yet. Re-pick this endpoint from the table picker to run the probe.
```

Connection-create has the sibling gap: `scratchmd connections create` drops `extras`, so a generic connection can't be made from the CLI at all. Net effect: **the generic connector is web-UI-only for setup.** This test had to work around both — POST the connection to the web `…/connections` endpoint by hand, then POST `data-folder/create` with a manually-fetched `probe` object in `options.genericApi`.

**Here is what will happen after the fix:**

The CLI does the two-step (probe → create-with-probe) server-side, so the same command just works:

```
$ scratchmd linked add --connection-id coa_XXX \
    --table-id "GET,https://api.companycam.com/v2/projects?page=1&per_page=100" --name Projects
Linked "Projects" (dfd_XXX): probed page 1 (1 record) + page 2 (0) — pagination=page, idPath=id.
```

and `scratchmd connections create --service GENERIC_API --extras @extras.json` persists `extras` instead of dropping them.

**Why it's GENERAL (not service-specific):** nothing here touches CompanyCam — it's the generic connector's CLI setup path. Any service tested or used via the CLI hits it. It's the difference between "generic connector is scriptable" and "generic connector is click-only."

**Open question for the reviewer:** is web-only setup an intentional v1 boundary (the web probe is interactive — it shows "fetched N from page 1…" and lets the user confirm idPath drift)? If so, a CLI equivalent needs a non-interactive default (auto-accept the probe) plus a `--show-probe` to print what it detected. Scope: `cli-linked.controller.ts createLinkedTable` + the connections-create DTO/handler; reuse the existing `probeEndpointForTable`.

---

## ARCHIVE
Implemented items move to [`ARCHIVE.md`](./ARCHIVE.md). (none yet)
