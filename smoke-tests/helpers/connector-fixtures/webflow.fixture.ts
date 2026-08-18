import { FakeAdminClient } from "../test-api-client";
import { ConnectorFixture, SeedResult } from "./types";

// Default to the host port that `smoke-tests/docker-compose.smoke-test.yml`
// exposes (`4665:4655`), matching the convention used by the other fixtures.
const FAKE_WEBFLOW_URL =
  process.env.FAKE_WEBFLOW_URL ?? "http://localhost:4665";

/** The token the fake registers with the full scope set on every reset. */
export const WEBFLOW_FULLY_SCOPED_TOKEN = "wf_fake_smoke_test_token";

/**
 * A token holding `sites:read` but NOT `cms:read` — the exact shape of the
 * customer token in DEV-11321. It authenticates, it lists sites, and it 403s on
 * every collections call.
 */
export const WEBFLOW_SITES_ONLY_TOKEN = "wf_fake_sites_only_token";

const TEST_SITE_ID = "site_smoke_0001";
const TEST_SITE_NAME = "Smoke Test Site";
const TEST_COLLECTION_ID = "coll_smoke_0001";
const TEST_COLLECTION_NAME = "Blog Posts";

/**
 * Register the site + collection skeleton (no items) and any extra tokens.
 * Shared by `seed` and by tests that only care about the scope behaviour.
 */
export async function seedWebflowSiteAndCollection(
  admin: FakeAdminClient,
): Promise<void> {
  await admin.reset();
  await admin.setup({
    tokens: [{ token: WEBFLOW_SITES_ONLY_TOKEN, scopes: ["sites:read"] }],
    sites: [
      {
        id: TEST_SITE_ID,
        displayName: TEST_SITE_NAME,
        shortName: "smoke-test-site",
      },
    ],
    collections: [
      {
        id: TEST_COLLECTION_ID,
        siteId: TEST_SITE_ID,
        displayName: TEST_COLLECTION_NAME,
        singularName: "Blog Post",
        slug: "blog-posts",
        fields: [
          {
            id: "fld_name",
            isRequired: true,
            isEditable: true,
            type: "PlainText",
            slug: "name",
            displayName: "Name",
          },
          {
            id: "fld_slug",
            isRequired: true,
            isEditable: true,
            type: "PlainText",
            slug: "slug",
            displayName: "Slug",
          },
          {
            id: "fld_summary",
            isRequired: false,
            isEditable: true,
            type: "PlainText",
            slug: "summary",
            displayName: "Summary",
          },
        ],
      },
    ],
  });
}

export const webflowFixture: ConnectorFixture = {
  service: "WEBFLOW",
  displayName: "Webflow",

  createAdminClient(): FakeAdminClient {
    return new FakeAdminClient(FAKE_WEBFLOW_URL);
  },

  createConnectionCredentials(): Record<string, string> {
    return { apiKey: WEBFLOW_FULLY_SCOPED_TOKEN };
  },

  async seed(
    admin: FakeAdminClient,
    opts?: { recordCount?: number },
  ): Promise<SeedResult> {
    const recordCount = opts?.recordCount ?? 10;

    await seedWebflowSiteAndCollection(admin);

    const items: Array<Record<string, unknown>> = [];
    const records: Array<{ id?: string; fields: Record<string, unknown> }> = [];

    for (let i = 0; i < recordCount; i++) {
      const id = `item_smoke_${String(i + 1).padStart(4, "0")}`;
      const name = `Smoke Post ${i + 1}`;
      const fieldData = {
        name,
        slug: `smoke-post-${i + 1}`,
        summary: `Smoke test record ${i + 1}`,
      };
      items.push({ id, fieldData });
      records.push({ id, fields: { fieldData } });
    }

    await admin.setup({
      items: [{ collectionId: TEST_COLLECTION_ID, items }],
    });

    return {
      // The Webflow connector keys a CMS collection table on [siteId, collectionId].
      remoteTableId: [TEST_SITE_ID, TEST_COLLECTION_ID],
      tableName: TEST_COLLECTION_NAME,
      recordCount,
      records,
    };
  },

  async dumpRecords(
    admin: FakeAdminClient,
    _seed: SeedResult,
  ): Promise<Array<{ id: string; fields: Record<string, unknown> }>> {
    const data = await admin.dump();
    const itemsByCollection = data.items as Record<
      string,
      Array<Record<string, any>>
    >;
    return (itemsByCollection[TEST_COLLECTION_ID] ?? []).map((item) => ({
      id: item.id,
      fields: { fieldData: item.fieldData },
    }));
  },
};
