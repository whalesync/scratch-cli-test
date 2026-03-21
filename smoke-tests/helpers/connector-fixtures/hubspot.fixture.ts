import { FakeAdminClient } from "../test-api-client";
import { ConnectorFixture, SeedResult } from "./types";

const FAKE_HUBSPOT_URL =
  process.env.FAKE_HUBSPOT_URL ?? "http://localhost:4663";

export const hubspotFixture: ConnectorFixture = {
  service: "HUBSPOT",
  displayName: "HubSpot",

  createAdminClient(): FakeAdminClient {
    return new FakeAdminClient(FAKE_HUBSPOT_URL);
  },

  createConnectionCredentials(): Record<string, string> {
    return { apiKey: "pat-na1-fake-smoke-test-token" };
  },

  async seed(
    admin: FakeAdminClient,
    opts?: { recordCount?: number },
  ): Promise<SeedResult> {
    const recordCount = opts?.recordCount ?? 10;

    await admin.reset();

    const records: Array<{ fields: Record<string, unknown> }> = [];
    const seedRecords: Array<{ properties: Record<string, string> }> = [];

    for (let i = 0; i < recordCount; i++) {
      const properties = {
        email: `contact${i + 1}@example.com`,
        firstname: `First${i + 1}`,
        lastname: `Last${i + 1}`,
        company: i % 2 === 0 ? "Acme Corp" : "Globex Inc",
      };
      seedRecords.push({ properties });
      records.push({
        fields: {
          "properties.email": properties.email,
          "properties.firstname": properties.firstname,
          "properties.lastname": properties.lastname,
          "properties.company": properties.company,
        },
      });
    }

    await admin.setup({
      objectTypes: [
        {
          objectType: "contacts",
          records: seedRecords,
        },
      ],
    });

    return {
      remoteTableId: ["contacts"],
      tableName: "Contacts",
      recordCount,
      records,
    };
  },

  async dumpRecords(
    admin: FakeAdminClient,
    seed: SeedResult,
  ): Promise<Array<{ id: string; fields: Record<string, unknown> }>> {
    const [objectType] = seed.remoteTableId;
    const data = await admin.dump(objectType);
    return (data.records as Array<Record<string, any>>).map((r) => ({
      id: r.id,
      fields: {
        "properties.email": r.properties.email,
        "properties.firstname": r.properties.firstname,
        "properties.lastname": r.properties.lastname,
        "properties.company": r.properties.company,
      },
    }));
  },
};
