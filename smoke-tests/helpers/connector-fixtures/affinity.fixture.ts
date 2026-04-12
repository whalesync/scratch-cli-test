import { FakeAdminClient } from "../test-api-client";
import { ConnectorFixture, SeedResult } from "./types";

// Default to the host port that `smoke-tests/docker-compose.smoke-test.yml`
// exposes (`4664:4654`), matching the convention used by `airtable.fixture.ts`
// (4656) and `hubspot.fixture.ts` (4663). For local dev outside docker, set
// `FAKE_AFFINITY_URL=http://localhost:4654` since `server/localdev/docker-compose.yml`
// maps the container's 4654 directly through to the host.
const FAKE_AFFINITY_URL =
  process.env.FAKE_AFFINITY_URL ?? "http://localhost:4664";

// One list per smoke test run, with company entities. The Affinity connector
// models each list as a Scratch table — this fixture exercises a single list
// at a time, which mirrors the most common pull pattern.
const TEST_LIST_ID = 9001;
const TEST_LIST_NAME = "Smoke Test Companies";

const STAGE_FIELD_ID = "field-9001-stage";
const NOTES_FIELD_ID = "field-9001-notes";

export const affinityFixture: ConnectorFixture = {
  service: "AFFINITY",
  displayName: "Affinity",

  createAdminClient(): FakeAdminClient {
    return new FakeAdminClient(FAKE_AFFINITY_URL);
  },

  createConnectionCredentials(): Record<string, string> {
    return { apiKey: "fake-smoke-test-key" };
  },

  async seed(
    admin: FakeAdminClient,
    opts?: { recordCount?: number },
  ): Promise<SeedResult> {
    const recordCount = opts?.recordCount ?? 10;

    await admin.reset();

    // Build N synthetic company list entries. Each one carries two list-type
    // fields so the array→keyed-object transform on the connector side has
    // something real to chew on.
    const entries: Array<Record<string, unknown>> = [];
    const records: Array<{ id?: string; fields: Record<string, unknown> }> = [];

    for (let i = 0; i < recordCount; i++) {
      const entryId = 1_000_000 + i;
      const entityId = 2_000_000 + i;
      const name = `Smoke Co ${i + 1}`;
      const stage = i % 2 === 0 ? "Active" : "Pending";
      const notes = `Smoke test record ${i + 1}`;

      entries.push({
        id: entryId,
        type: "company",
        listId: TEST_LIST_ID,
        createdAt: "2025-01-01T00:00:00Z",
        creatorId: 1,
        entity: {
          id: entityId,
          name,
          domain: `smoke${i + 1}.example.com`,
          domains: [`smoke${i + 1}.example.com`],
          isGlobal: true,
          fields: [
            {
              id: STAGE_FIELD_ID,
              name: "Stage",
              type: "list",
              enrichmentSource: null,
              value: { type: "dropdown", data: { id: i % 2, text: stage } },
            },
            {
              id: NOTES_FIELD_ID,
              name: "Notes",
              type: "list",
              enrichmentSource: null,
              value: { type: "filterable-text", data: notes },
            },
          ],
        },
      });

      // Records use dot-paths into the connector's stored shape after the
      // array→keyed-object transform — that's the form column mappings target.
      records.push({
        id: String(entryId),
        fields: {
          "entity.name": name,
          [`entity.fields.${STAGE_FIELD_ID}.value.data.text`]: stage,
          [`entity.fields.${NOTES_FIELD_ID}.value.data`]: notes,
        },
      });
    }

    await admin.setup({
      lists: [
        {
          id: TEST_LIST_ID,
          name: TEST_LIST_NAME,
          type: "company",
          isPublic: false,
          ownerId: 1,
          creatorId: 1,
        },
      ],
      fieldsByList: {
        [TEST_LIST_ID]: [
          {
            id: STAGE_FIELD_ID,
            name: "Stage",
            type: "list",
            valueType: "dropdown",
            enrichmentSource: null,
          },
          {
            id: NOTES_FIELD_ID,
            name: "Notes",
            type: "list",
            valueType: "filterable-text",
            enrichmentSource: null,
          },
        ],
      },
      entriesByList: {
        [TEST_LIST_ID]: entries,
      },
    });

    return {
      remoteTableId: [String(TEST_LIST_ID)],
      tableName: TEST_LIST_NAME,
      recordCount,
      records,
    };
  },

  async dumpRecords(
    admin: FakeAdminClient,
    _seed: SeedResult,
  ): Promise<Array<{ id: string; fields: Record<string, unknown> }>> {
    const data = await admin.dump();
    // Find our test list and flatten its entries into the record format.
    const lists = data.lists as Array<{
      list: { id: number };
      entries: Array<{
        id: number;
        entity: {
          name?: string;
          fields: Array<{ id: string; value: { data: unknown } | null }>;
        };
      }>;
    }>;
    const target = lists.find((l) => l.list.id === TEST_LIST_ID);
    if (!target) return [];

    return target.entries.map((entry) => {
      const fields: Record<string, unknown> = {
        "entity.name": entry.entity.name,
      };
      for (const field of entry.entity.fields) {
        // Mirror the dot-path shape used in seed() so equality comparisons work.
        const value = field.value?.data;
        if (
          field.id === STAGE_FIELD_ID &&
          value &&
          typeof value === "object" &&
          "text" in value
        ) {
          fields[`entity.fields.${field.id}.value.data.text`] = (
            value as { text: unknown }
          ).text;
        } else {
          fields[`entity.fields.${field.id}.value.data`] = value;
        }
      }
      return { id: String(entry.id), fields };
    });
  },
};
