import { getAuthToken } from "@spinner/test-utils";
import { affinityFixture } from "../helpers/connector-fixtures/affinity.fixture";
import {
  createTestWorkspace,
  pullAndWait,
  addLinkedDataFolder,
} from "../helpers/test-fixtures";
import { TestApiClient } from "../helpers/test-api-client";

const SERVER_URL = process.env.SMOKE_TEST_SERVER_URL ?? "http://localhost:3020";

/**
 * Smoke test for the Affinity tenant-wide tables (Companies / People /
 * Opportunities). These three tables come from `GET /v2/persons`,
 * `/v2/companies`, and `/v2/opportunities` — *not* from any user-created list.
 *
 * This test exercises the full server → connector → fake-affinity round trip
 * for each tenant table, which is the only way to catch bugs that the
 * unit-level tests miss because they mock the API client. The motivating
 * regression: an early version of the connector passed `fieldTypes=list` to
 * `/v2/persons`, which Affinity rejects with HTTP 400. The unit tests passed
 * because they mocked the client; the bug only surfaced in a real pull.
 *
 * Now that fake-affinity has been tightened to reject `fieldTypes=list` on the
 * tenant endpoints with the same 400 envelope real Affinity returns, this
 * smoke test would fail loudly if anyone re-introduces that bug class.
 *
 * The existing `pull-basic.spec.ts` exercises the user-list code path via the
 * generic `affinityFixture`. This file complements it by covering the three
 * tenant endpoints, which need different seed data and produce a different
 * picker shape.
 */

const TENANT_PERSONS_REMOTE_ID = ["persons"];
const TENANT_COMPANIES_REMOTE_ID = ["companies"];
const TENANT_OPPORTUNITIES_REMOTE_ID = ["opportunities"];

// Seed shape — three persons, two companies, one opportunity. Just enough for
// the round-trip to be observable but small enough that the test stays fast.
function seedTenantData() {
  return {
    tenantPersonFields: [
      {
        id: "affinity-data-current-organization",
        name: "Current Organization",
        type: "enriched",
        valueType: "company",
        enrichmentSource: "affinity-data",
      },
      {
        id: "affinity-data-job-titles",
        name: "Job Titles",
        type: "enriched",
        valueType: "filterable-text-multi",
        enrichmentSource: "affinity-data",
      },
    ],
    tenantCompanyFields: [
      {
        id: "affinity-data-industry",
        name: "Industry",
        type: "enriched",
        valueType: "filterable-text-multi",
        enrichmentSource: "affinity-data",
      },
    ],
    tenantPersons: [
      {
        id: 8001,
        firstName: "Alice",
        lastName: "Tenant",
        primaryEmailAddress: "alice@tenant-test.example",
        emailAddresses: ["alice@tenant-test.example"],
        type: "external",
        fields: [
          {
            id: "affinity-data-current-organization",
            name: "Current Organization",
            type: "enriched",
            enrichmentSource: "affinity-data",
            value: {
              type: "company",
              data: {
                id: 9001,
                name: "Tenant Co",
                domain: "tenant-test.example",
              },
            },
          },
          {
            id: "affinity-data-job-titles",
            name: "Job Titles",
            type: "enriched",
            enrichmentSource: "affinity-data",
            value: { type: "filterable-text-multi", data: ["CEO"] },
          },
        ],
      },
      {
        id: 8002,
        firstName: "Bob",
        lastName: "Tenant",
        primaryEmailAddress: "bob@tenant-test.example",
        emailAddresses: ["bob@tenant-test.example"],
        type: "external",
        fields: [],
      },
      {
        id: 8003,
        firstName: "Carol",
        lastName: "Tenant",
        primaryEmailAddress: "carol@tenant-test.example",
        emailAddresses: ["carol@tenant-test.example"],
        type: "external",
        fields: [],
      },
    ],
    tenantCompanies: [
      {
        id: 9001,
        name: "Tenant Co",
        domain: "tenant-test.example",
        domains: ["tenant-test.example"],
        isGlobal: true,
        fields: [
          {
            id: "affinity-data-industry",
            name: "Industry",
            type: "enriched",
            enrichmentSource: "affinity-data",
            value: { type: "filterable-text-multi", data: ["Software"] },
          },
        ],
      },
      {
        id: 9002,
        name: "Other Tenant Co",
        domain: "other-tenant.example",
        domains: ["other-tenant.example"],
        isGlobal: false,
        fields: [],
      },
    ],
    tenantOpportunities: [{ id: 10001, name: "Tenant Opp One", listId: 9999 }],
  };
}

