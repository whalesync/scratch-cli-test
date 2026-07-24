import { Type } from '@sinclair/typebox';
import { BaseJsonTableSpec, ConnectorFile, dotPath } from '../../../remote-service/connectors/types';
import { buildGitFilesFromConnectorFiles } from './connector-file-utils';

const tableSpec: BaseJsonTableSpec = {
  idPath: dotPath('id'),
  slugPath: dotPath('slug'),
  titlePath: dotPath('title'),
  id: { remoteId: ['tbl_abc'], wsId: 'tbl_abc' },
  slug: 'crm',
  name: 'CRM',
  schema: Type.Object({}),
};

const rec = (id: string): ConnectorFile => ({ id }) as unknown as ConnectorFile;

describe('buildGitFilesFromConnectorFiles — filename dedup', () => {
  // Regression tests for the data-loss bug where a new record's suggested
  // filename collided with another record's prior filename and both staged
  // to the same path. Pull jobs now seed `usedFileNames` from
  // FileIndexService.listFilenamesForFolder; these tests pin the dedup
  // contract that fix relies on.

  it('gives a new record the recordId suffix when its suggested name is already in usedFileNames', () => {
    // recA was indexed in a prior pull as "john-smith.json" → seeded into usedFileNames.
    // recB is new in this pull and has the same suggested primary-field value.
    // Without the seed, recB would claim "john-smith.json" and later clobber recA.
    const usedFileNames = new Set<string>(['john-smith.json']);
    const existingFileNames = new Map<string, string>(); // recB isn't indexed yet

    const built = buildGitFilesFromConnectorFiles('/CRM', [rec('recB')], tableSpec, usedFileNames, existingFileNames, [
      'John Smith',
    ]);

    expect(built).toHaveLength(1);
    expect(built[0].path).toBe('/CRM/john-smith-recB.json');
    expect(built[0].recordId).toBe('recB');
    expect(usedFileNames.has('john-smith.json')).toBe(true);
    expect(usedFileNames.has('john-smith-recB.json')).toBe(true);
  });

  it('still lets an existing record keep its prior filename even when a new twin is processed first', () => {
    // Order: [new recB, existing recA]. The seed contains recA's prior filename,
    // so recB can't claim it. recA then reuses its existing entry as normal.
    const usedFileNames = new Set<string>(['john-smith.json']);
    const existingFileNames = new Map<string, string>([['recA', 'john-smith.json']]);

    const built = buildGitFilesFromConnectorFiles(
      '/CRM',
      [rec('recB'), rec('recA')],
      tableSpec,
      usedFileNames,
      existingFileNames,
      ['John Smith', 'John Smith'],
    );

    const recAFile = built.find((f) => f.recordId === 'recA');
    const recBFile = built.find((f) => f.recordId === 'recB');
    expect(recAFile?.path).toBe('/CRM/john-smith.json');
    expect(recBFile?.path).toBe('/CRM/john-smith-recB.json');
  });

  it('dedups two new records with the same suggested name inside one batch', () => {
    // No prior pull. The first record claims the bare name; the second collides
    // against usedFileNames and falls back to the recordId-suffixed form.
    const usedFileNames = new Set<string>();
    const existingFileNames = new Map<string, string>();

    const built = buildGitFilesFromConnectorFiles(
      '/CRM',
      [rec('recA'), rec('recB')],
      tableSpec,
      usedFileNames,
      existingFileNames,
      ['John Smith', 'John Smith'],
    );

    expect(built.map((f) => f.path)).toEqual(['/CRM/john-smith.json', '/CRM/john-smith-recB.json']);
  });

  it('dedups across batches via the shared usedFileNames set', () => {
    // The job passes the same usedFileNames Set to every batch's call. This
    // simulates two sequential batches each containing one record with the
    // same suggested name.
    const usedFileNames = new Set<string>();
    const existingFileNames = new Map<string, string>();

    const batch1 = buildGitFilesFromConnectorFiles('/CRM', [rec('recA')], tableSpec, usedFileNames, existingFileNames, [
      'John Smith',
    ]);
    const batch2 = buildGitFilesFromConnectorFiles('/CRM', [rec('recB')], tableSpec, usedFileNames, existingFileNames, [
      'John Smith',
    ]);

    expect(batch1[0].path).toBe('/CRM/john-smith.json');
    expect(batch2[0].path).toBe('/CRM/john-smith-recB.json');
  });

  it('sanitizes a slash-containing record id (Shopify GID) so the file is not staged into a nested path', () => {
    // DEV-11015: variants/media/files have no slug, so the filename falls back to the
    // record id — a GID like `gid://shopify/ProductVariant/…`. Used verbatim, its
    // slashes turned the file into `Product Variants/gid:/shopify/ProductVariant/<id>.json`
    // (a nested tree), which the stale-file cleanup then deleted. The path must be a
    // single flat `.json` file directly under the folder.
    const usedFileNames = new Set<string>();
    const existingFileNames = new Map<string, string>();

    const built = buildGitFilesFromConnectorFiles(
      '/Product Variants',
      [rec('gid://shopify/ProductVariant/51423653331240')],
      tableSpec,
      usedFileNames,
      existingFileNames,
      [undefined], // no suggested filename → falls back to the (sanitized) record id
    );

    expect(built).toHaveLength(1);
    expect(built[0].path).toBe('/Product Variants/gid-shopify-ProductVariant-51423653331240.json');
    expect(built[0].path.split('/')).toHaveLength(3); // "", "Product Variants", "<file>.json" — no extra nesting
    expect(built[0].recordId).toBe('gid://shopify/ProductVariant/51423653331240');
  });

  it('never reintroduces a path separator via the collision suffix for slash-containing ids', () => {
    // Two GID-id records whose suggested names collide fall through to the
    // `<base>-<recordId>` dedup form; the record-id suffix must also be sanitized.
    const usedFileNames = new Set<string>();
    const existingFileNames = new Map<string, string>();

    const built = buildGitFilesFromConnectorFiles(
      '/Product Media',
      [rec('gid://shopify/MediaImage/1'), rec('gid://shopify/MediaImage/2')],
      tableSpec,
      usedFileNames,
      existingFileNames,
      ['image', 'image'], // identical suggested names → second collides
    );

    expect(built[0].path).toBe('/Product Media/image.json');
    expect(built[1].path).toBe('/Product Media/image-gid-shopify-MediaImage-2.json');
    expect(built[1].path).not.toContain('/shopify/');
  });

  it('reuses an existing record’s prior filename via the existingFileNames lookup', () => {
    // Sanity check: when a record is already in the index, its prior filename
    // is reused verbatim — usedFileNames does not block reuse.
    const usedFileNames = new Set<string>(['john-smith.json']);
    const existingFileNames = new Map<string, string>([['recA', 'john-smith.json']]);

    const built = buildGitFilesFromConnectorFiles('/CRM', [rec('recA')], tableSpec, usedFileNames, existingFileNames, [
      'John Smith',
    ]);

    expect(built[0].path).toBe('/CRM/john-smith.json');
    expect(built[0].recordId).toBe('recA');
  });
});
