import { Type } from '@sinclair/typebox';
import { TableViewCol, X_SCRATCH_READONLY } from '@spinner/shared-types';
import { buildLinearDefaultView } from '../linear-default-view';

function markReadonly<T>(schema: T): T {
  (schema as Record<string, unknown>)[X_SCRATCH_READONLY] = true;
  return schema;
}

/** Minimal issues-like schema for testing. */
function makeIssuesSchema() {
  return Type.Object({
    id: Type.String(),
    createdAt: markReadonly(Type.Optional(Type.Union([Type.String({ format: 'date-time' }), Type.Null()]))),
    updatedAt: markReadonly(Type.Optional(Type.Union([Type.String({ format: 'date-time' }), Type.Null()]))),
    number: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
    title: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    description: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    priority: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
    priorityLabel: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    identifier: markReadonly(Type.Optional(Type.Union([Type.String(), Type.Null()]))),
    url: markReadonly(Type.Optional(Type.Union([Type.String(), Type.Null()]))),
    estimate: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
    dueDate: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    boardOrder: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
    sortOrder: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
    prioritySortOrder: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
    trashed: Type.Optional(Type.Union([Type.Boolean(), Type.Null()])),
    branchName: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    labelIds: Type.Optional(Type.Array(Type.Union([Type.String(), Type.Null()]))),
    state: Type.Optional(Type.Unknown()),
    team: Type.Optional(
      Type.Union([
        Type.Object({
          id: Type.Optional(Type.String()),
          name: Type.Optional(Type.Union([Type.String(), Type.Null()])),
        }),
        Type.Null(),
      ]),
    ),
    project: Type.Optional(
      Type.Union([
        Type.Object({
          id: Type.Optional(Type.String()),
          name: Type.Optional(Type.Union([Type.String(), Type.Null()])),
        }),
        Type.Null(),
      ]),
    ),
    cycle: Type.Optional(
      Type.Union([
        Type.Object({
          id: Type.Optional(Type.String()),
        }),
        Type.Null(),
      ]),
    ),
    assignee: Type.Optional(
      Type.Union([
        Type.Object({
          id: Type.Optional(Type.String()),
          name: Type.Optional(Type.Union([Type.String(), Type.Null()])),
          displayName: Type.Optional(Type.Union([Type.String(), Type.Null()])),
          email: Type.Optional(Type.Union([Type.String(), Type.Null()])),
        }),
        Type.Null(),
      ]),
    ),
    creator: Type.Optional(
      Type.Union([
        Type.Object({
          id: Type.Optional(Type.String()),
          name: Type.Optional(Type.Union([Type.String(), Type.Null()])),
        }),
        Type.Null(),
      ]),
    ),
    documentContent: Type.Optional(
      Type.Union([
        Type.Object({
          id: Type.Optional(Type.String()),
          content: Type.Optional(Type.Union([Type.String(), Type.Null()])),
        }),
        Type.Null(),
      ]),
    ),
    favorite: Type.Optional(Type.Unknown()),
    slaStartedAt: Type.Optional(Type.Union([Type.String({ format: 'date-time' }), Type.Null()])),
    reactions: Type.Optional(Type.Array(Type.Unknown())),
  });
}