describe("Affinity tenant tables (pull)", () => {
  let api: TestApiClient;

  beforeAll(async () => {
    const { authToken } = await getAuthToken();
    api = new TestApiClient(SERVER_URL, authToken, async () => {
      const r = await getAuthToken(true);
      return r.authToken;
    });
  });

  afterAll(async () => {
    const admin = affinityFixture.createAdminClient();
    await admin.reset();
  });

  beforeEach(async () => {
    const admin = affinityFixture.createAdminClient();
    await admin.reset();
    await admin.setup(seedTenantData());
  });

  // -------------------------------------------------------------------------
  // The motivating regression: pulls from /v2/persons must NOT 400 because
  // of fieldTypes=list. fake-affinity is now strict about this.
  // -------------------------------------------------------------------------
  it("pulls every record from the tenant People table without 400ing", async () => {
    const workspace = await createTestWorkspace(api, {
      service: "AFFINITY",
      credentials: affinityFixture.createConnectionCredentials(),
      remoteTableId: TENANT_PERSONS_REMOTE_ID,
      tableName: "People",
    });

    const job = await pullAndWait(api, workspace.workbookId, [
      workspace.dataFolderId,
    ]);
    expect(job.state).toBe("completed");

    const filesRes = await api.get(
      `/workbooks/${workspace.workbookId}/files/list/by-folder`,
      { folderId: workspace.dataFolderId },
    );
    expect(filesRes.status).toBe(200);

    const files = filesRes.data.items.filter(
      (item: any) => item.type === "file" && item.name !== ".schema.json",
    );
    // Three persons seeded → three files committed.
    expect(files).toHaveLength(3);
  });

  // -------------------------------------------------------------------------
  // Companies tenant table — same shape, different endpoint.
  // -------------------------------------------------------------------------
  it("pulls every record from the tenant Companies table", async () => {
    const workspace = await createTestWorkspace(api, {
      service: "AFFINITY",
      credentials: affinityFixture.createConnectionCredentials(),
      remoteTableId: TENANT_COMPANIES_REMOTE_ID,
      tableName: "Companies",
    });

    const job = await pullAndWait(api, workspace.workbookId, [
      workspace.dataFolderId,
    ]);
    expect(job.state).toBe("completed");

    const filesRes = await api.get(
      `/workbooks/${workspace.workbookId}/files/list/by-folder`,
      { folderId: workspace.dataFolderId },
    );
    const files = filesRes.data.items.filter(
      (item: any) => item.type === "file" && item.name !== ".schema.json",
    );
    expect(files).toHaveLength(2);
  });

  // -------------------------------------------------------------------------
  // Opportunities tenant table — sanity check that the no-fieldTypes path
  // also works. Opportunities are intentionally thin (id/name/listId only).
  // -------------------------------------------------------------------------
  it("pulls every record from the tenant Opportunities table", async () => {
    const workspace = await createTestWorkspace(api, {
      service: "AFFINITY",
      credentials: affinityFixture.createConnectionCredentials(),
      remoteTableId: TENANT_OPPORTUNITIES_REMOTE_ID,
      tableName: "Opportunities",
    });

    const job = await pullAndWait(api, workspace.workbookId, [
      workspace.dataFolderId,
    ]);
    expect(job.state).toBe("completed");

    const filesRes = await api.get(
      `/workbooks/${workspace.workbookId}/files/list/by-folder`,
      { folderId: workspace.dataFolderId },
    );
    const files = filesRes.data.items.filter(
      (item: any) => item.type === "file" && item.name !== ".schema.json",
    );
    expect(files).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // Verify the fields-array → keyed-object transform applied at pull time.
  // For tenant records, fields live at the TOP LEVEL (no `entity` wrapper).
  // -------------------------------------------------------------------------
  it("rekeys fields by remote field id at the top level for a pulled person", async () => {
    const workspace = await createTestWorkspace(api, {
      service: "AFFINITY",
      credentials: affinityFixture.createConnectionCredentials(),
      remoteTableId: TENANT_PERSONS_REMOTE_ID,
      tableName: "People",
    });
    await pullAndWait(api, workspace.workbookId, [workspace.dataFolderId]);

    const filesRes = await api.get(
      `/workbooks/${workspace.workbookId}/files/list/by-folder`,
      { folderId: workspace.dataFolderId },
    );
    const files = filesRes.data.items.filter(
      (item: any) => item.type === "file" && item.name !== ".schema.json",
    );

    // Find Alice (the one with the populated fields).
    const alicePath = files.find((f: any) =>
      String(f.name).toLowerCase().startsWith("alice"),
    )?.path;
    expect(alicePath).toBeDefined();

    const fileDetail = await api.get(
      `/workbooks/${workspace.workbookId}/files/by-path`,
      { path: alicePath },
    );
    expect(fileDetail.status).toBe(200);

    const content = JSON.parse(fileDetail.data.file.content);
    // Top-level shape — no entity wrapper for tenant records.
    expect(content.entity).toBeUndefined();
    expect(content.id).toBe(8001);
    expect(content.firstName).toBe("Alice");

    // Fields are an OBJECT keyed by remote field id, not the API's array form.
    // The connector's `tenantRecordToFile` performs this transform so each
    // field is addressable by its remote id (`fields.field-1234`).
    expect(content.fields).not.toBeNull();
    expect(Array.isArray(content.fields)).toBe(false);
    expect(content.fields).toHaveProperty("affinity-data-current-organization");
    expect(content.fields).toHaveProperty("affinity-data-job-titles");
    expect(
      content.fields["affinity-data-current-organization"].value.data.name,
    ).toBe("Tenant Co");
  });

  // -------------------------------------------------------------------------
  // Multi-table pull in a single workbook — exercises the V2 pull job's
  // multi-folder path. All three tenant tables should pull cleanly in one run.
  // -------------------------------------------------------------------------
  it("pulls all three tenant tables together in a single multi-folder job", async () => {
    const peopleWorkspace = await createTestWorkspace(api, {
      service: "AFFINITY",
      credentials: affinityFixture.createConnectionCredentials(),
      remoteTableId: TENANT_PERSONS_REMOTE_ID,
      tableName: "People",
    });
    const companies = await addLinkedDataFolder(api, {
      workbookId: peopleWorkspace.workbookId,
      connectorAccountId: peopleWorkspace.connectorAccountId,
      remoteTableId: TENANT_COMPANIES_REMOTE_ID,
      tableName: "Companies",
    });
    const opportunities = await addLinkedDataFolder(api, {
      workbookId: peopleWorkspace.workbookId,
      connectorAccountId: peopleWorkspace.connectorAccountId,
      remoteTableId: TENANT_OPPORTUNITIES_REMOTE_ID,
      tableName: "Opportunities",
    });

    const job = await pullAndWait(api, peopleWorkspace.workbookId, [
      peopleWorkspace.dataFolderId,
      companies.dataFolderId,
      opportunities.dataFolderId,
    ]);
    expect(job.state).toBe("completed");

    // All three folders should have committed records.
    const counts = await Promise.all(
      [
        peopleWorkspace.dataFolderId,
        companies.dataFolderId,
        opportunities.dataFolderId,
      ].map(async (folderId) => {
        const res = await api.get(
          `/workbooks/${peopleWorkspace.workbookId}/files/list/by-folder`,
          { folderId },
        );
        return res.data.items.filter(
          (item: any) => item.type === "file" && item.name !== ".schema.json",
        ).length;
      }),
    );
    expect(counts).toEqual([3, 2, 1]);
  });

  // -------------------------------------------------------------------------
  // Picker shape: listTables should expose the three tenant tables at the
  // top level (no parentPath) plus any seeded user lists nested under
  // parentPath: "Lists".
  // -------------------------------------------------------------------------
  it("lists 3 top-level tenant tables when no user lists exist", async () => {
    const admin = affinityFixture.createAdminClient();
    // Reset and seed ONLY tenant data — no user-created lists.
    await admin.reset();
    await admin.setup(seedTenantData());

    const workspace = await createTestWorkspace(api, {
      service: "AFFINITY",
      credentials: affinityFixture.createConnectionCredentials(),
      remoteTableId: TENANT_PERSONS_REMOTE_ID,
      tableName: "People",
    });

    const tablesRes = await api.get(
      `/workbooks/${workspace.workbookId}/connections/${workspace.connectorAccountId}/tables`,
    );
    expect(tablesRes.status).toBe(200);
    // The endpoint returns a TableList envelope (`{tables, discoveryMode, ...}`),
    // not a bare TablePreview[] — see server/.../table-list.entity.ts.
    const tables = tablesRes.data.tables as Array<{
      displayName: string;
      parentPath?: string;
      id: { remoteId: string[] };
    }>;

    const topLevel = tables.filter((t) => !t.parentPath);
    const tenantNames = topLevel.map((t) => t.displayName).sort();
    expect(tenantNames).toEqual(["Companies", "Opportunities", "People"]);

    // Each tenant table uses its sentinel string as the remote id.
    const peopleTable = tables.find((t) => t.displayName === "People");
    expect(peopleTable?.id.remoteId).toEqual(["persons"]);
    const companiesTable = tables.find((t) => t.displayName === "Companies");
    expect(companiesTable?.id.remoteId).toEqual(["companies"]);
    const opportunitiesTable = tables.find(
      (t) => t.displayName === "Opportunities",
    );
    expect(opportunitiesTable?.id.remoteId).toEqual(["opportunities"]);
  });

  it("nests user-created lists under parentPath: 'Lists' alongside the tenant tables", async () => {
    const admin = affinityFixture.createAdminClient();
    await admin.reset();
    await admin.setup({
      ...seedTenantData(),
      // Add one user list so we can verify it nests under "Lists/" while the
      // tenant tables stay top-level.
      lists: [
        {
          id: 4242,
          name: "User Created List",
          type: "company",
          isPublic: false,
          ownerId: 1,
          creatorId: 1,
        },
      ],
    });

    const workspace = await createTestWorkspace(api, {
      service: "AFFINITY",
      credentials: affinityFixture.createConnectionCredentials(),
      remoteTableId: TENANT_PERSONS_REMOTE_ID,
      tableName: "People",
    });

    const tablesRes = await api.get(
      `/workbooks/${workspace.workbookId}/connections/${workspace.connectorAccountId}/tables`,
    );
    const tables = tablesRes.data.tables as Array<{
      displayName: string;
      parentPath?: string;
      id: { remoteId: string[] };
    }>;

    // Tenant tables remain at the root.
    const topLevel = tables
      .filter((t) => !t.parentPath)
      .map((t) => t.displayName)
      .sort();
    expect(topLevel).toEqual(["Companies", "Opportunities", "People"]);

    // The user list is grouped under "Lists/" (single-level, not per-entity-type).
    const userList = tables.find((t) => t.displayName === "User Created List");
    expect(userList).toBeDefined();
    expect(userList?.parentPath).toBe("Lists");
    expect(userList?.id.remoteId).toEqual(["4242"]);
  });

  // -------------------------------------------------------------------------
  // Phase 1 failure recovery — the scenario that originally surfaced the
  // error handling bugs documented in pull-job-v2-error-handling-bugs.md.
  //
  // Simulates what happened in production: a connector API call returns
  // HTTP 400 during the pull. Before the fix, this left the DataFolder
  // locked forever and the job reported success. After the fix, the lock
  // should be cleared and the job should complete (not hang).
  // -------------------------------------------------------------------------
  it("clears the data folder lock and completes the job when a Phase 1 fetch returns 400", async () => {
    const workspace = await createTestWorkspace(api, {
      service: "AFFINITY",
      credentials: affinityFixture.createConnectionCredentials(),
      remoteTableId: TENANT_PERSONS_REMOTE_ID,
      tableName: "People",
    });

    // Queue a 400 error targeting the /v2/persons listing endpoint.
    // The pathPattern ensures the error fires on the pull request, not
    // the earlier /v2/persons/fields schema fetch.
    const admin = affinityFixture.createAdminClient();
    await admin.simulateError(
      400,
      {
        errors: [
          {
            code: "invalid_parameter",
            message:
              "'list' is not a valid field type for this endpoint (simulated)",
          },
        ],
      },
      "/v2/persons?",
    );

    const job = await pullAndWait(api, workspace.workbookId, [
      workspace.dataFolderId,
    ]);

    // Job should complete (not hang waiting for a stuck folder).
    expect(job.state).toBe("completed");

    // The DataFolder's lock should be cleared — not stuck at 'pull'.
    const folderRes = await api.get(`/data-folder/${workspace.dataFolderId}`);
    expect(folderRes.status).toBe(200);
    expect(folderRes.data.lock).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Partial failure: one folder fails in Phase 1, another succeeds.
  // The succeeding folder should commit its files normally. The failing
  // folder should have its lock cleared. Neither should block the other.
  // -------------------------------------------------------------------------
  it("processes the succeeding folder and cleans up the failing folder in a partial Phase 1 failure", async () => {
    // Set up two folders: People (will fail) and Companies (will succeed).
    const workspace = await createTestWorkspace(api, {
      service: "AFFINITY",
      credentials: affinityFixture.createConnectionCredentials(),
      remoteTableId: TENANT_PERSONS_REMOTE_ID,
      tableName: "People",
    });
    const companies = await addLinkedDataFolder(api, {
      workbookId: workspace.workbookId,
      connectorAccountId: workspace.connectorAccountId,
      remoteTableId: TENANT_COMPANIES_REMOTE_ID,
      tableName: "Companies",
    });

    // Queue a 400 targeting the persons listing so People fails but
    // Companies (which hits /v2/companies) is unaffected.
    const admin = affinityFixture.createAdminClient();
    await admin.simulateError(
      400,
      {
        errors: [
          {
            code: "invalid_parameter",
            message: "Simulated 400 for persons endpoint",
          },
        ],
      },
      "/v2/persons?",
    );

    const job = await pullAndWait(api, workspace.workbookId, [
      workspace.dataFolderId,
      companies.dataFolderId,
    ]);

    // Job should complete (not hang).
    expect(job.state).toBe("completed");

    // Failed folder (People) should have its lock cleared.
    const peopleFolderRes = await api.get(
      `/data-folder/${workspace.dataFolderId}`,
    );
    expect(peopleFolderRes.status).toBe(200);
    expect(peopleFolderRes.data.lock).toBeNull();

    // Succeeding folder (Companies) should have committed its 2 records.
    const companiesFolderRes = await api.get(
      `/data-folder/${companies.dataFolderId}`,
    );
    expect(companiesFolderRes.status).toBe(200);
    expect(companiesFolderRes.data.lock).toBeNull();

    const filesRes = await api.get(
      `/workbooks/${workspace.workbookId}/files/list/by-folder`,
      { folderId: companies.dataFolderId },
    );
    const files = filesRes.data.items.filter(
      (item: any) => item.type === "file" && item.name !== ".schema.json",
    );
    expect(files).toHaveLength(2);
  });
});
