import { type DataSourceObjectResponse } from '@notionhq/client';
import {
  areFieldValuesCanonicallyEqual,
  resolveFieldValueCanonicalizersForTable,
} from 'src/remote-service/connectors/field-value-canonicalization';
import { Service } from 'src/remote-service/connectors/service-constants';
import { notionFieldValueCanonicalizerForPropertyType } from '../notion-field-value-canonicalizer';
import { buildNotionJsonTableSpec } from '../notion-json-schema';
// Registers the Notion connector (and its `resolveFieldValueCanonicalizer` hook) with the registry.
import '../notion-connector';

/** The decorated shape Notion returns on a pull vs the minimal shape the sync's pack writes. */
const ANNOTATIONS = {
  bold: false,
  italic: false,
  strikethrough: false,
  underline: false,
  code: false,
  color: 'default',
};

function expectSame(notionType: string, pulled: unknown, written: unknown): void {
  const canonicalizer = notionFieldValueCanonicalizerForPropertyType(notionType);
  if (!canonicalizer) throw new Error(`expected a canonicalizer for ${notionType}`);
  expect(areFieldValuesCanonicallyEqual(canonicalizer, pulled, written)).toBe(true);
}

function expectDifferent(notionType: string, pulled: unknown, written: unknown): void {
  const canonicalizer = notionFieldValueCanonicalizerForPropertyType(notionType);
  if (!canonicalizer) throw new Error(`expected a canonicalizer for ${notionType}`);
  expect(areFieldValuesCanonicallyEqual(canonicalizer, pulled, written)).toBe(false);
}

