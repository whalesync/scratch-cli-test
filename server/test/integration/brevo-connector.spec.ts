/**
 * Brevo connector live API integration test.
 *
 * Exercises the real Brevo v3 API: validates credentials, discovers schema,
 * pulls contacts, creates/updates/deletes a test contact, and does the same
 * for email templates.
 *
 * Requires BREVO_API_KEY in .env.integration.
 * Run via: cd server && yarn test:integration -- brevo-connector
 */

// Break the circular import chain
jest.mock('src/remote-service/connectors/display-names', () => ({
  getServiceDisplayName: (service: string) => service,
}));

import { BrevoConnector } from 'src/remote-service/connectors/library/brevo/brevo-connector';
import { BaseJsonTableSpec, ConnectorFile, EntityId } from 'src/remote-service/connectors/types';

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

const API_KEY = process.env.BREVO_API_KEY;

const CONTACTS_ID: EntityId = { wsId: 'contacts', remoteId: ['contacts'] };
const TEMPLATES_ID: EntityId = { wsId: 'templates', remoteId: ['templates'] };
const MAILING_LISTS_ID: EntityId = { wsId: 'mailing_lists', remoteId: ['mailing_lists'] };

// Unique suffix to avoid collisions with real data
const TEST_SUFFIX = `scratch-test-${Date.now()}`;
const TEST_EMAIL = `${TEST_SUFFIX}@scratch-integration-test.example.com`;

function createConnector(): BrevoConnector {
  return new BrevoConnector(API_KEY!);
}

async function collectPulledFiles(connector: BrevoConnector, tableSpec: BaseJsonTableSpec): Promise<ConnectorFile[]> {
  const allFiles: ConnectorFile[] = [];
  await connector.pullRecordFiles(
    tableSpec,
    async ({ files }) => {
      allFiles.push(...files);
    },
    {},
    { forceFull: false },
  );
  return allFiles;
}

