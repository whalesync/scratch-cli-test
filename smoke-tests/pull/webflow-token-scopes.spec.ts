import { getAuthToken } from "@spinner/test-utils";
import {
  seedWebflowSiteAndCollection,
  webflowFixture,
  WEBFLOW_SITES_ONLY_TOKEN,
} from "../helpers/connector-fixtures/webflow.fixture";
import { TestApiClient } from "../helpers/test-api-client";

const SERVER_URL = process.env.SMOKE_TEST_SERVER_URL ?? "http://localhost:3020";

/**
 * DEV-11321 end-to-end regression.
 *
 * A customer's Webflow site token carried `sites:read` but not `cms:read`. It
 * passed our connect-time check (which only listed sites), was stored with
 * `healthStatus: OK`, and then failed every table listing with an HTTP 500 whose
 * body said nothing actionable — 59 times over five hours, with no server log
 * line to explain any of it.
 *
 * The two properties worth pinning are: the bad token is rejected at CONNECT
 * time, and if it does reach the table picker the failure is a 4xx naming the
 * missing scope rather than a 500.
 */
describe("Webflow token scopes", () => {
  let api: TestApiClient;

  beforeAll(async () => {
    const { authToken } = await getAuthToken();
    api = new TestApiClient(SERVER_URL, authToken, async () => {
      const r = await getAuthToken(true);
      return r.authToken;
    });
  });

  afterAll(async () => {
    await webflowFixture.createAdminClient().reset();
  });

  async function createWorkbookWithToken(apiKey: string): Promise<{
    workbookId: string;
    connectorAccountId: string;
  }> {
    const workbookRes = await api.post("/workbook", {
      name: `smoke-test-webflow-scopes-${Date.now()}`,
    });
    expect(workbookRes.status).toBe(201);

    const connRes = await api.post(
      `/workbooks/${workbookRes.data.id}/connections`,
      {
        service: "WEBFLOW",
        authType: "API_KEY",
        userProvidedParams: { apiKey },
      },
    );
    expect(connRes.status).toBe(201);

    return {
      workbookId: workbookRes.data.id,
      connectorAccountId: connRes.data.id,
    };
  }

  it("fails the connection test for a token that cannot read collections", async () => {
    const admin = webflowFixture.createAdminClient();
    await seedWebflowSiteAndCollection(admin);

    const { workbookId, connectorAccountId } = await createWorkbookWithToken(
      WEBFLOW_SITES_ONLY_TOKEN,
    );

    const testRes = await api.post(
      `/workbooks/${workbookId}/connections/${connectorAccountId}/test`,
      {},
    );

    expect(testRes.status).toBe(201);
    expect(testRes.data.health).toBe("error");
    // The scope name is the whole fix — it must survive to the user.
    expect(testRes.data.error).toContain("cms:read");
  });

  it("passes the connection test for a fully scoped token", async () => {
    const admin = webflowFixture.createAdminClient();
    await seedWebflowSiteAndCollection(admin);

    const { workbookId, connectorAccountId } = await createWorkbookWithToken(
      webflowFixture.createConnectionCredentials().apiKey,
    );

    const testRes = await api.post(
      `/workbooks/${workbookId}/connections/${connectorAccountId}/test`,
      {},
    );

    expect(testRes.status).toBe(201);
    expect(testRes.data.health).toBe("ok");
  });

  it("answers the table listing with an actionable 4xx, never a 500", async () => {
    const admin = webflowFixture.createAdminClient();
    await seedWebflowSiteAndCollection(admin);

    const { workbookId, connectorAccountId } = await createWorkbookWithToken(
      WEBFLOW_SITES_ONLY_TOKEN,
    );

    const tablesRes = await api.get(
      `/workbooks/${workbookId}/connections/${connectorAccountId}/tables`,
    );

    // This is the exact request that 500'd for the customer.
    expect(tablesRes.status).toBeGreaterThanOrEqual(400);
    expect(tablesRes.status).toBeLessThan(500);
    expect(JSON.stringify(tablesRes.data)).toContain("cms:read");
  });
});
