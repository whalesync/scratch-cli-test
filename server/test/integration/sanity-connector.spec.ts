/**
 * Sanity connector live API integration test.
 *
 * Two suites:
 *
 *   1. Read-path smoke against the real Content Lake: validates the token (project
 *      auto-discovery + dataset listing), discovers document-type tables, builds an
 *      inferred schema over the data API, and pulls a page per discovered table.
 *   2. CRUD round-trips: hermetic `scratch-it-<timestamp>` prefixed documents are
 *      created / patched / deleted through the connector's write surface, and every
 *      write is verified INDEPENDENTLY by reading the document back through a direct
 *      GROQ query against the data API (never trusting the connector's own return
 *      value alone). Each created document carries one value of every writable field
 *      shape, so field-shape coverage falls out of the same handful of tests. All
 *      test documents are deleted on teardown (Sanity deletes of missing ids are
 *      no-ops, so cleanup is idempotent even after partial failures).
 *
 * Requires SANITY_API_KEY in .env.integration (or the environment) — an Editor-role
 * robot token for the test project (see the connector's STATE.md).
 *
 * Run via: cd server && yarn test:integration -- sanity-connector
 */

// Break the circular import chain that pulls in display-names → registry → DB.
jest.mock('src/remote-service/connectors/display-names', () => ({
  getServiceDisplayName: (service: string) => service,
}));

import { TObject } from '@sinclair/typebox';
import axios from 'axios';
import { SanityConnector } from 'src/remote-service/connectors/library/sanity/sanity-connector';
import { BaseJsonTableSpec, ConnectorFile } from 'src/remote-service/connectors/types';

jest.setTimeout(60_000);

const API_KEY = process.env.SANITY_API_KEY;

/**
 * Every document the CRUD suite creates gets an `_id` (and display name) under this
 * per-run prefix, so the suite is hermetic against the seeded project content and
 * leftovers from a crashed run are findable (and bulk-deletable) by prefix.
 */
const HERMETIC_TEST_DOCUMENT_ID_PREFIX = `scratch-it-${Date.now()}`;

/**
 * The data API version the direct verification queries are pinned to. Deliberately
 * hardcoded (not imported from the connector's client) so the read-back path stays
 * fully independent of the code under test.
 */
const DIRECT_VERIFICATION_DATA_API_VERSION = 'v2025-02-19';

function createConnector(): SanityConnector {
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  return new SanityConnector(API_KEY!);
}

// Skip the entire suite if no key is configured (so CI stays green).
const describeIfKey = API_KEY ? describe : describe.skip;

describeIfKey('SanityConnector — live API', () => {
  it('testConnection resolves for a valid token', async () => {
    await expect(createConnector().testConnection()).resolves.toBeUndefined();
  });

  it('testConnection rejects for an invalid token', async () => {
    const connectorWithBadToken = new SanityConnector('sk-invalid-token');
    await expect(connectorWithBadToken.testConnection()).rejects.toThrow();
  });

  it('lists document-type tables grouped by dataset', async () => {
    const tables = await createConnector().listTables();
    expect(Array.isArray(tables)).toBe(true);
    for (const table of tables) {
      expect(table.id.remoteId).toHaveLength(3);
      expect(table.parentPath).toBeTruthy();
      expect(table.displayName.startsWith('sanity.')).toBe(false);
    }
  });

  it('builds an inferred schema and pulls a page for each discovered table', async () => {
    const connector = createConnector();
    const tables = await connector.listTables();
    for (const table of tables) {
      const tableSpec = await connector.fetchJsonTableSpec(table.id);
      expect(tableSpec.idPath).toBe('_id');
      expect(tableSpec.basePath).toEqual([table.id.remoteId[1]]);

      const pulledFiles: ConnectorFile[] = [];
      await connector.pullRecordFiles(
        tableSpec,
        // eslint-disable-next-line @typescript-eslint/require-await
        async ({ files }) => {
          pulledFiles.push(...files);
        },
        {},
        {},
      );
      // Every discovered type has ≥1 document by construction (types are discovered
      // from the documents themselves), and pulled documents are verbatim Sanity shapes.
      expect(pulledFiles.length).toBeGreaterThan(0);
      for (const pulledFile of pulledFiles) {
        expect(typeof pulledFile._id).toBe('string');
        expect(pulledFile._type).toBe(table.displayName);
      }
    }
  });

  it('builds a schema with system fields even for a type with no documents', async () => {
    const connector = createConnector();
    const tables = await connector.listTables();
    const [projectId, datasetName] = tables[0]?.id.remoteId ?? [];
    if (!projectId || !datasetName) return; // empty project — nothing to scope the probe to
    const tableSpec = await connector.fetchJsonTableSpec({
      wsId: 'probe_nonexistent_type',
      remoteId: [projectId, datasetName, 'scratchNonexistentType'],
    });
    expect(tableSpec.idPath).toBe('_id');
    const schemaProperties = (tableSpec.schema as TObject).properties;
    expect(Object.keys(schemaProperties)).toEqual(expect.arrayContaining(['_id', '_type']));
  });
});

