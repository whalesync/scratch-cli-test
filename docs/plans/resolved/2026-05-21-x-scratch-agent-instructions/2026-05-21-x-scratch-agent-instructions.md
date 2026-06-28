# `x-scratch-agent-instructions` — agent-targeted hints in connector schemas

**Date**: 2026-05-21
**Author**: Chris Hoefgen
**Status**: Proposed
**Scope**: Microfeature — single new JSON Schema annotation, opt-in per connector.

## Contents

- [Problem](#problem)
- [Goal](#goal)
- [Non-goals](#non-goals)
- [Design](#design)
- [Where the annotation surfaces to agents](#where-the-annotation-surfaces-to-agents)
- [Authoring guidance for connector developers](#authoring-guidance-for-connector-developers)
- [Implementation steps](#implementation-steps)
- [First usage — Intercom](#first-usage--intercom)
- [Testing](#testing)
- [Risks and open questions](#risks-and-open-questions)
- [Done when](#done-when)

## Problem

Agents working in a Scratch workspace (Claude / Gemini, invoked through the [scratchmd CLI](../../scratch-git-2/src/cli/) or the desktop app) read each table's [`schema.json`](../../scratch-git-2/src/cli/commands/generate_docs.rs#L151) to understand record structure before editing. The JSON Schema fields plus existing `x-scratch-*` extensions ([packages/shared-types/src/connector/json-schema.ts](../../packages/shared-types/src/connector/json-schema.ts)) tell agents the _shape_ and _mutability_ of every field, but not the _human-interpretive context_ — which values matter, which sub-types are noise, what soft relationships exist between fields.

Example: [`intercom-json-schema.ts:164-175`](../../server/src/remote-service/connectors/library/intercom/intercom-json-schema.ts#L164-L175) describes `conversation_parts[].part_type` as `"Part type (comment, note, etc.)"`. Today an agent has no way to know that of the ~15 possible part_type values, only `comment`, `note`, and `open` carry user-meaningful content; the rest are system events that an agent should usually ignore when summarizing or editing. Similarly for `authorSchema.type`: `user`, `admin`, and `bot` are all valid, but `bot` is rarely what the user cares about.

These hints live in connector authors' heads. We want a place to write them down once, scoped to the field or object they describe, so every agent invocation gets them for free.

## Goal

Introduce a new optional JSON Schema annotation `x-scratch-agent-instructions: string` that:

- can be attached to any field or object schema by a connector author,
- is plain text, written _for_ agents (not end-user docs, not UI labels),
- is propagated unmodified through the existing pull-and-write path into the on-disk `schema.json`,
- is documented in [`generate_docs.rs`'s `SCHEMA_DOC`](../../scratch-git-2/src/cli/commands/generate_docs.rs#L154) so the agent reading the workspace knows to look for it.

## Non-goals

- **Not a replacement for `description`.** `description` is for everyone (humans in the UI, OpenAPI consumers, agents). `x-scratch-agent-instructions` is for cases where agent-specific framing would clutter or confuse a human-facing description.
- **No new UI surface.** The annotation is invisible in the client/desktop schema-driven views.
- **No translation / localization.** English only.
- **No runtime validation behavior.** Unlike `x-scratch-readonly`, this annotation never affects publish, validation, or sync logic. It is purely informational.
- **No retrofit pass across all connectors.** This change ships the mechanism plus Intercom as the first consumer. Other connectors can adopt later, ad hoc, when an author notices an agent-friendly hint worth writing.

## Design

### Annotation key

Add to [`packages/shared-types/src/connector/json-schema.ts`](../../packages/shared-types/src/connector/json-schema.ts), following the existing pattern:

```ts
// A plain-text hint targeted at AI agents (Claude, Gemini, etc.) that read
// schema.json before editing records. Use sparingly — only when a non-obvious
// structural or semantic detail would change how an agent interprets a field
// or object. Not surfaced in any human-facing UI. See docs/plans/resolved/2026-05-21-x-scratch-agent-instructions/2026-05-21-x-scratch-agent-instructions.md.
export const X_SCRATCH_AGENT_INSTRUCTIONS = "x-scratch-agent-instructions";
```

The value is always a `string`. No object form, no per-locale variants — keeping the shape minimal makes adoption cheap and avoids a schema-design rabbit hole on a microfeature.

The constant is automatically re-exported from `@spinner/shared-types` via [`packages/shared-types/src/connector/index.ts`](../../packages/shared-types/src/connector/index.ts) (no edit needed — it already does `export * from './json-schema'`).

### Propagation path (no code changes needed)

The annotation rides for free on the existing pull pipeline:

1. Connector authors attach `[X_SCRATCH_AGENT_INSTRUCTIONS]: '...'` to a TypeBox `Type.Object` / `Type.String` / etc. options bag.
2. TypeBox preserves arbitrary string-keyed extensions on the emitted JSON schema.
3. The server stores the schema as part of the `BaseJsonTableSpec` and serves it through the same endpoints the CLI uses to populate `.scratch/connections/.../{table}/schema.json`.
4. Agents reading the workspace see the annotation alongside `description` and the other `x-scratch-*` keys.

No serializer, no transformer, no validation code needs to know about the key. The single integration point is the docs file (next section) so the agent knows what the key _means_.

### Agent-facing documentation

Extend [`scratch-git-2/src/cli/commands/generate_docs.rs`'s `SCHEMA_DOC`](../../scratch-git-2/src/cli/commands/generate_docs.rs#L160) bullet list:

```diff
 The schema is written using JSON Schema notation, with some important extensions:
 - x-scratch-readonly: indicates the field's data MUST NOT be modified.
 - x-scratch-connector-data-type: the service-specific type for the field, use only for context
+- x-scratch-agent-instructions: a plain-text hint written for you (the agent). When present,
+  read it carefully — it explains a non-obvious structural detail, a soft relationship between
+  fields, or which sub-values are user-relevant vs. noise. Treat it as authoritative guidance
+  from the connector author about how to interpret this field or object.
```

This doc is regenerated into every workspace via [`scratchmd workspaces init`](../../scratch-git-2/src/cli/commands/workspaces.rs) so the explanation lands wherever the schema does.

## Where the annotation surfaces to agents

| Surface           | How the agent sees it                                                                                                                                                       |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **scratchmd CLI** | `.scratch/connections/.../{table}/schema.json` written on init/pull. Agent reads this file directly before editing records.                                                 |
| **Desktop app**   | Same on-disk `schema.json` (the desktop renders schemas through the same workspace files since DEV-10144 slice F).                                                          |
| **Server REST**   | Already exposed via the connector schema endpoints — any future MCP server or API client gets the annotation alongside `description`.                                       |
| **Client UI**     | Ignored. Mantine schema renderers (see [`client/src/app/components/UI_SYSTEM.md`](../../../../client/src/app/components/UI_SYSTEM.md)) do not consult unknown `x-scratch-*` keys. |

No new endpoint, no new RPC. The annotation flows through the same pipe as `description`.

## Authoring guidance for connector developers

Add a short paragraph to [`server/src/remote-service/connectors/CONNECTOR_GUIDE.md`](../../../../server/src/remote-service/connectors/CONNECTOR_GUIDE.md) under the schema-extensions area:

> **`x-scratch-agent-instructions` (optional, sparing use).** A plain-text hint that an LLM agent will read when working with this field or object. Reach for it when a connector quirk would otherwise mislead an agent — e.g. an enum where only a subset of values matter, a soft relationship between two fields that isn't expressible in JSON Schema, or a parent/child convention that isn't obvious from the structure. Do not duplicate `description`; do not write end-user docs here. If you're not sure whether to add one, don't — the absence of an instruction is the common case.

Concrete examples of _good_ uses, drawn from the first batch:

- "For most users only `comment`, `note`, and `open` part_types are valuable; other values represent system events you can usually skip when summarizing or editing." (on Intercom `conversation_parts[].part_type`)
- "`bot` author types are rarely user-relevant — prefer `user` and `admin` authors when picking representative messages." (on Intercom `authorSchema`)
- "Even though `parent_id` is nullable, a null value means the collection is top-level — it is not 'unknown'." (hypothetical — on Intercom Collections `parent_id`)

Examples of _bad_ uses (these should be `description` instead, or omitted):

- "The article's title." — that's a `description`.
- "Must be a non-empty string of up to 255 characters." — that's a validator + `maxLength` + `x-scratch-max-length`.
- "Added in v3 of the Intercom API." — irrelevant runtime trivia.

## Implementation steps

1. **Add the constant** in [`packages/shared-types/src/connector/json-schema.ts`](../../packages/shared-types/src/connector/json-schema.ts).
2. **Document the annotation for agents** in [`scratch-git-2/src/cli/commands/generate_docs.rs`](../../scratch-git-2/src/cli/commands/generate_docs.rs) under `SCHEMA_DOC`.
3. **Document the annotation for connector authors** in [`server/src/remote-service/connectors/CONNECTOR_GUIDE.md`](../../../../server/src/remote-service/connectors/CONNECTOR_GUIDE.md).
4. **Apply the first two annotations** in [`server/src/remote-service/connectors/library/intercom/intercom-json-schema.ts`](../../server/src/remote-service/connectors/library/intercom/intercom-json-schema.ts):
   - on `conversationPartSchema` (object-level) explaining the `comment` / `note` / `open` priority among `part_type` values,
   - on `authorSchema` (object-level) explaining the `user` / `admin` vs `bot` priority.
5. **Verify** with `yarn build` + `yarn lint` from the repo root, plus `cargo fmt` + `cargo build --bin scratchmd` from `scratch-git-2/`.
6. **Move this plan to `docs/plans/resolved/`** once shipped.

No migration, no flag, no rollout: the annotation is invisible to every consumer that doesn't explicitly look for it.

## First usage — Intercom

Concrete edits in [`intercom-json-schema.ts`](../../server/src/remote-service/connectors/library/intercom/intercom-json-schema.ts):

```ts
const authorSchema = Type.Object(
  {
    /* …existing fields… */
  },
  {
    [X_SCRATCH_READONLY]: true,
    [X_SCRATCH_AGENT_INSTRUCTIONS]:
      'Author `type` is one of "user", "admin", or "bot". "user" and "admin" represent ' +
      'human participants and are almost always what matters; "bot" entries come from ' +
      "automated flows and are usually safe to skip when summarizing a conversation or " +
      "picking a representative message.",
  },
);

const conversationPartSchema = Type.Object(
  {
    /* …existing fields… */
  },
  {
    [X_SCRATCH_READONLY]: true,
    [X_SCRATCH_AGENT_INSTRUCTIONS]:
      "Conversation parts represent many event types (assignment changes, tag updates, " +
      'notes, replies, etc.). For most user-facing work, only `part_type` values "comment", ' +
      '"note", and "open" carry meaningful body content — others are system events you ' +
      "can usually skip when reading or editing a thread.",
  },
);
```

Both placements are at the _object_ level rather than the `part_type` / `type` _field_ level, because the hint is about how to interpret the surrounding record, not just one field. Field-level placement is fine when the hint is scoped to a single value (e.g. the hypothetical Collections `parent_id` example above).

## Testing

No new automated tests. Agent-instruction strings are human-authored, human-reviewed, and changed very infrequently — assertions on their presence would just duplicate code review without catching real regressions. The annotation has zero runtime behavior, so there is also nothing to integration-test. `yarn build` + `yarn lint` is sufficient to confirm the new constant compiles and the Intercom schema still typechecks.

## Risks and open questions

- **Risk: scope creep into a "metadata for everything" key.** Mitigation: the connector-guide paragraph explicitly says _sparing use_, and reviewers should push back on PRs that add agent-instructions on every field. If we see the key spreading, we should revisit and maybe split it into typed sub-fields.
- **Risk: stale instructions.** Hints written today may not match how an agent actually behaves in six months. Mitigation: same as any code comment — the connector author owns keeping it accurate. The annotation lives next to the schema it describes, which makes drift visible during normal connector edits.
- **Risk: prompt-injection vector.** The string lands in agent context verbatim, so a malicious connector author could in theory steer an agent. This is the same trust boundary we already accept for every other field in the schema (a malicious `description` is just as effective) — no additional mitigation needed beyond the existing code-review on connector changes.
- **Open: do we want a length cap?** Not enforcing one today. If hints start running long, add a soft 500-char guideline to the connector-guide paragraph rather than a runtime check.
- **Open: object-level vs field-level placement convention.** Resolved above (object-level when the hint spans multiple fields; field-level when scoped). Will revisit if real usage shows ambiguity.

## Done when

- `X_SCRATCH_AGENT_INSTRUCTIONS` exported from `@spinner/shared-types`.
- `SCHEMA_DOC` in `generate_docs.rs` lists the new key with a one-sentence usage hint.
- `CONNECTOR_GUIDE.md` has the authoring paragraph.
- Intercom `authorSchema` and `conversationPartSchema` each carry one agent-instruction string.
- `yarn build`, `yarn lint`, and `cargo build --bin scratchmd` all pass from the repo root.
- Plan moved to `docs/plans/resolved/`.
