import { type DataSourceObjectResponse } from '@notionhq/client';
import { FormatRegistry } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { buildNotionJsonTableSpec } from '../notion-json-schema';
import benTossellRecord from './testdata/notion-investor-crm-ben-tossell.json';

// The generated schema annotates strings with `format: 'date-time' | 'uri' | 'email'`.
// Nothing runs Value.Check against these schemas at runtime (they are serialized to
// JSON and stored), so the codebase registers no format validators. This regression
// lock is a *structural* check, so we register permissive validators (any string) —
// otherwise TypeBox treats the unknown formats as validation failures.
for (const format of ['date', 'date-time', 'uri', 'email']) {
  if (!FormatRegistry.Has(format)) {
    FormatRegistry.Set(format, (value) => typeof value === 'string');
  }
}

/**
 * REGRESSION LOCK (IRON RULE): validate a real on-disk record and a synthetic
 * all-types record against the schema the connector actually generates.
 *
 * This is the test that would have caught the original defect: the generated
 * JSON schema described the unwrapped per-property value, but records on disk
 * store the raw Notion envelope `{ id, type, <typeKey>: value }`. Before the
 * fix, Value.Check failed on every property. See
 * docs/plans/2026-06-02-notion-schema-envelope-fix.md.
 */

const TABLE_ID = { wsId: 'crm', remoteId: ['db_123', 'ds_123'] };

/** Build a DataSourceObjectResponse from a `{ name: { id, type } }` property map. */
function buildDataSource(
  properties: Record<string, { id: string; type: string; relation?: { database_id: string } }>,
): DataSourceObjectResponse {
  return {
    object: 'data_source',
    id: 'ds_123',
    title: [{ plain_text: 'CRM' }],
    properties: Object.fromEntries(Object.entries(properties).map(([name, def]) => [name, { name, ...def }])),
  } as unknown as DataSourceObjectResponse;
}

/** Assert Value.Check passes, dumping the first few validation errors otherwise. */
function expectValid(schema: unknown, record: unknown): void {
  const schemaT = schema as Parameters<typeof Value.Check>[0];
  if (!Value.Check(schemaT, record)) {
    const errors = [...Value.Errors(schemaT, record)].slice(0, 10).map((e) => `${e.path}: ${e.message}`);
    throw new Error(`record did not validate against generated schema:\n${errors.join('\n')}`);
  }
  expect(Value.Check(schemaT, record)).toBe(true);
}

