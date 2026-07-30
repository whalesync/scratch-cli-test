import { TableViewCol } from '@spinner/shared-types';
import { buildWixBlogDefaultView } from '../wix-blog-default-view';
import { buildWixBlogJsonTableSpec } from '../wix-blog-json-schema';
import { resolveWixMediaUriToUrl, wixMediaIdFromUri } from '../wix-blog-media';
import { WixBlogTableKey, wixBlogEntityId } from '../wix-blog-tables';

function colsFor(table: WixBlogTableKey): TableViewCol[] {
  const view = buildWixBlogDefaultView(buildWixBlogJsonTableSpec(wixBlogEntityId(table)));
  expect(view).toBeDefined();
  // This connector's views are flat — no banner groups — so every entry is a column.
  return (view?.cols ?? []) as TableViewCol[];
}

const byPath = (cols: TableViewCol[], path: string): TableViewCol | undefined => cols.find((c) => c.path === path);
const visiblePaths = (cols: TableViewCol[]): string[] => cols.filter((c) => !c.hidden).map((c) => c.path);

describe('buildWixBlogDefaultView — Blog Posts', () => {
  const cols = colsFor('posts');

  it('surfaces the post body as ONE richtext column, not three JSON columns', () => {
    // Without a view, the schema flattener emitted `richContent` AND `richContent.nodes` AND
    // `richContent.metadata` — the same body stored two to three times per record (DEV-11121).
    expect(byPath(cols, 'richContent')).toMatchObject({ name: 'Content', type: 'richtext' });
    expect(byPath(cols, 'richContent.nodes')).toBeUndefined();
    expect(byPath(cols, 'richContent.metadata')).toBeUndefined();
    expect(byPath(cols, 'richContent.documentStyle')).toBeUndefined();
  });

  it('never exports a nested container alongside its own children', () => {
    for (const col of cols) {
      const parentPath = col.path.includes('.') ? col.path.slice(0, col.path.lastIndexOf('.')) : undefined;
      if (!parentPath) continue;
      expect(visiblePaths(cols)).not.toContain(parentPath);
    }
  });

  it('types the timestamps as dates so destinations create real date columns', () => {
    // `format: 'date-time'` alone is ignored by the plan generator; only a view hint produces a date
    // column (DEV-11119).
    for (const path of ['editedDate', '_createdDate', 'firstPublishedDate']) {
      expect(byPath(cols, path)).toMatchObject({ type: 'date' });
    }
  });

  it('declares scalar arrays as joined strings so they map cleanly instead of warning', () => {
    // Declaring `type: 'string'` up front routes the field to the `mapped` branch rather than the
    // `downgraded` array branch (DEV-11120).
    expect(byPath(cols, 'hashtags')).toMatchObject({
      type: 'string',
      displayTransformer: { type: 'jsonpath', options: { expression: '$[*]', arrayHandling: 'join_comma' } },
    });
  });

  it('resolves the cover image to a public URL', () => {
    const cover = byPath(cols, 'media.wixMedia.image');
    expect(cover).toMatchObject({ name: 'Cover image', type: 'url' });
    expect(cover?.codec?.toCore).toMatchObject({ type: 'replace_regex' });
  });

  it('offers Author, Categories, Tags and Related posts as foreign keys', () => {
    expect(byPath(cols, 'memberId')?.foreignKey).toMatchObject({
      linkedTableId: 'wix-members',
      isSingleValued: true,
    });
    expect(byPath(cols, 'categoryIds')?.foreignKey).toMatchObject({ linkedTableId: 'wix-blog-categories' });
    expect(byPath(cols, 'tagIds')?.foreignKey).toMatchObject({ linkedTableId: 'wix-blog-tags' });
    expect(byPath(cols, 'relatedPostIds')?.foreignKey).toMatchObject({ linkedTableId: 'wix-blog' });
  });

  it('leads with the fields a blog author cares about', () => {
    expect(visiblePaths(cols).slice(0, 4)).toEqual(['title', 'richContent', 'excerpt', 'media.wixMedia.image']);
  });

  it('keeps identifiers and Wix bookkeeping available but off by default', () => {
    for (const path of ['_id', 'slugs', 'previewTextParagraph', 'hasUnpublishedChanges', 'seoData']) {
      expect(byPath(cols, path)).toMatchObject({ hidden: true });
    }
  });

  it('marks Wix-computed fields readonly', () => {
    for (const path of ['status', 'minutesToRead', 'editedDate', '_createdDate']) {
      expect(byPath(cols, path)).toMatchObject({ readonly: true });
    }
  });

  // DEV-11128: read-only made a create impossible — Wix rejects a post with no author, but the
  // annotation blocked the only field that supplies one. Write-once is the honest description:
  // settable while the post is still local, owned by Wix from then on.
  it('makes the author write-once rather than read-only', () => {
    expect(byPath(cols, 'memberId')).toMatchObject({ writeOnce: true });
    expect(byPath(cols, 'memberId')?.readonly).toBeUndefined();
    // The contributor field really is always Wix's to set.
    expect(byPath(cols, 'mostRecentContributorId')).toMatchObject({ readonly: true });
  });

  // DEV-11114: without a codec the body reached every destination as a multi-thousand-character
  // Ricos JSON blob. `toCore` runs on the export path only, so the record on disk stays verbatim.
  it('renders the post body to HTML on the way out', () => {
    expect(byPath(cols, 'richContent')).toMatchObject({
      name: 'Content',
      type: 'richtext',
      codec: { toCore: { type: 'ricos_to_html' } },
    });
    // No `fromCore`: HTML→Ricos on publish is the connector's job, not the sync engine's.
    expect(byPath(cols, 'richContent')?.codec?.fromCore).toBeUndefined();
  });
});