describe('notionFieldValueCanonicalizerForPropertyType', () => {
  describe('title / rich_text', () => {
    const pulledTitle = {
      id: 'title',
      type: 'title',
      title: [
        {
          type: 'text',
          text: { content: 'getguru', link: null },
          annotations: ANNOTATIONS,
          plain_text: 'getguru',
          href: null,
        },
      ],
    };
    const writtenTitle = {
      type: 'title',
      title: [{ text: { content: 'getguru' }, type: 'text', plain_text: 'getguru' }],
    };

    it('treats the decorated pull shape and the minimal write shape of the same text as equal (the DEV-10556 repro)', () => {
      expectSame('title', pulledTitle, writtenTitle);
    });

    it('treats spans Notion merged or split differently as equal when the plain text agrees', () => {
      const splitSpans = {
        type: 'rich_text',
        rich_text: [
          {
            type: 'text',
            text: { content: 'get', link: null },
            annotations: ANNOTATIONS,
            plain_text: 'get',
            href: null,
          },
          {
            type: 'text',
            text: { content: 'guru', link: null },
            annotations: ANNOTATIONS,
            plain_text: 'guru',
            href: null,
          },
        ],
      };
      const oneSpan = {
        type: 'rich_text',
        rich_text: [{ type: 'text', text: { content: 'getguru' }, plain_text: 'getguru' }],
      };
      expectSame('rich_text', splitSpans, oneSpan);
    });

    it('still sees a content change, and a clear', () => {
      expectDifferent('title', pulledTitle, {
        type: 'title',
        title: [{ text: { content: 'getguru 2' }, type: 'text', plain_text: 'getguru 2' }],
      });
      expectDifferent('title', pulledTitle, { type: 'title', title: [] });
    });

    it('treats an empty span array, a missing property and null as the same (cleared) value', () => {
      expectSame('rich_text', { id: 'x', type: 'rich_text', rich_text: [] }, { type: 'rich_text', rich_text: [] });
      expectSame('rich_text', { id: 'x', type: 'rich_text', rich_text: [] }, undefined);
    });

    it('is deliberately lossy about formatting: a bold-only difference compares equal', () => {
      const bold = {
        type: 'title',
        title: [
          {
            type: 'text',
            text: { content: 'getguru', link: null },
            annotations: { ...ANNOTATIONS, bold: true },
            plain_text: 'getguru',
            href: null,
          },
        ],
      };
      expectSame('title', pulledTitle, bold);
    });
  });

  describe('select / status / multi_select', () => {
    it('ignores the option id and color Notion adds on read', () => {
      expectSame(
        'select',
        { id: 'abc', type: 'select', select: { id: 'opt_1', name: 'Live', color: 'green' } },
        { type: 'select', select: { name: 'Live' } },
      );
      expectSame(
        'status',
        { id: 'abc', type: 'status', status: { id: 'opt_1', name: 'Done', color: 'green' } },
        { type: 'status', status: { name: 'Done' } },
      );
      expectSame(
        'multi_select',
        {
          type: 'multi_select',
          multi_select: [
            { id: '1', name: 'A', color: 'red' },
            { id: '2', name: 'B', color: 'blue' },
          ],
        },
        { type: 'multi_select', multi_select: [{ name: 'A' }, { name: 'B' }] },
      );
    });

    it('sees a changed option, a cleared option, and a reordered multi_select', () => {
      expectDifferent(
        'select',
        { type: 'select', select: { id: 'opt_1', name: 'Live', color: 'green' } },
        { type: 'select', select: { name: 'Draft' } },
      );
      expectDifferent(
        'select',
        { type: 'select', select: { id: 'opt_1', name: 'Live', color: 'green' } },
        { type: 'select', select: null },
      );
      expectSame('select', { type: 'select', select: null }, { type: 'select', select: null });
      expectDifferent(
        'multi_select',
        { type: 'multi_select', multi_select: [{ name: 'A' }, { name: 'B' }] },
        { type: 'multi_select', multi_select: [{ name: 'B' }, { name: 'A' }] },
      );
    });
  });

  describe('relation', () => {
    it('ignores has_more and compares the linked ids in order', () => {
      expectSame(
        'relation',
        { id: 'r', type: 'relation', relation: [{ id: 'p1' }, { id: 'p2' }], has_more: false },
        { type: 'relation', relation: [{ id: 'p1' }, { id: 'p2' }] },
      );
      expectDifferent(
        'relation',
        { type: 'relation', relation: [{ id: 'p1' }, { id: 'p2' }], has_more: false },
        { type: 'relation', relation: [{ id: 'p1' }] },
      );
    });
  });

  describe('people', () => {
    const pulledUser = {
      object: 'user',
      id: 'u1',
      name: 'Ada',
      avatar_url: 'https://img.example.com/ada.png',
      type: 'person',
      person: { email: 'ada@example.com' },
    };

    it('ignores the property-level id and the user decorations Notion adds on read, comparing user ids in order', () => {
      expectSame(
        'people',
        { id: 'eTyO', type: 'people', people: [pulledUser, { ...pulledUser, id: 'u2', name: 'Bob' }] },
        {
          type: 'people',
          people: [
            { object: 'user', id: 'u1' },
            { object: 'user', id: 'u2' },
          ],
        },
      );
      // The full-row.json repro: an empty pulled value vs the sync's packed empty value.
      expectSame('people', { id: 'eTyO', type: 'people', people: [] }, { type: 'people', people: [] });
    });

    it('sees a changed, added, removed and reordered user', () => {
      const written = { type: 'people', people: [{ object: 'user', id: 'u1' }] };
      expectDifferent('people', { type: 'people', people: [{ ...pulledUser, id: 'u9' }] }, written);
      expectDifferent('people', { type: 'people', people: [pulledUser, { ...pulledUser, id: 'u2' }] }, written);
      expectDifferent('people', { type: 'people', people: [] }, written);
      expectDifferent(
        'people',
        { type: 'people', people: [{ ...pulledUser, id: 'u2' }, pulledUser] },
        {
          type: 'people',
          people: [
            { object: 'user', id: 'u1' },
            { object: 'user', id: 'u2' },
          ],
        },
      );
    });
  });

  describe('files', () => {
    const externalUrl = 'https://cdn.example.com/brochure.pdf';
    const pulledExternalFile = { name: externalUrl, type: 'external', external: { url: externalUrl } };
    const pulledHostedFile = (signature: string) => ({
      name: 'photo.png',
      type: 'file',
      file: { url: `https://s3.amazonaws.com/notion/photo.png?X-Amz-Signature=${signature}`, expiry_time: signature },
    });

    it('ignores the property-level id and compares external files by URL', () => {
      expectSame(
        'files',
        { id: 'ifWr', type: 'files', files: [pulledExternalFile] },
        { type: 'files', files: [{ type: 'external', name: externalUrl, external: { url: externalUrl } }] },
      );
      // The full-row.json repro: an empty pulled value vs the sync's packed empty value.
      expectSame('files', { id: 'ifWr', type: 'files', files: [] }, { type: 'files', files: [] });
    });

    it('compares a Notion-hosted file by name, never by its signed URL that rotates on every read', () => {
      expectSame(
        'files',
        { type: 'files', files: [pulledHostedFile('sig-from-first-read')] },
        { type: 'files', files: [pulledHostedFile('sig-from-second-read')] },
      );
    });

    it('sees a changed URL, an added file, a removed file and a reordered list', () => {
      const written = {
        type: 'files',
        files: [{ type: 'external', name: externalUrl, external: { url: externalUrl } }],
      };
      const otherUrl = 'https://cdn.example.com/other.pdf';
      const otherFile = { name: otherUrl, type: 'external', external: { url: otherUrl } };
      expectDifferent('files', { type: 'files', files: [otherFile] }, written);
      expectDifferent('files', { type: 'files', files: [pulledExternalFile, otherFile] }, written);
      expectDifferent('files', { type: 'files', files: [] }, written);
      expectDifferent(
        'files',
        { type: 'files', files: [otherFile, pulledExternalFile] },
        { type: 'files', files: [pulledExternalFile, otherFile] },
      );
    });
  });

  describe('number / checkbox / url / email / phone_number', () => {
    it('compares the payload, tolerating float64 round-trip noise and the null/absent spellings', () => {
      expectSame('number', { id: 'n', type: 'number', number: 0.1 + 0.2 }, { type: 'number', number: 0.3 });
      expectDifferent('number', { type: 'number', number: 1 }, { type: 'number', number: 2 });
      expectSame('number', { type: 'number', number: null }, { type: 'number', number: null });
      expectSame('checkbox', { id: 'c', type: 'checkbox', checkbox: true }, { type: 'checkbox', checkbox: true });
      expectDifferent('checkbox', { type: 'checkbox', checkbox: true }, { type: 'checkbox', checkbox: false });
      expectSame('url', { id: 'u', type: 'url', url: 'https://x.y' }, { type: 'url', url: 'https://x.y' });
      expectSame('url', { type: 'url', url: null }, { type: 'url', url: null });
      expectSame('email', { type: 'email', email: 'a@b.c' }, { type: 'email', email: 'a@b.c' });
      expectSame(
        'phone_number',
        { type: 'phone_number', phone_number: '+1' },
        { type: 'phone_number', phone_number: '+1' },
      );
      expectDifferent('url', { type: 'url', url: 'https://x.y' }, { type: 'url', url: 'https://x.z' });
    });
  });

  describe('date', () => {
    it("treats Notion's re-rendered, minute-truncated echo of a written timestamp as equal", () => {
      expectSame(
        'date',
        { id: 'd', type: 'date', date: { start: '2026-07-23T21:12:00.000+00:00', end: null, time_zone: null } },
        { type: 'date', date: { start: '2026-07-23T21:12:27Z' } },
      );
      expectSame(
        'date',
        { type: 'date', date: { start: '2026-12-25', end: null, time_zone: null } },
        { type: 'date', date: { start: '2026-12-25' } },
      );
    });

    it('sees a changed start, a changed end, and a clear', () => {
      expectDifferent(
        'date',
        { type: 'date', date: { start: '2026-07-23T21:12:00.000+00:00', end: null, time_zone: null } },
        { type: 'date', date: { start: '2026-07-23T21:13:00Z' } },
      );
      expectDifferent(
        'date',
        { type: 'date', date: { start: '2026-07-23', end: '2026-07-24', time_zone: null } },
        { type: 'date', date: { start: '2026-07-23' } },
      );
      expectDifferent(
        'date',
        { type: 'date', date: { start: '2026-07-23', end: null, time_zone: null } },
        { type: 'date', date: null },
      );
      expectSame('date', { type: 'date', date: null }, { type: 'date', date: null });
    });
  });

  it('declares nothing for read-only types (structural compare)', () => {
    for (const notionType of [
      'formula',
      'rollup',
      'created_time',
      'last_edited_time',
      'created_by',
      'last_edited_by',
      'unique_id',
      'verification',
      'button',
      'no_such_type',
    ]) {
      expect(notionFieldValueCanonicalizerForPropertyType(notionType)).toBeUndefined();
    }
  });
});