describe('Notion schema regression lock — record validates against generated schema', () => {
  it('validates the real investor_crm/ben-tossell.json record', () => {
    // Derive a data source whose property types match the on-disk record.
    const properties: Record<string, { id: string; type: string }> = {};
    for (const [name, value] of Object.entries(
      benTossellRecord.properties as Record<string, { id: string; type: string }>,
    )) {
      properties[name] = { id: value.id, type: value.type };
    }

    const spec = buildNotionJsonTableSpec(TABLE_ID, buildDataSource(properties));
    expectValid(spec.schema, benTossellRecord);
  });

  it('validates a synthetic record with one property of every Notion type', () => {
    const dataSource = buildDataSource({
      Title: { id: 'title', type: 'title' },
      Notes: { id: 'p_rt', type: 'rich_text' },
      Score: { id: 'p_num', type: 'number' },
      Priority: { id: 'p_sel', type: 'select' },
      Stage: { id: 'p_status', type: 'status' },
      Tags: { id: 'p_ms', type: 'multi_select' },
      Due: { id: 'p_date', type: 'date' },
      DueDateOnly: { id: 'p_date2', type: 'date' },
      Owners: { id: 'p_ppl', type: 'people' },
      Attachments: { id: 'p_files', type: 'files' },
      Done: { id: 'p_cb', type: 'checkbox' },
      Site: { id: 'p_url', type: 'url' },
      Email: { id: 'p_email', type: 'email' },
      Phone: { id: 'p_phone', type: 'phone_number' },
      Computed: { id: 'p_formula', type: 'formula' },
      Linked: { id: 'p_rel', type: 'relation', relation: { database_id: 'db_linked' } },
      Total: { id: 'p_rollup', type: 'rollup' },
      Created: { id: 'p_ct', type: 'created_time' },
      Creator: { id: 'p_cb_user', type: 'created_by' },
      Edited: { id: 'p_let', type: 'last_edited_time' },
      Editor: { id: 'p_leb_user', type: 'last_edited_by' },
      Mystery: { id: 'p_unknown', type: 'wacky_future_type' },
    });

    const spec = buildNotionJsonTableSpec(TABLE_ID, dataSource);

    const user = { object: 'user', id: 'user_1' };
    const record = {
      object: 'page',
      id: 'page_1',
      created_time: '2026-01-01T00:00:00.000Z',
      last_edited_time: '2026-01-02T00:00:00.000Z',
      created_by: user,
      last_edited_by: user,
      cover: null,
      icon: null,
      parent: { type: 'data_source_id', data_source_id: 'ds_123', database_id: 'db_123' },
      archived: false,
      in_trash: false,
      page_content: [],
      properties: {
        Title: {
          id: 'title',
          type: 'title',
          title: [{ type: 'text', text: { content: 'Hi', link: null }, plain_text: 'Hi', href: null }],
        },
        Notes: { id: 'p_rt', type: 'rich_text', rich_text: [] },
        Score: { id: 'p_num', type: 'number', number: 42 },
        // null inner value (an unset select).
        Priority: { id: 'p_sel', type: 'select', select: null },
        Stage: { id: 'p_status', type: 'status', status: { id: 's1', name: 'In Progress', color: 'blue' } },
        Tags: { id: 'p_ms', type: 'multi_select', multi_select: [{ id: 't1', name: 'A', color: 'red' }] },
        Due: { id: 'p_date', type: 'date', date: { start: '2026-03-01T00:00:00.000Z', end: null, time_zone: null } },
        // Date-only value (no time component) — Notion emits these for all-day dates.
        DueDateOnly: { id: 'p_date2', type: 'date', date: { start: '2025-02-20', end: null, time_zone: null } },
        Owners: { id: 'p_ppl', type: 'people', people: [{ object: 'user', id: 'u1', name: 'Ada' }] },
        Attachments: {
          id: 'p_files',
          type: 'files',
          files: [
            {
              name: 'doc.pdf',
              type: 'file',
              file: { url: 'https://x/doc.pdf', expiry_time: '2026-03-01T00:00:00.000Z' },
            },
          ],
        },
        Done: { id: 'p_cb', type: 'checkbox', checkbox: true },
        Site: { id: 'p_url', type: 'url', url: 'https://example.com' },
        Email: { id: 'p_email', type: 'email', email: 'a@b.com' },
        Phone: { id: 'p_phone', type: 'phone_number', phone_number: '+15551234567' },
        Computed: { id: 'p_formula', type: 'formula', formula: { type: 'number', number: 7 } },
        // relation carries the structural `has_more` sibling.
        Linked: { id: 'p_rel', type: 'relation', relation: [{ id: 'rel_1' }], has_more: false },
        Total: { id: 'p_rollup', type: 'rollup', rollup: { type: 'number', function: 'sum', number: 10 } },
        Created: { id: 'p_ct', type: 'created_time', created_time: '2026-01-01T00:00:00.000Z' },
        Creator: { id: 'p_cb_user', type: 'created_by', created_by: user },
        Edited: { id: 'p_let', type: 'last_edited_time', last_edited_time: '2026-01-02T00:00:00.000Z' },
        Editor: { id: 'p_leb_user', type: 'last_edited_by', last_edited_by: user },
        // unknown/future type: opaque inner value still validates (Type.Unknown).
        Mystery: { id: 'p_unknown', type: 'wacky_future_type', wacky_future_type: { whatever: true } },
      },
      url: 'https://www.notion.so/page_1',
      public_url: null,
    };

    expectValid(spec.schema, record);
  });

  it('validates the built-in named-icon and custom_emoji page icon shapes', () => {
    const spec = buildNotionJsonTableSpec(TABLE_ID, buildDataSource({ Title: { id: 'title', type: 'title' } }));
    const user = { object: 'user', id: 'user_1' };
    const basePage = {
      object: 'page',
      id: 'page_1',
      created_time: '2026-01-01T00:00:00.000Z',
      last_edited_time: '2026-01-02T00:00:00.000Z',
      created_by: user,
      last_edited_by: user,
      cover: null,
      parent: { type: 'data_source_id', data_source_id: 'ds_123', database_id: 'db_123' },
      archived: false,
      in_trash: false,
      properties: {
        Title: {
          id: 'title',
          type: 'title',
          title: [{ type: 'text', text: { content: 'Hi', link: null }, plain_text: 'Hi', href: null }],
        },
      },
      url: 'https://www.notion.so/page_1',
      public_url: null,
    };

    // Built-in named icon, e.g. picked from Notion's icon library.
    expectValid(spec.schema, { ...basePage, icon: { type: 'icon', icon: { name: 'light-bulb', color: 'orange' } } });
    // Custom uploaded emoji.
    expectValid(spec.schema, {
      ...basePage,
      icon: { type: 'custom_emoji', custom_emoji: { id: 'ce_1', name: 'party', url: 'https://x/ce.png' } },
    });
  });
});