// ===========================================================================
// CRUD round-trips — the regression net for write-shape bugs.
//
// Uses the existing `author` and `post` document types (so the read suite's
// discovered-type list is never polluted with a new `_type`). Every document is
// created with a `scratch-it-<timestamp>` prefixed `_id`, verified through a
// DIRECT GROQ read-back (independent of the connector), and deleted in
// `afterAll` via the direct mutation API.
// ===========================================================================

describeIfKey('SanityConnector — CRUD round-trips', () => {
  let connector: SanityConnector;
  let authorTableSpec: BaseJsonTableSpec;
  let postTableSpec: BaseJsonTableSpec;
  let liveProjectId: string;
  let liveDatasetName: string;
  /** Every `_id` the suite creates; bulk-deleted on teardown (missing ids are no-ops). */
  const createdDocumentIdsForCleanup: string[] = [];

  beforeAll(async () => {
    connector = createConnector();
    const tables = await connector.listTables();
    const authorTable = tables.find((table) => table.displayName === 'author');
    const postTable = tables.find((table) => table.displayName === 'post');
    if (!authorTable || !postTable) {
      throw new Error(
        'Expected the seeded `author` and `post` document types in the test project — ' +
          're-seed the project (see the Sanity connector STATE.md).',
      );
    }
    [liveProjectId, liveDatasetName] = authorTable.id.remoteId;
    authorTableSpec = await connector.fetchJsonTableSpec(authorTable.id);
    postTableSpec = await connector.fetchJsonTableSpec(postTable.id);
  });

  afterAll(async () => {
    if (createdDocumentIdsForCleanup.length === 0) return;
    try {
      // Reverse creation order so referencing documents (posts) are deleted in the
      // same transaction as — and never after — the authors they reference.
      await deleteLiveSanityDocumentsDirectly(
        liveProjectId,
        liveDatasetName,
        [...createdDocumentIdsForCleanup].reverse(),
      );
    } catch (cleanupError) {
      console.warn(
        `Sanity CRUD suite cleanup failed — delete documents prefixed "${HERMETIC_TEST_DOCUMENT_ID_PREFIX}" manually.`,
        cleanupError,
      );
    }
  });

  /**
   * An `author` document carrying one value of every writable field shape the
   * connector supports: string, number (int + float), boolean, ISO datetime,
   * slug object, email/url strings, nested object, string array, and geopoint.
   */
  function buildAuthorDocumentWithEveryFieldShape(variantLabel: string): ConnectorFile {
    const documentId = `${HERMETIC_TEST_DOCUMENT_ID_PREFIX}-author-${variantLabel}`;
    return {
      _id: documentId,
      _type: 'author',
      name: `${HERMETIC_TEST_DOCUMENT_ID_PREFIX} Author ${variantLabel}`,
      role: 'Integration Test Fixture',
      active: true,
      yearsActive: 42,
      rating: 4.25,
      joinedAt: '2026-03-15T09:30:00Z',
      slug: { _type: 'slug', current: documentId },
      email: 'scratch-integration-test@example.com',
      website: 'https://example.com/scratch-integration-test',
      address: { street: '12 Test Harness Way', city: 'Testville' },
      tags: ['integration', 'hermetic'],
      location: { _type: 'geopoint', lat: 47.6062, lng: -122.3321 },
    };
  }

  it('create — a document carrying every writable field shape persists and reads back verbatim', async () => {
    const writtenAuthorDocument = buildAuthorDocumentWithEveryFieldShape('create');
    const [persistedAuthorDocument] = await connector.createRecords(authorTableSpec, [writtenAuthorDocument]);
    createdDocumentIdsForCleanup.push(writtenAuthorDocument._id as string);

    // The connector must hand back the server-persisted document with its `_id`.
    expect(typeof persistedAuthorDocument._id).toBe('string');
    expect(persistedAuthorDocument._id).toBe(writtenAuthorDocument._id);

    // Independent verification: read the document back through a direct GROQ query.
    const readBackAuthorDocument = await queryLiveSanityDatasetDirectly<Record<string, unknown> | null>(
      liveProjectId,
      liveDatasetName,
      '*[_id == $id][0]',
      { id: writtenAuthorDocument._id },
    );
    expectEveryWrittenFieldToReadBackVerbatim(writtenAuthorDocument, readBackAuthorDocument);
  });

  it('update — a sparse changedFields patch changes only the targeted paths (top-level + nested leaf)', async () => {
    const initialAuthorDocument = buildAuthorDocumentWithEveryFieldShape('update');
    const [persistedAuthorDocument] = await connector.createRecords(authorTableSpec, [initialAuthorDocument]);
    createdDocumentIdsForCleanup.push(initialAuthorDocument._id as string);

    const updatedName = `${HERMETIC_TEST_DOCUMENT_ID_PREFIX} Author update RENAMED`;
    const updatedCity = 'Patchedburg';
    // changedFields is a deep sparse object: only the changed paths appear. The full
    // file (with the changes merged in) rides alongside, but the sparse entry is what
    // the connector must translate into a `patch.set` of dot attribute paths.
    const fileWithChangesMerged: ConnectorFile = {
      ...persistedAuthorDocument,
      name: updatedName,
      address: { street: '12 Test Harness Way', city: updatedCity },
    };
    const sparseChangedFieldsEntry = { name: updatedName, address: { city: updatedCity } };
    await connector.updateRecords(authorTableSpec, [fileWithChangesMerged], [sparseChangedFieldsEntry]);

    const readBackAuthorDocument = await queryLiveSanityDatasetDirectly<Record<string, unknown> | null>(
      liveProjectId,
      liveDatasetName,
      '*[_id == $id][0]',
      { id: initialAuthorDocument._id },
    );
    // Changed paths carry the new values; every untouched field is intact — including
    // the nested sibling (address.street) of the patched leaf (address.city).
    const expectedDocumentAfterPatch = {
      ...initialAuthorDocument,
      name: updatedName,
      address: { street: '12 Test Harness Way', city: updatedCity },
    };
    expectEveryWrittenFieldToReadBackVerbatim(expectedDocumentAfterPatch, readBackAuthorDocument);
  });

  it('references + Portable Text — a post referencing created authors round-trips and joins server-side', async () => {
    // Two hermetic authors: one for the single reference, both for the array of references.
    const primaryAuthorDocument = buildAuthorDocumentWithEveryFieldShape('ref-primary');
    const secondaryAuthorDocument = buildAuthorDocumentWithEveryFieldShape('ref-secondary');
    await connector.createRecords(authorTableSpec, [primaryAuthorDocument, secondaryAuthorDocument]);
    createdDocumentIdsForCleanup.push(primaryAuthorDocument._id as string, secondaryAuthorDocument._id as string);

    const postDocumentId = `${HERMETIC_TEST_DOCUMENT_ID_PREFIX}-post-refs`;
    const writtenPostDocument: ConnectorFile = {
      _id: postDocumentId,
      _type: 'post',
      title: `${HERMETIC_TEST_DOCUMENT_ID_PREFIX} Post with references`,
      author: { _type: 'reference', _ref: primaryAuthorDocument._id },
      contributors: [
        { _key: 'contrib1', _type: 'reference', _ref: primaryAuthorDocument._id },
        { _key: 'contrib2', _type: 'reference', _ref: secondaryAuthorDocument._id },
      ],
      body: [
        {
          _key: 'blk1',
          _type: 'block',
          style: 'normal',
          markDefs: [{ _key: 'link1', _type: 'link', href: 'https://example.com/scratch-integration-test' }],
          children: [
            { _key: 'sp1', _type: 'span', marks: [], text: 'Plain lead-in, ' },
            { _key: 'sp2', _type: 'span', marks: ['strong'], text: 'bold middle, ' },
            { _key: 'sp3', _type: 'span', marks: ['link1'], text: 'and a linked tail.' },
          ],
        },
      ],
    };
    await connector.createRecords(postTableSpec, [writtenPostDocument]);
    createdDocumentIdsForCleanup.push(postDocumentId);

    // Verbatim read-back: references (single + keyed array) and the Portable Text
    // block tree (spans, marks, markDefs link) must persist exactly as written.
    const readBackPostDocument = await queryLiveSanityDatasetDirectly<Record<string, unknown> | null>(
      liveProjectId,
      liveDatasetName,
      '*[_id == $id][0]',
      { id: postDocumentId },
    );
    expectEveryWrittenFieldToReadBackVerbatim(writtenPostDocument, readBackPostDocument);

    // A GROQ join dereferences the written refs server-side — proving they are real
    // references in the Content Lake, not inert JSON blobs.
    const joinedReferenceNames = await queryLiveSanityDatasetDirectly<{
      resolvedAuthorName: string | null;
      resolvedContributorNames: (string | null)[] | null;
    } | null>(
      liveProjectId,
      liveDatasetName,
      '*[_id == $id][0]{ "resolvedAuthorName": author->name, "resolvedContributorNames": contributors[]->name }',
      { id: postDocumentId },
    );
    expect(joinedReferenceNames?.resolvedAuthorName).toBe(primaryAuthorDocument.name);
    expect(joinedReferenceNames?.resolvedContributorNames).toEqual([
      primaryAuthorDocument.name,
      secondaryAuthorDocument.name,
    ]);
  });

  it('delete — documents are gone after deleteRecords, and re-deleting is a no-op', async () => {
    const authorDocumentToDelete = buildAuthorDocumentWithEveryFieldShape('delete');
    const [persistedAuthorDocument] = await connector.createRecords(authorTableSpec, [authorDocumentToDelete]);
    // Track it anyway: if the delete assertions fail, teardown still cleans it up.
    createdDocumentIdsForCleanup.push(authorDocumentToDelete._id as string);

    await connector.deleteRecords(authorTableSpec, [persistedAuthorDocument]);

    const remainingDocumentCount = await queryLiveSanityDatasetDirectly<number>(
      liveProjectId,
      liveDatasetName,
      'count(*[_id == $id])',
      { id: authorDocumentToDelete._id },
    );
    expect(remainingDocumentCount).toBe(0);

    // Deleting an already-deleted document is a no-op in Sanity — must not throw.
    await expect(connector.deleteRecords(authorTableSpec, [persistedAuthorDocument])).resolves.toBeUndefined();
  });

  it('error handling — updateRecords rejects a file that has no _id', async () => {
    const fileWithoutRemoteId: ConnectorFile = { _type: 'author', name: 'never persisted' };
    await expect(
      connector.updateRecords(authorTableSpec, [fileWithoutRemoteId], [{ name: 'never persisted' }]),
    ).rejects.toThrow('_id');
  });

  it('error handling — createRecords surfaces the mutation validationError for an illegal _id', async () => {
    // Sanity document ids may not contain spaces — the mutation API 400s with a
    // `validationError` ("Invalid document ID"). The connector must surface that
    // rejection rather than silently succeeding.
    const illegalDocumentId = `${HERMETIC_TEST_DOCUMENT_ID_PREFIX} illegal id with spaces`;
    await expect(
      connector.createRecords(authorTableSpec, [{ _id: illegalDocumentId, _type: 'author', name: 'never persisted' }]),
    ).rejects.toThrow();

    // And nothing was created under the rejected id.
    const createdDocumentCount = await queryLiveSanityDatasetDirectly<number>(
      liveProjectId,
      liveDatasetName,
      'count(*[_id == $id])',
      { id: illegalDocumentId },
    );
    expect(createdDocumentCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Helpers — direct data-API access, independent of the connector under test.
// ---------------------------------------------------------------------------

/** Run a GROQ query straight against the data API (bypassing the connector). */
async function queryLiveSanityDatasetDirectly<TResult>(
  projectId: string,
  datasetName: string,
  groqQuery: string,
  groqParams: Record<string, unknown>,
): Promise<TResult> {
  const response = await axios.post<{ result: TResult }>(
    `https://${projectId}.api.sanity.io/${DIRECT_VERIFICATION_DATA_API_VERSION}/data/query/${datasetName}?perspective=published`,
    { query: groqQuery, params: groqParams },
    { headers: { Authorization: `Bearer ${API_KEY}` } },
  );
  return response.data.result;
}

/** Delete documents by id straight through the mutation API (missing ids are no-ops). */
async function deleteLiveSanityDocumentsDirectly(
  projectId: string,
  datasetName: string,
  documentIds: string[],
): Promise<void> {
  await axios.post(
    `https://${projectId}.api.sanity.io/${DIRECT_VERIFICATION_DATA_API_VERSION}/data/mutate/${datasetName}`,
    { mutations: documentIds.map((documentId) => ({ delete: { id: documentId } })) },
    { headers: { Authorization: `Bearer ${API_KEY}` } },
  );
}

/**
 * Assert that every field we wrote reads back deep-equal — the Connector Prime
 * Directive check: Sanity stores document content verbatim, so any drift between
 * the written shape and the stored shape is a write-path bug. Server-managed system
 * fields the test didn't write (_rev, _createdAt, _updatedAt) are not compared.
 */
function expectEveryWrittenFieldToReadBackVerbatim(
  writtenDocument: Record<string, unknown>,
  readBackDocument: Record<string, unknown> | null,
): void {
  expect(readBackDocument).not.toBeNull();
  if (!readBackDocument) return; // type narrowing — the expect above already failed
  for (const [writtenFieldName, writtenFieldValue] of Object.entries(writtenDocument)) {
    expect(readBackDocument[writtenFieldName]).toEqual(writtenFieldValue);
  }
}
