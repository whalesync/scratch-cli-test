import { Type } from '@sinclair/typebox';
import { TableViewCol, X_SCRATCH_READONLY } from '@spinner/shared-types';
import { buildIntercomDefaultView } from '../intercom-default-view';

function makeArticlesSchema() {
  return Type.Object({
    id: Type.String({ [X_SCRATCH_READONLY]: true }),
    workspace_id: Type.String({ [X_SCRATCH_READONLY]: true }),
    title: Type.String(),
    description: Type.Union([Type.String(), Type.Null()]),
    body: Type.Union([Type.String(), Type.Null()]),
    author_id: Type.Number(),
    state: Type.Union([Type.Literal('published'), Type.Literal('draft')]),
    url: Type.Union([Type.String(), Type.Null()], { [X_SCRATCH_READONLY]: true }),
    parent_id: Type.Union([Type.Number(), Type.Null()]),
    parent_ids: Type.Array(Type.Number(), { [X_SCRATCH_READONLY]: true }),
    parent_type: Type.Union([Type.String(), Type.Null()]),
    default_locale: Type.String({ [X_SCRATCH_READONLY]: true }),
    translated_content: Type.Union([Type.Record(Type.String(), Type.Unknown()), Type.Null()]),
    statistics: Type.Union([Type.Object({}), Type.Null()], { [X_SCRATCH_READONLY]: true }),
    created_at: Type.Number({ [X_SCRATCH_READONLY]: true }),
    updated_at: Type.Number({ [X_SCRATCH_READONLY]: true }),
  });
}

function makeCollectionsSchema() {
  return Type.Object({
    id: Type.String({ [X_SCRATCH_READONLY]: true }),
    workspace_id: Type.String({ [X_SCRATCH_READONLY]: true }),
    name: Type.String(),
    description: Type.Union([Type.String(), Type.Null()]),
    icon: Type.Union([Type.String(), Type.Null()]),
    order: Type.Number({ [X_SCRATCH_READONLY]: true }),
    url: Type.Union([Type.String(), Type.Null()], { [X_SCRATCH_READONLY]: true }),
    default_locale: Type.String({ [X_SCRATCH_READONLY]: true }),
    translated_content: Type.Union([Type.Record(Type.String(), Type.Unknown()), Type.Null()]),
    parent_id: Type.Union([Type.String(), Type.Null()]),
    help_center_id: Type.Union([Type.Number(), Type.Null()]),
    created_at: Type.Number({ [X_SCRATCH_READONLY]: true }),
    updated_at: Type.Number({ [X_SCRATCH_READONLY]: true }),
  });
}

function makeConversationsSchema() {
  return Type.Object({
    id: Type.String({ [X_SCRATCH_READONLY]: true }),
    title: Type.Union([Type.String(), Type.Null()], { [X_SCRATCH_READONLY]: true }),
    state: Type.String({ [X_SCRATCH_READONLY]: true }),
    open: Type.Boolean({ [X_SCRATCH_READONLY]: true }),
    read: Type.Boolean({ [X_SCRATCH_READONLY]: true }),
    priority: Type.String({ [X_SCRATCH_READONLY]: true }),
    admin_assignee_id: Type.Union([Type.Number(), Type.Null()], { [X_SCRATCH_READONLY]: true }),
    team_assignee_id: Type.Union([Type.String(), Type.Null()], { [X_SCRATCH_READONLY]: true }),
    waiting_since: Type.Union([Type.Number(), Type.Null()], { [X_SCRATCH_READONLY]: true }),
    snoozed_until: Type.Union([Type.Number(), Type.Null()], { [X_SCRATCH_READONLY]: true }),
    source: Type.Object({}, { [X_SCRATCH_READONLY]: true }),
    contacts: Type.Object({}, { [X_SCRATCH_READONLY]: true }),
    tags: Type.Object({}, { [X_SCRATCH_READONLY]: true }),
    custom_attributes: Type.Record(Type.String(), Type.Unknown(), { [X_SCRATCH_READONLY]: true }),
    conversation_rating: Type.Union([Type.Record(Type.String(), Type.Unknown()), Type.Null()], {
      [X_SCRATCH_READONLY]: true,
    }),
    statistics: Type.Union([Type.Record(Type.String(), Type.Unknown()), Type.Null()], {
      [X_SCRATCH_READONLY]: true,
    }),
    conversation_parts: Type.Object({}, { [X_SCRATCH_READONLY]: true }),
    created_at: Type.Number({ [X_SCRATCH_READONLY]: true }),
    updated_at: Type.Number({ [X_SCRATCH_READONLY]: true }),
  });
}

