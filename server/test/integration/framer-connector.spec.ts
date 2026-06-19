/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-explicit-any, @typescript-eslint/no-non-null-assertion */

/**
 * Framer connector live-API integration test.
 *
 * Drives the connector directly (no Scratch server, no GCS) against the real
 * Framer Server API over the `framer-api` WebSocket SDK, exercising the four
 * capabilities: get schemas, pull, publish (CRUD round-trip), and error handling.
 *
 * Requires FRAMER_API_KEY + FRAMER_PROJECT_URL in .env.integration, and the
 * project must be bootstrapped with the durable fixture collections via
 *   npx tsx scripts/bootstrap-framer-test-data.mts
 * which provisions a "Tags" collection (items `design`, `engineering`) and a
 * "Field Types" collection with one field of every Framer CMS type. Framer has
 * no delete-collection API, so the suite round-trips ITEMS inside that fixture
 * (create → read-back → update → delete) rather than creating throwaway tables.
 *
 * Run: cd server && yarn test:integration -- framer-connector
 *
 * ⚠️ ESM/jest limitation: `framer-api` is a pure-ESM package whose module graph
 * uses top-level await, which the connector loads via a runtime dynamic import().
 * Jest's default CJS runtime can't invoke that dynamic import (it errors with
 * "A dynamic import callback was invoked without --experimental-vm-modules"), and
 * enabling `--experimental-vm-modules` in turn breaks the CJS `nanoid` require in
 * the shared-types chain. So this live suite does NOT currently run in the shared
 * jest-integration harness; it stays `describe.skip` in CI (no FRAMER key set).
 * The connector's live behavior is validated end-to-end through the scratchmd CLI
 * publish path (real create/update/delete via the running server) and the pure
 * write-translation/schema logic is covered by the unit tests
 * (`framer-write-translation.spec.ts`, `framer-json-schema.spec.ts`). This file is
 * kept as the live contract and will run once an ESM-capable jest setup exists.
 */

// Break the circular import chain (display-names → registry → DB).
jest.mock('src/remote-service/connectors/display-names', () => ({
  getServiceDisplayName: (service: string) => service,
}));

import { randomUUID } from 'crypto';
import { FramerConnector } from 'src/remote-service/connectors/library/framer/framer-connector';
import { BaseJsonTableSpec, ConnectorFile, TablePreview } from 'src/remote-service/connectors/types';

jest.setTimeout(120_000);

const API_KEY = process.env.FRAMER_API_KEY;
const PROJECT_URL = process.env.FRAMER_PROJECT_URL;
const describeIfKey = API_KEY && PROJECT_URL ? describe : describe.skip;

const FIELD_TYPES_COLLECTION = 'Field Types';
const TAGS_COLLECTION = 'Tags';

function createConnector(): FramerConnector {
  return new FramerConnector({ projectUrl: PROJECT_URL!, apiKey: API_KEY! });
}

/** Map a field's display name → its remote field id, read from the table spec. */
function fieldIdByName(tableSpec: BaseJsonTableSpec): Map<string, string> {
  const props = (tableSpec.schema as any).properties.fieldData.properties as Record<string, any>;
  const map = new Map<string, string>();
  for (const [fieldId, sub] of Object.entries(props)) {
    if (sub?.title) map.set(sub.title, fieldId);
  }
  return map;
}

/** Pull every record of a table via the connector and return them. */
async function pullAll(connector: FramerConnector, tableSpec: BaseJsonTableSpec): Promise<ConnectorFile[]> {
  const files: ConnectorFile[] = [];
  await connector.pullRecordFiles(
    tableSpec,
    ({ files: batch }) => {
      files.push(...batch);
      return Promise.resolve();
    },
    {},
    {},
  );
  return files;
}

async function fetchById(
  connector: FramerConnector,
  tableSpec: BaseJsonTableSpec,
  id: string,
): Promise<ConnectorFile | undefined> {
  const out: ConnectorFile[] = [];
  await connector.pullRecordFilesByIds(tableSpec, [id], ({ files }) => {
    out.push(...files);
    return Promise.resolve();
  });
  return out.find((f) => (f as any).id === id);
}

const value = (file: ConnectorFile, fieldId: string): unknown => (file as any).fieldData?.[fieldId]?.value;