describe('buildLinearDefaultView', () => {
  describe('issues', () => {
    const schema = makeIssuesSchema();
    const view = buildLinearDefaultView(schema, 'issues');

    it('should return a view named "Default"', () => {
      expect(view.name).toBe('Default');
    });

    it('should place identifier first and title second', () => {
      const paths = view.cols.map((c) => (c as TableViewCol).path);
      expect(paths[0]).toBe('identifier');
      expect(paths[1]).toBe('title');
    });

    it('should place priority fields before non-priority fields', () => {
      const paths = view.cols.map((c) => (c as TableViewCol).path);
      const titleIdx = paths.indexOf('title');
      const numberIdx = paths.indexOf('number');
      // title is a priority field, number is not — title should come first
      expect(titleIdx).toBeLessThan(numberIdx);
    });

    it('should hide boardOrder, sortOrder, prioritySortOrder', () => {
      const boardCol = view.cols.find((c) => c.kind === 'col' && c.path === 'boardOrder') as TableViewCol;
      expect(boardCol.hidden).toBe(true);
      const sortCol = view.cols.find((c) => c.kind === 'col' && c.path === 'sortOrder') as TableViewCol;
      expect(sortCol.hidden).toBe(true);
      const priSortCol = view.cols.find((c) => c.kind === 'col' && c.path === 'prioritySortOrder') as TableViewCol;
      expect(priSortCol.hidden).toBe(true);
    });

    it('should hide SLA fields', () => {
      const slaCol = view.cols.find((c) => c.kind === 'col' && c.path === 'slaStartedAt') as TableViewCol;
      expect(slaCol.hidden).toBe(true);
    });

    it('should hide favorite and reactions', () => {
      const favCol = view.cols.find((c) => c.kind === 'col' && c.path === 'favorite') as TableViewCol;
      expect(favCol.hidden).toBe(true);
      const reactCol = view.cols.find((c) => c.kind === 'col' && c.path === 'reactions') as TableViewCol;
      expect(reactCol.hidden).toBe(true);
    });

    it('should add id subfields to team with selectedSubfield=0', () => {
      const teamCol = view.cols.find((c) => c.kind === 'col' && c.path === 'team') as TableViewCol;
      expect(teamCol.subfields).toBeDefined();
      expect(teamCol.subfields![0].relativePath).toBe('id');
      expect(teamCol.selectedSubfield).toBe(0);
    });

    it('should add id subfields to project with selectedSubfield=0', () => {
      const projectCol = view.cols.find((c) => c.kind === 'col' && c.path === 'project') as TableViewCol;
      expect(projectCol.subfields).toBeDefined();
      expect(projectCol.subfields![0].relativePath).toBe('id');
      expect(projectCol.selectedSubfield).toBe(0);
    });

    it('should add user subfields to assignee with name selected', () => {
      const col = view.cols.find((c) => c.kind === 'col' && c.path === 'assignee') as TableViewCol;
      expect(col.subfields).toBeDefined();
      expect(col.subfields![0].relativePath).toBe('name');
      expect(col.selectedSubfield).toBe(0);
    });

    it('should add user subfields to creator with name selected', () => {
      const col = view.cols.find((c) => c.kind === 'col' && c.path === 'creator') as TableViewCol;
      expect(col.subfields).toBeDefined();
      expect(col.subfields![0].relativePath).toBe('name');
      expect(col.selectedSubfield).toBe(0);
    });

    it('should add content subfields to documentContent', () => {
      const col = view.cols.find((c) => c.kind === 'col' && c.path === 'documentContent') as TableViewCol;
      expect(col.subfields).toBeDefined();
      expect(col.subfields![0].relativePath).toBe('content');
      expect(col.selectedSubfield).toBe(0);
    });

    it('should not add subfields to plain fields', () => {
      const col = view.cols.find((c) => c.kind === 'col' && c.path === 'title') as TableViewCol;
      expect(col.subfields).toBeUndefined();
    });

    it('should mark readonly fields from schema annotations', () => {
      const idCol = view.cols.find((c) => c.kind === 'col' && c.path === 'identifier') as TableViewCol;
      expect(idCol.readonly).toBe(true);

      const createdCol = view.cols.find((c) => c.kind === 'col' && c.path === 'createdAt') as TableViewCol;
      expect(createdCol.readonly).toBe(true);
    });

    it('should not mark writable fields as readonly', () => {
      const col = view.cols.find((c) => c.kind === 'col' && c.path === 'title') as TableViewCol;
      expect(col.readonly).toBeUndefined();
    });
  });

  describe('type mapping', () => {
    const schema = makeIssuesSchema();
    const view = buildLinearDefaultView(schema, 'issues');

    it('should map date-time format to date type', () => {
      const col = view.cols.find((c) => c.kind === 'col' && c.path === 'createdAt') as TableViewCol;
      expect(col.type).toBe('date');
    });

    it('should map number fields to number type', () => {
      const col = view.cols.find((c) => c.kind === 'col' && c.path === 'priority') as TableViewCol;
      expect(col.type).toBe('number');
    });

    it('should map boolean fields to checkbox type', () => {
      const col = view.cols.find((c) => c.kind === 'col' && c.path === 'trashed') as TableViewCol;
      expect(col.type).toBe('checkbox');
    });

    it('should map array fields to object type', () => {
      const col = view.cols.find((c) => c.kind === 'col' && c.path === 'labelIds') as TableViewCol;
      expect(col.type).toBe('object');
    });

    it('should not set type for plain string fields', () => {
      const col = view.cols.find((c) => c.kind === 'col' && c.path === 'title') as TableViewCol;
      expect(col.type).toBeUndefined();
    });
  });

  describe('name formatting', () => {
    const schema = makeIssuesSchema();
    const view = buildLinearDefaultView(schema, 'issues');

    it('should format camelCase as Title Case', () => {
      const col = view.cols.find((c) => c.kind === 'col' && c.path === 'createdAt') as TableViewCol;
      expect(col.name).toBe('Created At');
    });

    it('should format priorityLabel correctly', () => {
      const col = view.cols.find((c) => c.kind === 'col' && c.path === 'priorityLabel') as TableViewCol;
      expect(col.name).toBe('Priority Label');
    });

    it('should preserve single-word names', () => {
      const col = view.cols.find((c) => c.kind === 'col' && c.path === 'title') as TableViewCol;
      expect(col.name).toBe('Title');
    });
  });

  describe('projects', () => {
    const schema = Type.Object({
      id: Type.String(),
      name: Type.Optional(Type.Union([Type.String(), Type.Null()])),
      description: Type.Optional(Type.Union([Type.String(), Type.Null()])),
      slugId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
      status: Type.Optional(Type.Unknown()),
      health: Type.Optional(Type.Union([Type.String(), Type.Null()])),
      lead: Type.Optional(
        Type.Union([
          Type.Object({ id: Type.Optional(Type.String()), name: Type.Optional(Type.String()) }),
          Type.Null(),
        ]),
      ),
      sortOrder: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
    });
    const view = buildLinearDefaultView(schema, 'projects');

    it('should place name first for projects', () => {
      const paths = view.cols.map((c) => (c as TableViewCol).path);
      expect(paths[0]).toBe('name');
    });

    it('should hide sortOrder', () => {
      const col = view.cols.find((c) => c.kind === 'col' && c.path === 'sortOrder') as TableViewCol;
      expect(col.hidden).toBe(true);
    });

    it('should add user subfields to lead', () => {
      const col = view.cols.find((c) => c.kind === 'col' && c.path === 'lead') as TableViewCol;
      expect(col.subfields).toBeDefined();
      expect(col.subfields![0].relativePath).toBe('name');
    });
  });

  it('should handle an empty schema gracefully', () => {
    const empty = Type.Object({});
    const emptyView = buildLinearDefaultView(empty, 'issues');
    expect(emptyView.cols).toEqual([]);
  });

  it('should not produce any banner groups', () => {
    const schema = makeIssuesSchema();
    const view = buildLinearDefaultView(schema, 'issues');
    const groups = view.cols.filter((c) => c.kind === 'banner-group');
    expect(groups).toHaveLength(0);
  });
});
