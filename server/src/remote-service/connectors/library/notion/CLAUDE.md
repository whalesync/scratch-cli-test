# Notion connector

Instructions scoped to the Notion connector. Also read the
[Connector Development Guide](../../CONNECTOR_GUIDE.md) and this connector's
[STATE.md](./STATE.md).

## Regenerate the integration snapshot when you change record or JSON-schema shape

The live integration suite
[`server/test/integration/notion-connector.spec.ts`](../../../../../test/integration/notion-connector.spec.ts)
holds a Jest snapshot — `NotionConnector — live API › fetchJsonTableSpec ›
snapshot — captures the v3 fetchJsonTableSpec shape as the upgrade contract`
(stored in
[`__snapshots__/notion-connector.spec.ts.snap`](../../../../../test/integration/__snapshots__/notion-connector.spec.ts.snap)).
It pins the full `fetchJsonTableSpec` output, including the JSON schema and the
`x-scratch-suggested-in-transformer` hints (`template`, `emptyTemplate`,
`plain_text`, …).

**Any change to the record shape or the generated JSON schema can move this
snapshot.** That includes edits to `notion-json-schema.ts` (property → schema
mapping, the inbound pack/wrap transformers), `notion-schema-parser.ts`,
`notion-create-schema.ts`, `property-types.ts`, or the pull/conversion code that
determines a record's structure. After such a change, **assess whether the
snapshot needs regenerating** and, if so, regenerate it and review the diff:

```bash
# from server/ — requires NOTION_API_KEY in server/.env.integration
yarn run test:integration notion-connector -u
```

Confirm the diff contains only the fields your change intended — a snapshot
update is a deliberate contract change, not a rubber stamp.

**Why this bites in CI and not locally:** the snapshot `describe` is gated on
`NOTION_API_KEY` (`const describeIfKey = API_KEY ? describe : describe.skip`),
so it **self-skips** in the MR `integration test server` job and in any local
run without the key. It only executes in the **post-deploy** `environment tests
for test env post-deploy` job against the live Notion account — so a stale
snapshot sails through MR CI green and fails _after_ merge-to-master. If you
touch record/schema shape but can't run the live suite locally, flag the
snapshot for regeneration so it isn't discovered post-deploy.
