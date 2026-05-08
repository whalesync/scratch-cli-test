import { buildWordPressPostsDefaultView } from '../wordpress-default-view';

describe('buildWordPressPostsDefaultView', () => {
  const view = buildWordPressPostsDefaultView();

  it('should return a view named "Default"', () => {
    expect(view.name).toBe('Default');
  });

  it('should include all expected top-level columns', () => {
    const topLevelNames = view.cols.map((c) => c.name);
    expect(topLevelNames).toEqual(['Title', 'Status', 'Content', 'Date', 'Modified', 'Link', 'SEO & Metadata', 'ID']);
  });

  it('should have subfields on title, content, and excerpt columns', () => {
    const title = view.cols.find((c) => c.kind === 'col' && c.path === 'title');
    expect(title).toBeDefined();
    expect(title!.kind === 'col' && title!.subfields?.length).toBe(2);

    const content = view.cols.find((c) => c.kind === 'col' && c.path === 'content');
    expect(content).toBeDefined();
    expect(content!.kind === 'col' && content!.subfields?.length).toBe(2);
  });

  it('should have a banner group for SEO & Metadata with 4 columns', () => {
    const seoGroup = view.cols.find((c) => c.kind === 'banner-group');
    expect(seoGroup).toBeDefined();
    expect(seoGroup!.kind).toBe('banner-group');
    if (seoGroup!.kind === 'banner-group') {
      expect(seoGroup!.cols).toHaveLength(4);
      const names = seoGroup!.cols.map((c) => c.name);
      expect(names).toEqual(['Slug', 'Excerpt', 'Author', 'Featured Media']);
    }
  });

  it('should mark the ID column as readonly', () => {
    const idCol = view.cols.find((c) => c.kind === 'col' && c.path === 'id');
    expect(idCol).toBeDefined();
    expect(idCol!.kind === 'col' && idCol!.readonly).toBe(true);
  });
});
