import { FakeAdminClient } from "../test-api-client";
import { ConnectorFixture, SeedResult } from "./types";

const FAKE_AIRTABLE_URL =
  process.env.FAKE_AIRTABLE_URL ?? "http://localhost:4656";
const TEST_BASE_ID = "appSmokeTestBase";
const TEST_TABLE_ID = "tblSmokeTestTable";

export const airtableFixture: ConnectorFixture = {
  service: "AIRTABLE",
  displayName: "Airtable",

  createAdminClient(): FakeAdminClient {
    return new FakeAdminClient(FAKE_AIRTABLE_URL);
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

    const records: Array<{ fields: Record<string, unknown> }> = [];
    for (let i = 0; i < recordCount; i++) {
      records.push({
        fields: {
          Name: `Record ${i + 1}`,
          Status: i % 2 === 0 ? "Active" : "Inactive",
          Count: i * 10,
        },
      });
    }

    await admin.setup({
      bases: [
        {
          id: TEST_BASE_ID,
          name: "Smoke Test Base",
          permissionLevel: "create",
        },
      ],
      tables: [
        {
          baseId: TEST_BASE_ID,
          tables: [
            {
              id: TEST_TABLE_ID,
              name: "Smoke Test Table",
              primaryFieldId: "fldName",
              fields: [
                { id: "fldName", name: "Name", type: "singleLineText" },
                { id: "fldStatus", name: "Status", type: "singleLineText" },
                { id: "fldCount", name: "Count", type: "number" },
              ],
              views: [{ id: "viwDefault", name: "Grid view", type: "grid" }],
            },
          ],
        },
      ],
      records: [{ baseId: TEST_BASE_ID, tableId: TEST_TABLE_ID, records }],
    });

    return {
      remoteTableId: [TEST_BASE_ID, TEST_TABLE_ID],
      tableName: "Smoke Test Table",
      recordCount,
      records,
    };
  },

  async seedWithReferences(admin: FakeAdminClient): Promise<SeedResult> {
    await admin.reset();

    const TABLE_A_ID = "tblAuthors";
    const TABLE_B_ID = "tblBooks";

    await admin.setup({
      bases: [
        {
          id: TEST_BASE_ID,
          name: "Smoke Test Base",
          permissionLevel: "create",
        },
      ],
      tables: [
        {
          baseId: TEST_BASE_ID,
          tables: [
            {
              id: TABLE_A_ID,
              name: "Authors",
              primaryFieldId: "fldAuthorName",
              fields: [
                { id: "fldAuthorName", name: "Name", type: "singleLineText" },
                {
                  id: "fldBooks",
                  name: "Books",
                  type: "multipleRecordLinks",
                  options: { linkedTableId: TABLE_B_ID },
                },
              ],
              views: [{ id: "viwDefault", name: "Grid view", type: "grid" }],
            },
            {
              id: TABLE_B_ID,
              name: "Books",
              primaryFieldId: "fldBookTitle",
              fields: [
                { id: "fldBookTitle", name: "Title", type: "singleLineText" },
                {
                  id: "fldAuthor",
                  name: "Author",
                  type: "multipleRecordLinks",
                  options: { linkedTableId: TABLE_A_ID },
                },
              ],
              views: [{ id: "viwDefault", name: "Grid view", type: "grid" }],
            },
          ],
        },
      ],
      records: [
        {
          baseId: TEST_BASE_ID,
          tableId: TABLE_A_ID,
          records: [
            { fields: { Name: "Author A" } },
            { fields: { Name: "Author B" } },
          ],
        },
        {
          baseId: TEST_BASE_ID,
          tableId: TABLE_B_ID,
          records: [
            { fields: { Title: "Book 1" } },
            { fields: { Title: "Book 2" } },
          ],
        },
      ],
    });

    return {
      remoteTableId: [TEST_BASE_ID, TABLE_A_ID],
      tableName: "Authors",
      recordCount: 2,
      records: [
        { fields: { Name: "Author A" } },
        { fields: { Name: "Author B" } },
      ],
    };
  },

  async dumpRecords(
    admin: FakeAdminClient,
    seed: SeedResult,
  ): Promise<Array<{ id: string; fields: Record<string, unknown> }>> {
    const [baseId, tableId] = seed.remoteTableId;
    const data = await admin.dump(baseId, tableId);
    return data.records;
  },
};