describe('buildWixBlogDefaultView — reference tables', () => {
  it('leads Categories and Tags with their label', () => {
    expect(visiblePaths(colsFor('categories'))[0]).toBe('label');
    expect(visiblePaths(colsFor('tags'))[0]).toBe('label');
  });

  it('flattens the nested member profile and contact into named columns', () => {
    const cols = colsFor('members');
    // Without this the destination gets columns literally called `nickname`, `photo`, `customFields`.
    expect(byPath(cols, 'profile.nickname')).toMatchObject({ name: 'Name', type: 'string' });
    expect(byPath(cols, 'contact.firstName')).toMatchObject({ name: 'First name' });
    expect(byPath(cols, 'contact.lastName')).toMatchObject({ name: 'Last name' });
    expect(byPath(cols, 'profile.photo.url')).toMatchObject({ name: 'Photo', type: 'url' });
    // The raw containers must not be exported alongside their children.
    expect(visiblePaths(cols)).not.toContain('profile');
    expect(visiblePaths(cols)).not.toContain('contact');
  });

  it('gives every reference table a view', () => {
    for (const table of ['categories', 'tags', 'members'] as WixBlogTableKey[]) {
      expect(colsFor(table).length).toBeGreaterThan(0);
    }
  });
});

describe('Wix media URI resolution', () => {
  it.each([
    [
      'wix:image://v1/9a4116_2161bd3b120046b7bc653b638305c2cc~mv2.jpg/Whales.jpg#originWidth=1024&originHeight=1024',
      'https://static.wixstatic.com/media/9a4116_2161bd3b120046b7bc653b638305c2cc~mv2.jpg',
    ],
    [
      'wix:image://v1/abc_123~mv2.png#originWidth=10&originHeight=10',
      'https://static.wixstatic.com/media/abc_123~mv2.png',
    ],
    ['wix:image://v1/bare_id~mv2.png', 'https://static.wixstatic.com/media/bare_id~mv2.png'],
  ])('resolves %s', (uri, expected) => {
    expect(resolveWixMediaUriToUrl(uri)).toBe(expected);
  });

  it.each([
    ['https://static.wixstatic.com/media/already.jpg'],
    ['wix:video://v1/something/file.mp4'],
    [''],
    [null],
    [undefined],
    [42],
  ])('returns undefined for a non-image-URI value (%p)', (value) => {
    expect(resolveWixMediaUriToUrl(value)).toBeUndefined();
  });

  it('extracts the media id for use as a stable asset id', () => {
    expect(wixMediaIdFromUri('wix:image://v1/media_id~mv2.jpg/name.jpg#originWidth=1')).toBe('media_id~mv2.jpg');
    expect(wixMediaIdFromUri('not a wix uri')).toBeUndefined();
  });
});
