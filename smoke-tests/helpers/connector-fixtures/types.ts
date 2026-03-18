import { FakeAdminClient } from "../test-api-client";

export interface SeedResult {
  /** IDs needed to link a DataFolder (e.g. [baseId, tableId] for Airtable) */
  remoteTableId: string[];
  /** Human-readable table name */
  tableName: string;
  /** Number of seeded records */
  recordCount: number;
  /** The seeded records for assertion */
  records: Array<{ id?: string; fields: Record<string, unknown> }>;
}

export interface ExpectedPublishState {
  /** Total expected record count after publish */
  totalRecords: number;
  /** Records that should exist with specific field values */
  expectedRecords?: Array<{ fields: Record<string, unknown> }>;
  /** Record IDs that should no longer exist */
  deletedRecordIds?: string[];
}

/**
 * Connector-agnostic fixture interface.
 * Each fake connector implements this to participate in parameterized smoke tests.
 */
export interface ConnectorFixture {
  /** Service enum value (e.g. 'AIRTABLE') */
  service: string;

  /** Display name for test output */
  displayName: string;

  /** Create a FakeAdminClient for this connector's fake */
  createAdminClient(): FakeAdminClient;

  /** Credentials to use when creating a ConnectorAccount */
  createConnectionCredentials(): Record<string, string>;

  /** Seed the fake with a table and records, return metadata for assertions */
  seed(
    admin: FakeAdminClient,
    opts?: { recordCount?: number },
  ): Promise<SeedResult>;

  /** Seed the fake with a table that has linked-record fields (for FK tests) */
  seedWithReferences?(admin: FakeAdminClient): Promise<SeedResult>;

  /** Dump all records from the fake for a given table */
  dumpRecords(
    admin: FakeAdminClient,
    seed: SeedResult,
  ): Promise<Array<{ id: string; fields: Record<string, unknown> }>>;
}
