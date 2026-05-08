import type { TableView, TableViewBannerGroup, TableViewCol } from '@spinner/shared-types';

/** TODO: This is a dumb placeholder to test with. */
export function buildWordPressPostsDefaultView(): TableView {
  const titleCol: TableViewCol = {
    kind: 'col',
    path: 'title',
    name: 'Title',
    type: 'string',
    subfields: [
      { relativePath: 'raw', name: 'Raw', type: 'string' },
      { relativePath: 'rendered', name: 'Rendered', type: 'richtext', readonly: true },
    ],
    selectedSubfield: 0,
  };

  const statusCol: TableViewCol = {
    kind: 'col',
    path: 'status',
    name: 'Status',
    type: 'string',
  };

  const contentCol: TableViewCol = {
    kind: 'col',
    path: 'content',
    name: 'Content',
    type: 'richtext',
    subfields: [
      { relativePath: 'raw', name: 'Raw', type: 'richtext' },
      { relativePath: 'rendered', name: 'Rendered', type: 'richtext', readonly: true },
    ],
    selectedSubfield: 0,
  };

  const dateCol: TableViewCol = {
    kind: 'col',
    path: 'date',
    name: 'Date',
    type: 'date',
  };

  const modifiedCol: TableViewCol = {
    kind: 'col',
    path: 'modified',
    name: 'Modified',
    type: 'date',
  };

  const linkCol: TableViewCol = {
    kind: 'col',
    path: 'link',
    name: 'Link',
    type: 'url',
  };

  const slugCol: TableViewCol = {
    kind: 'col',
    path: 'slug',
    name: 'Slug',
    type: 'string',
  };

  const excerptCol: TableViewCol = {
    kind: 'col',
    path: 'excerpt',
    name: 'Excerpt',
    type: 'string',
    subfields: [
      { relativePath: 'raw', name: 'Raw', type: 'string' },
      { relativePath: 'rendered', name: 'Rendered', type: 'richtext', readonly: true },
    ],
    selectedSubfield: 0,
  };

  const authorCol: TableViewCol = {
    kind: 'col',
    path: 'author',
    name: 'Author',
    type: 'number',
  };

  const featuredMediaCol: TableViewCol = {
    kind: 'col',
    path: 'featured_media',
    name: 'Featured Media',
    type: 'number',
  };

  const seoGroup: TableViewBannerGroup = {
    kind: 'banner-group',
    name: 'SEO & Metadata',
    cols: [slugCol, excerptCol, authorCol, featuredMediaCol],
  };

  const idCol: TableViewCol = {
    kind: 'col',
    path: 'id',
    name: 'ID',
    type: 'number',
    readonly: true,
  };

  return {
    name: 'Default',
    cols: [titleCol, statusCol, contentCol, dateCol, modifiedCol, linkCol, seoGroup, idCol],
  };
}