describeIfKey('FramerConnector — live API', () => {
  let connector: FramerConnector;
  let tables: TablePreview[];
  let fieldTypesTable: TablePreview;
  let tableSpec: BaseJsonTableSpec;
  let fieldId: Map<string, string>;
  const createdItemIds: string[] = [];

  beforeAll(async () => {
    connector = createConnector();
    tables = await connector.listTables();
    const found = tables.find((t) => t.displayName === FIELD_TYPES_COLLECTION);
    if (!found) {
      throw new Error(
        `Fixture collection "${FIELD_TYPES_COLLECTION}" not found — run: npx tsx scripts/bootstrap-framer-test-data.mts`,
      );
    }
    fieldTypesTable = found;
    tableSpec = await connector.fetchJsonTableSpec(fieldTypesTable.id);
    fieldId = fieldIdByName(tableSpec);
  });

  afterAll(async () => {
    // Clean up any item the suite created but didn't delete (e.g. on assertion failure).
    if (createdItemIds.length > 0) {
      await connector.deleteRecords(tableSpec, createdItemIds.map((id) => ({ id })) as ConnectorFile[]);
    }
  });

  describe('testConnection', () => {
    it('validates real credentials', async () => {
      await expect(connector.testConnection()).resolves.toBeUndefined();
    });

    it('rejects bad credentials', async () => {
      const bad = new FramerConnector({ projectUrl: PROJECT_URL!, apiKey: 'fr_not_a_real_key' });
      await expect(bad.testConnection()).rejects.toBeDefined();
    });
  });

  describe('listTables + schema', () => {
    it('lists the fixture collections', () => {
      const names = tables.map((t) => t.displayName);
      expect(names).toContain(FIELD_TYPES_COLLECTION);
      expect(names).toContain(TAGS_COLLECTION);
    });

    it('builds a schema with the item-meta + fieldData properties', () => {
      const props = (tableSpec.schema as any).properties;
      expect(props.id['x-scratch-readonly']).toBe(true);
      expect(props.slug.type).toBe('string');
      expect(props.fieldData.type).toBe('object');
      expect(tableSpec.idColumnRemoteId).toBe('id');
      expect(tableSpec.slugFieldPath).toBe('slug');
    });

    it('annotates reference fields as foreign keys at the value leaf', () => {
      const refFieldId = fieldId.get('Primary Tag')!;
      const refValueSchema = (tableSpec.schema as any).properties.fieldData.properties[refFieldId].properties.value;
      expect(refValueSchema['x-scratch-foreign-key']).toBeDefined();
      expect(refValueSchema['x-scratch-foreign-key'].linkedTableId).toBeTruthy();
    });
  });

  describe('pull', () => {
    it('pulls items verbatim ({ id, slug, fieldData })', async () => {
      const files = await pullAll(connector, tableSpec);
      for (const file of files) {
        expect(typeof (file as any).id).toBe('string');
        expect(typeof (file as any).slug).toBe('string');
        expect((file as any).fieldData).toBeDefined();
      }
    });
  });

  describe('CRUD round-trip (every field type)', () => {
    const slug = `scratch-it-${randomUUID().slice(0, 8)}`;

    it('creates an item with one value of every field type, id flows back', async () => {
      const fd = (name: string, type: string, v: unknown) => ({ [fieldId.get(name)!]: { type, value: v } });
      const file: ConnectorFile = {
        slug,
        draft: false,
        fieldData: {
          ...fd('Title', 'string', 'Scratch IT'),
          ...fd('Body', 'formattedText', '<p>hello</p>'),
          ...fd('Count', 'number', 42),
          ...fd('Active', 'boolean', true),
          ...fd('When', 'date', '2026-03-15'),
          ...fd('Website', 'link', 'https://example.org'),
          ...fd('Brand', 'color', '#00FF00'),
          ...fd('Stage', 'enum', 'Live'), // by case NAME → connector translates to id
          ...fd('Hero', 'image', { url: 'https://picsum.photos/seed/scratchit/300/200' }),
          ...fd('Primary Tag', 'collectionReference', 'design'), // by SLUG → connector translates to id
          ...fd('Tags', 'multiCollectionReference', ['design', 'engineering']),
        },
      };
      const [created] = await connector.createRecords(tableSpec, [file]);
      const id = (created as any).id;
      expect(typeof id).toBe('string');
      createdItemIds.push(id);

      const readBack = await fetchById(connector, tableSpec, id);
      expect(readBack).toBeDefined();
      expect(value(readBack!, fieldId.get('Title')!)).toBe('Scratch IT');
      expect(value(readBack!, fieldId.get('Count')!)).toBe(42);
      expect(value(readBack!, fieldId.get('Active')!)).toBe(true);
      // enum reads back as the case NAME; reference as the target SLUG.
      expect(value(readBack!, fieldId.get('Stage')!)).toBe('Live');
      expect(value(readBack!, fieldId.get('Primary Tag')!)).toBe('design');
      expect(value(readBack!, fieldId.get('Tags')!)).toEqual(['design', 'engineering']);
      // date normalizes to ISO; image is re-hosted to framerusercontent.
      expect(String(value(readBack!, fieldId.get('When')!))).toContain('2026-03-15');
      expect((value(readBack!, fieldId.get('Hero')!) as any)?.url).toContain('framerusercontent.com');
    });

    it('updates fields (incl. enum + reference re-target) via changedFields', async () => {
      const id = createdItemIds[createdItemIds.length - 1];
      const file: ConnectorFile = { id, slug } as ConnectorFile;
      const changed = {
        fieldData: {
          [fieldId.get('Title')!]: { value: 'Scratch IT v2' },
          [fieldId.get('Count')!]: { value: 7 },
          [fieldId.get('Stage')!]: { value: 'Review' },
          [fieldId.get('Primary Tag')!]: { value: 'engineering' },
        },
      };
      await connector.updateRecords(tableSpec, [file], [changed]);

      const readBack = await fetchById(connector, tableSpec, id);
      expect(value(readBack!, fieldId.get('Title')!)).toBe('Scratch IT v2');
      expect(value(readBack!, fieldId.get('Count')!)).toBe(7);
      expect(value(readBack!, fieldId.get('Stage')!)).toBe('Review');
      expect(value(readBack!, fieldId.get('Primary Tag')!)).toBe('engineering');
    });

    it('deletes the item', async () => {
      const id = createdItemIds.pop()!;
      await connector.deleteRecords(tableSpec, [{ id } as ConnectorFile]);
      const readBack = await fetchById(connector, tableSpec, id);
      expect(readBack).toBeUndefined();
    });
  });
});