describe('buildIntercomDefaultView', () => {
  describe('articles', () => {
    const schema = makeArticlesSchema();
    const view = buildIntercomDefaultView(schema, 'articles');

    it('should return a view named "Default"', () => {
      expect(view.name).toBe('Default');
    });

    it('should place priority fields first in defined order', () => {
      const paths = view.cols.map((c) => (c as TableViewCol).path);
      const expected = ['title', 'id', 'description', 'author_id', 'state', 'url', 'created_at', 'updated_at'];
      expect(paths.slice(0, expected.length)).toEqual(expected);
    });

    it('should sort remaining fields alphabetically after priority fields', () => {
      const paths = view.cols.map((c) => (c as TableViewCol).path);
      const nonPriority = paths.slice(8); // after the 8 priority fields
      const sorted = [...nonPriority].sort((a, b) => a.localeCompare(b));
      expect(nonPriority).toEqual(sorted);
    });

    it('should hide workspace_id', () => {
      const col = view.cols.find((c) => c.kind === 'col' && c.path === 'workspace_id') as TableViewCol;
      expect(col.hidden).toBe(true);
    });

    it('should hide translated_content', () => {
      const col = view.cols.find((c) => c.kind === 'col' && c.path === 'translated_content') as TableViewCol;
      expect(col.hidden).toBe(true);
    });

    it('should hide parent_ids', () => {
      const col = view.cols.find((c) => c.kind === 'col' && c.path === 'parent_ids') as TableViewCol;
      expect(col.hidden).toBe(true);
    });

    it('should hide statistics', () => {
      const col = view.cols.find((c) => c.kind === 'col' && c.path === 'statistics') as TableViewCol;
      expect(col.hidden).toBe(true);
    });

    it('should not hide visible fields', () => {
      const col = view.cols.find((c) => c.kind === 'col' && c.path === 'title') as TableViewCol;
      expect(col.hidden).toBeUndefined();
    });
  });

  describe('collections', () => {
    const schema = makeCollectionsSchema();
    const view = buildIntercomDefaultView(schema, 'collections');

    it('should return a view named "Default"', () => {
      expect(view.name).toBe('Default');
    });

    it('should place priority fields first in defined order', () => {
      const paths = view.cols.map((c) => (c as TableViewCol).path);
      const expected = ['name', 'id', 'description', 'url', 'order', 'created_at', 'updated_at'];
      expect(paths.slice(0, expected.length)).toEqual(expected);
    });

    it('should hide workspace_id', () => {
      const col = view.cols.find((c) => c.kind === 'col' && c.path === 'workspace_id') as TableViewCol;
      expect(col.hidden).toBe(true);
    });

    it('should hide translated_content', () => {
      const col = view.cols.find((c) => c.kind === 'col' && c.path === 'translated_content') as TableViewCol;
      expect(col.hidden).toBe(true);
    });
  });

  describe('conversations', () => {
    const schema = makeConversationsSchema();
    const view = buildIntercomDefaultView(schema, 'conversations');

    it('should return a view named "Default"', () => {
      expect(view.name).toBe('Default');
    });

    it('should place priority fields first in defined order', () => {
      const paths = view.cols.map((c) => (c as TableViewCol).path);
      const expected = [
        'title',
        'id',
        'state',
        'open',
        'read',
        'priority',
        'admin_assignee_id',
        'created_at',
        'updated_at',
      ];
      expect(paths.slice(0, expected.length)).toEqual(expected);
    });

    it('should hide conversation_parts', () => {
      const col = view.cols.find((c) => c.kind === 'col' && c.path === 'conversation_parts') as TableViewCol;
      expect(col.hidden).toBe(true);
    });

    it('should hide custom_attributes', () => {
      const col = view.cols.find((c) => c.kind === 'col' && c.path === 'custom_attributes') as TableViewCol;
      expect(col.hidden).toBe(true);
    });

    it('should hide conversation_rating', () => {
      const col = view.cols.find((c) => c.kind === 'col' && c.path === 'conversation_rating') as TableViewCol;
      expect(col.hidden).toBe(true);
    });

    it('should hide statistics', () => {
      const col = view.cols.find((c) => c.kind === 'col' && c.path === 'statistics') as TableViewCol;
      expect(col.hidden).toBe(true);
    });
  });

  describe('type mapping', () => {
    it('should map Boolean to checkbox', () => {
      const schema = makeConversationsSchema();
      const view = buildIntercomDefaultView(schema, 'conversations');
      const col = view.cols.find((c) => c.kind === 'col' && c.path === 'open') as TableViewCol;
      expect(col.type).toBe('checkbox');
    });

    it('should map Number to number', () => {
      const schema = makeArticlesSchema();
      const view = buildIntercomDefaultView(schema, 'articles');
      const col = view.cols.find((c) => c.kind === 'col' && c.path === 'author_id') as TableViewCol;
      expect(col.type).toBe('number');
    });

    it('should map Array to object', () => {
      const schema = makeArticlesSchema();
      const view = buildIntercomDefaultView(schema, 'articles');
      const col = view.cols.find((c) => c.kind === 'col' && c.path === 'parent_ids') as TableViewCol;
      expect(col.type).toBe('object');
    });

    it('should map Object to object', () => {
      const schema = makeConversationsSchema();
      const view = buildIntercomDefaultView(schema, 'conversations');
      const col = view.cols.find((c) => c.kind === 'col' && c.path === 'source') as TableViewCol;
      expect(col.type).toBe('object');
    });

    it('should map Union with non-null String inner type to undefined', () => {
      const schema = makeArticlesSchema();
      const view = buildIntercomDefaultView(schema, 'articles');
      // url is Union([String, Null]) — String kind has no special mapping
      const col = view.cols.find((c) => c.kind === 'col' && c.path === 'url') as TableViewCol;
      expect(col.type).toBeUndefined();
    });

    it('should map Union with Number inner type to number', () => {
      const schema = makeConversationsSchema();
      const view = buildIntercomDefaultView(schema, 'conversations');
      const col = view.cols.find((c) => c.kind === 'col' && c.path === 'admin_assignee_id') as TableViewCol;
      expect(col.type).toBe('number');
    });

    it('should map date-time format to date', () => {
      const schema = Type.Object({
        timestamp: Type.String({ format: 'date-time' }),
      });
      const view = buildIntercomDefaultView(schema, 'articles');
      const col = view.cols.find((c) => c.kind === 'col' && c.path === 'timestamp') as TableViewCol;
      expect(col.type).toBe('date');
    });

    it('should map uri format to url', () => {
      const schema = Type.Object({
        link: Type.String({ format: 'uri' }),
      });
      const view = buildIntercomDefaultView(schema, 'articles');
      const col = view.cols.find((c) => c.kind === 'col' && c.path === 'link') as TableViewCol;
      expect(col.type).toBe('url');
    });
  });

  describe('readonly', () => {
    it('should mark readonly fields', () => {
      const schema = makeArticlesSchema();
      const view = buildIntercomDefaultView(schema, 'articles');
      const col = view.cols.find((c) => c.kind === 'col' && c.path === 'id') as TableViewCol;
      expect(col.readonly).toBe(true);
    });

    it('should not mark writable fields as readonly', () => {
      const schema = makeArticlesSchema();
      const view = buildIntercomDefaultView(schema, 'articles');
      const col = view.cols.find((c) => c.kind === 'col' && c.path === 'title') as TableViewCol;
      expect(col.readonly).toBeUndefined();
    });

    it('should propagate readonly from Union wrapper', () => {
      const schema = makeArticlesSchema();
      const view = buildIntercomDefaultView(schema, 'articles');
      const col = view.cols.find((c) => c.kind === 'col' && c.path === 'url') as TableViewCol;
      expect(col.readonly).toBe(true);
    });
  });

  describe('name formatting', () => {
    it('should convert snake_case to Title Case', () => {
      const schema = makeArticlesSchema();
      const view = buildIntercomDefaultView(schema, 'articles');
      const col = view.cols.find((c) => c.kind === 'col' && c.path === 'author_id') as TableViewCol;
      expect(col.name).toBe('Author Id');
    });

    it('should capitalize single-word fields', () => {
      const schema = makeArticlesSchema();
      const view = buildIntercomDefaultView(schema, 'articles');
      const col = view.cols.find((c) => c.kind === 'col' && c.path === 'title') as TableViewCol;
      expect(col.name).toBe('Title');
    });

    it('should handle multi-segment names', () => {
      const schema = makeConversationsSchema();
      const view = buildIntercomDefaultView(schema, 'conversations');
      const col = view.cols.find((c) => c.kind === 'col' && c.path === 'admin_assignee_id') as TableViewCol;
      expect(col.name).toBe('Admin Assignee Id');
    });
  });

  describe('empty schema', () => {
    it('should handle an empty schema', () => {
      const schema = Type.Object({});
      const view = buildIntercomDefaultView(schema, 'articles');
      expect(view.name).toBe('Default');
      expect(view.cols).toHaveLength(0);
    });
  });
});
