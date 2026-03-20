import { FakeAdminClient } from "../test-api-client";
import { ConnectorFixture, SeedResult } from "./types";

const FAKE_MEMBERSTACK_URL =
  process.env.FAKE_MEMBERSTACK_URL ?? "http://localhost:4662";

export const memberstackFixture: ConnectorFixture = {
  service: "MEMBERSTACK",
  displayName: "Memberstack",

  createAdminClient(): FakeAdminClient {
    return new FakeAdminClient(FAKE_MEMBERSTACK_URL);
  },

  createConnectionCredentials(): Record<string, string> {
    return { apiKey: "sk_fake_smoke_test_key" };
  },

  async seed(
    admin: FakeAdminClient,
    opts?: { recordCount?: number },
  ): Promise<SeedResult> {
    const recordCount = opts?.recordCount ?? 10;

    await admin.reset();

    const members: Array<{ fields: Record<string, unknown> }> = [];
    const seedMembers: Array<Record<string, unknown>> = [];

    for (let i = 0; i < recordCount; i++) {
      const email = `member${i + 1}@example.com`;
      seedMembers.push({
        email,
        customFields: {
          first_name: `Member ${i + 1}`,
          company: i % 2 === 0 ? "Acme Corp" : "Globex Inc",
        },
        metaData: { source: "smoke-test" },
        json: {},
        loginRedirect: "/dashboard",
      });
      members.push({
        fields: {
          "auth.email": email,
          "customFields.first_name": `Member ${i + 1}`,
          "customFields.company": i % 2 === 0 ? "Acme Corp" : "Globex Inc",
        },
      });
    }

    await admin.setup({ members: seedMembers });

    return {
      remoteTableId: ["members"],
      tableName: "Members",
      recordCount,
      records: members,
    };
  },

  async dumpRecords(
    admin: FakeAdminClient,
    _seed: SeedResult,
  ): Promise<Array<{ id: string; fields: Record<string, unknown> }>> {
    const data = await admin.dump();
    return (data.members as Array<Record<string, any>>).map((m) => ({
      id: m.id,
      fields: {
        "auth.email": m.auth.email,
        customFields: m.customFields,
        metaData: m.metaData,
        json: m.json,
        loginRedirect: m.loginRedirect,
      },
    }));
  },
};