describe('Notion registry hook on a real built table spec', () => {
  function buildDataSource(): DataSourceObjectResponse {
    return {
      object: 'data_source',
      id: 'ds_123',
      title: [{ plain_text: 'My DB' }],
      properties: {
        Name: { id: 'title', name: 'Name', type: 'title' },
        Notes: { id: 'n1', name: 'Notes', type: 'rich_text', rich_text: {} },
        Stage: { id: 's1', name: 'Stage', type: 'select', select: { options: [] } },
        When: { id: 'd1', name: 'When', type: 'date', date: {} },
        Owner: { id: 'p1', name: 'Owner', type: 'people', people: {} },
        Total: { id: 'f1', name: 'Total', type: 'formula', formula: { expression: '1' } },
      },
    } as unknown as DataSourceObjectResponse;
  }

  it('resolves a canonicalizer for every writable property and none for the envelope or read-only fields', () => {
    const spec = buildNotionJsonTableSpec({ wsId: 'db', remoteId: ['db_123', 'ds_123'] }, buildDataSource());
    const canonicalizers = resolveFieldValueCanonicalizersForTable(Service.NOTION, spec);

    expect([...canonicalizers.keys()].sort()).toEqual(
      ['properties.Name', 'properties.Notes', 'properties.Stage', 'properties.When', 'properties.Owner'].sort(),
    );
    expect(canonicalizers.has('properties.Total')).toBe(false);
    expect(canonicalizers.has('id')).toBe(false);
    expect(canonicalizers.has('properties')).toBe(false);
    expect(canonicalizers.has('last_edited_time')).toBe(false);

    const name = canonicalizers.get('properties.Name');
    if (!name) throw new Error('expected a canonicalizer for properties.Name');
    expect(
      areFieldValuesCanonicallyEqual(
        name,
        {
          id: 'title',
          type: 'title',
          title: [
            { type: 'text', text: { content: 'x', link: null }, annotations: ANNOTATIONS, plain_text: 'x', href: null },
          ],
        },
        { type: 'title', title: [{ text: { content: 'x' }, type: 'text', plain_text: 'x' }] },
      ),
    ).toBe(true);
  });
});