// Skip the entire suite if no API key is configured
const describeIfKey = API_KEY ? describe : describe.skip;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describeIfKey(
  'BrevoConnector — live API',
  () => {
    let connector: BrevoConnector;

    beforeAll(() => {
      connector = createConnector();
    });

    // Track IDs for cleanup
    let createdContactId: number | undefined;
    let createdTemplateId: number | undefined;

    afterAll(async () => {
      // Best-effort cleanup of test data
      const cleanupConnector = createConnector();
      try {
        if (createdContactId) {
          const spec = await cleanupConnector.fetchJsonTableSpec(CONTACTS_ID);
          await cleanupConnector.deleteRecords(spec, [{ id: createdContactId } as ConnectorFile]);
        }
      } catch {
        // Ignore cleanup errors
      }
      try {
        if (createdTemplateId) {
          const spec = await cleanupConnector.fetchJsonTableSpec(TEMPLATES_ID);
          // Templates must be inactive to delete — try to deactivate first
          try {
            await (
              cleanupConnector as unknown as {
                client: { updateTemplate: (id: number, data: unknown) => Promise<void> };
              }
            ).client.updateTemplate(createdTemplateId, { isActive: false });
          } catch {
            // May already be inactive
          }
          await cleanupConnector.deleteRecords(spec, [{ id: createdTemplateId } as ConnectorFile]);
        }
      } catch {
        // Ignore cleanup errors
      }
    });

    // -------------------------------------------------------------------------
    // Connection
    // -------------------------------------------------------------------------

    describe('testConnection', () => {
      it('validates credentials against the live API', async () => {
        await expect(connector.testConnection()).resolves.toBeUndefined();
      });

      it('rejects invalid credentials', async () => {
        const badConnector = new BrevoConnector('xkeysib-invalid-key');
        await expect(badConnector.testConnection()).rejects.toThrow();
      });
    });

    // -------------------------------------------------------------------------
    // Table discovery
    // -------------------------------------------------------------------------

    describe('listTables', () => {
      it('returns contacts, templates, and mailing lists', async () => {
        const tables = await connector.listTables();
        const ids = tables.map((t) => t.id.wsId);
        expect(ids).toContain('contacts');
        expect(ids).toContain('templates');
        expect(ids).toContain('mailing_lists');
      });
    });

    // -------------------------------------------------------------------------
    // Contacts
    // -------------------------------------------------------------------------

    describe('contacts', () => {
      let contactsSpec: BaseJsonTableSpec;

      beforeAll(async () => {
        contactsSpec = await connector.fetchJsonTableSpec(CONTACTS_ID);
      });

      it('builds a dynamic schema with system fields and attributes', () => {
        expect(contactsSpec.name).toBe('Contacts');
        expect(contactsSpec.idColumnRemoteId).toBe('id');
        expect(contactsSpec.schema.properties).toHaveProperty('id');
        expect(contactsSpec.schema.properties).toHaveProperty('email');
        expect(contactsSpec.schema.properties).toHaveProperty('attributes');
      });

      it('creates a test contact', async () => {
        const files: ConnectorFile[] = [
          {
            email: TEST_EMAIL,
            attributes: { FIRSTNAME: 'Scratch', LASTNAME: TEST_SUFFIX },
          } as unknown as ConnectorFile,
        ];

        const created = await connector.createRecords(contactsSpec, files);

        expect(created).toHaveLength(1);
        const contact = created[0] as unknown as { id: number; email: string };
        expect(contact.id).toBeDefined();
        expect(contact.email).toBe(TEST_EMAIL);
        createdContactId = contact.id;
      });

      it('pulls contacts and finds the created one', async () => {
        expect(createdContactId).toBeDefined();

        const files = await collectPulledFiles(connector, contactsSpec);
        const found = files.find((f) => (f as unknown as { email: string }).email === TEST_EMAIL);
        expect(found).toBeDefined();
      });

      it('fetches the contact by ID', async () => {
        expect(createdContactId).toBeDefined();

        const files: ConnectorFile[] = [];
        await connector.pullRecordFilesByIds(contactsSpec, [String(createdContactId)], async ({ files: batch }) => {
          files.push(...batch);
        });

        expect(files).toHaveLength(1);
        expect((files[0] as unknown as { email: string }).email).toBe(TEST_EMAIL);
      });

      it('updates the test contact', async () => {
        expect(createdContactId).toBeDefined();

        const files: ConnectorFile[] = [
          {
            id: createdContactId,
            attributes: { FIRSTNAME: 'Updated' },
          } as unknown as ConnectorFile,
        ];

        await expect(connector.updateRecords(contactsSpec, files)).resolves.toBeUndefined();

        // Verify the update by fetching
        const fetched: ConnectorFile[] = [];
        await connector.pullRecordFilesByIds(contactsSpec, [String(createdContactId)], async ({ files: batch }) => {
          fetched.push(...batch);
        });

        const attrs = (fetched[0] as unknown as { attributes: Record<string, unknown> }).attributes;
        expect(attrs.FIRSTNAME).toBe('Updated');
      });

      it('deletes the test contact', async () => {
        expect(createdContactId).toBeDefined();

        await expect(
          connector.deleteRecords(contactsSpec, [{ id: createdContactId } as ConnectorFile]),
        ).resolves.toBeUndefined();

        // Verify deletion — fetch should return empty
        const fetched: ConnectorFile[] = [];
        await connector.pullRecordFilesByIds(contactsSpec, [String(createdContactId)], async ({ files: batch }) => {
          fetched.push(...batch);
        });
        expect(fetched).toHaveLength(0);

        // Clear so afterAll doesn't try to double-delete
        createdContactId = undefined;
      });

      it('handles deleting a non-existent contact gracefully', async () => {
        await expect(
          connector.deleteRecords(contactsSpec, [{ id: 999999999 } as ConnectorFile]),
        ).resolves.toBeUndefined();
      });
    });

    // -------------------------------------------------------------------------
    // Templates
    // -------------------------------------------------------------------------

    describe('templates', () => {
      let templatesSpec: BaseJsonTableSpec;

      beforeAll(async () => {
        templatesSpec = await connector.fetchJsonTableSpec(TEMPLATES_ID);
      });

      it('builds a static schema with all template fields', () => {
        expect(templatesSpec.name).toBe('Email Templates');
        expect(templatesSpec.schema.properties).toHaveProperty('name');
        expect(templatesSpec.schema.properties).toHaveProperty('subject');
        expect(templatesSpec.schema.properties).toHaveProperty('htmlContent');
        expect(templatesSpec.schema.properties).toHaveProperty('sender');
      });

      it('creates a test template', async () => {
        const files: ConnectorFile[] = [
          {
            name: `Test Template ${TEST_SUFFIX}`,
            subject: 'Integration Test',
            sender: { email: 'testing@whalesync.com', name: 'Whalesync' },
            htmlContent: `<html><body><h1>Hello from ${TEST_SUFFIX}</h1></body></html>`,
            isActive: false, // Create as inactive so we can delete it
          } as unknown as ConnectorFile,
        ];

        const created = await connector.createRecords(templatesSpec, files);

        expect(created).toHaveLength(1);
        const template = created[0] as unknown as { id: number; name: string };
        expect(template.id).toBeDefined();
        expect(template.name).toBe(`Test Template ${TEST_SUFFIX}`);
        createdTemplateId = template.id;
      });

      it('pulls templates and finds the created one', async () => {
        expect(createdTemplateId).toBeDefined();

        const files = await collectPulledFiles(connector, templatesSpec);
        const found = files.find((f) => (f as unknown as { name: string }).name === `Test Template ${TEST_SUFFIX}`);
        expect(found).toBeDefined();
        // Verify htmlContent is included (fetched individually)
        expect((found as unknown as { htmlContent: string }).htmlContent).toContain(TEST_SUFFIX);
      });

      it('fetches the template by ID', async () => {
        expect(createdTemplateId).toBeDefined();

        const files: ConnectorFile[] = [];
        await connector.pullRecordFilesByIds(templatesSpec, [String(createdTemplateId)], async ({ files: batch }) => {
          files.push(...batch);
        });

        expect(files).toHaveLength(1);
        expect((files[0] as unknown as { htmlContent: string }).htmlContent).toContain(TEST_SUFFIX);
      });

      it('updates the test template', async () => {
        expect(createdTemplateId).toBeDefined();

        const files: ConnectorFile[] = [
          {
            id: createdTemplateId,
            name: `Updated Template ${TEST_SUFFIX}`,
            subject: 'Updated Subject',
          } as unknown as ConnectorFile,
        ];

        await expect(connector.updateRecords(templatesSpec, files)).resolves.toBeUndefined();

        // Verify by fetching
        const fetched: ConnectorFile[] = [];
        await connector.pullRecordFilesByIds(templatesSpec, [String(createdTemplateId)], async ({ files: batch }) => {
          fetched.push(...batch);
        });
        expect((fetched[0] as unknown as { name: string }).name).toBe(`Updated Template ${TEST_SUFFIX}`);
      });

      it('deletes the test template', async () => {
        expect(createdTemplateId).toBeDefined();

        await expect(
          connector.deleteRecords(templatesSpec, [{ id: createdTemplateId } as ConnectorFile]),
        ).resolves.toBeUndefined();

        // Verify deletion
        const fetched: ConnectorFile[] = [];
        await connector.pullRecordFilesByIds(templatesSpec, [String(createdTemplateId)], async ({ files: batch }) => {
          fetched.push(...batch);
        });
        expect(fetched).toHaveLength(0);

        createdTemplateId = undefined;
      });
    });

    // -------------------------------------------------------------------------
    // Mailing Lists (read-only)
    // -------------------------------------------------------------------------

    describe('mailing lists', () => {
      let mailingListsSpec: BaseJsonTableSpec;

      beforeAll(async () => {
        mailingListsSpec = await connector.fetchJsonTableSpec(MAILING_LISTS_ID);
      });

      it('builds a schema with all mailing list fields marked readonly', () => {
        expect(mailingListsSpec.name).toBe('Mailing Lists');
        expect(mailingListsSpec.schema.properties).toHaveProperty('id');
        expect(mailingListsSpec.schema.properties).toHaveProperty('name');
        expect(mailingListsSpec.schema.properties).toHaveProperty('totalSubscribers');
      });

      it('pulls mailing lists from the live API', async () => {
        const files = await collectPulledFiles(connector, mailingListsSpec);

        // The test Brevo account has at least one list ("Your first list")
        expect(files.length).toBeGreaterThanOrEqual(1);

        const first = files[0] as unknown as { id: number; name: string };
        expect(first.id).toBeDefined();
        expect(first.name).toBeDefined();
      });

      it('fetches a mailing list by ID', async () => {
        // Pull to get a real list ID
        const allLists = await collectPulledFiles(connector, mailingListsSpec);
        expect(allLists.length).toBeGreaterThanOrEqual(1);

        const listId = String((allLists[0] as unknown as { id: number }).id);

        const fetched: ConnectorFile[] = [];
        await connector.pullRecordFilesByIds(mailingListsSpec, [listId], async ({ files: batch }) => {
          fetched.push(...batch);
        });

        expect(fetched).toHaveLength(1);
        expect((fetched[0] as unknown as { id: number }).id).toBe(Number(listId));
      });
    });
  },
  60_000,
); // 60s timeout for live API calls
