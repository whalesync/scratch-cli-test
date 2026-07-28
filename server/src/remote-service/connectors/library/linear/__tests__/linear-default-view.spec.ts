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
    // Every relation is read-only on Linear and — apart from `lead`/`delegate` — is pulled
    // selecting only `{ id }`, which is what the generated schemas' annotations reflect.
    state: markReadonly(Type.Optional(Type.Unknown())),
    team: markReadonly(
      Type.Optional(
        Type.Union([
          Type.Object({
            id: Type.Optional(Type.String()),
          }),
          Type.Null(),
        ]),
      ),
    ),
    project: markReadonly(
      Type.Optional(
        Type.Union([
          Type.Object({
            id: Type.Optional(Type.String()),
          }),
          Type.Null(),
        ]),
      ),
    ),
    cycle: markReadonly(
      Type.Optional(
        Type.Union([
          Type.Object({
            id: Type.Optional(Type.String()),
          }),
          Type.Null(),
        ]),
      ),
    ),
    assignee: markReadonly(
      Type.Optional(
        Type.Union([
          Type.Object({
            id: Type.Optional(Type.String()),
          }),
          Type.Null(),
        ]),
      ),
    ),
    creator: markReadonly(
      Type.Optional(
        Type.Union([
          Type.Object({
            id: Type.Optional(Type.String()),
          }),
          Type.Null(),
        ]),
      ),
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

    it('should surface state as its human-readable name, not the raw object (DEV-11024)', () => {
      const col = view.cols.find((c) => c.kind === 'col' && c.path === 'state') as TableViewCol;
      expect(col.subfields).toBeDefined();
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      expect(col.subfields![0].relativePath).toBe('name');
      expect(col.selectedSubfield).toBe(0);
    });

    it('should add content subfields to documentContent', () => {
      const col = view.cols.find((c) => c.kind === 'col' && c.path === 'documentContent') as TableViewCol;
      expect(col.subfields).toBeDefined();
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
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
      const col = view.cols.find((c) => c.kind === 'col' && c.path === 'reactions') as TableViewCol;
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
      // Unlike an Issue's `state`, a Project's is a plain enum string, not a reference object.
      state: Type.Optional(Type.Union([Type.String(), Type.Null()])),
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

    it('should link lead to the Users table by its id', () => {
      const col = view.cols.find((c) => c.kind === 'col' && c.path === 'lead.id') as TableViewCol;
      expect(col.foreignKey).toEqual({ linkedTableId: 'users', isSingleValued: true });
      expect(col.name).toBe('Lead');
      expect(col.subfields).toBeUndefined();
    });

    it('should pluck status.name instead of syncing the whole ProjectStatus object (DEV-11027)', () => {
      const col = view.cols.find((c) => c.kind === 'col' && c.path === 'status') as TableViewCol;
      expect(col.subfields).toBeDefined();
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      expect(col.subfields![0]).toEqual({ relativePath: 'name', name: 'Name', type: 'string' });
      expect(col.selectedSubfield).toBe(0);
    });

    it('should leave a Projects state alone — unlike an Issues state it is a plain enum string', () => {
      const col = view.cols.find((c) => c.kind === 'col' && c.path === 'state') as TableViewCol;
      expect(col.subfields).toBeUndefined();
      expect(col.selectedSubfield).toBeUndefined();
    });
  });

  describe('relationship foreign keys (DEV-11023, DEV-11024)', () => {
    const view = buildLinearDefaultView(makeIssuesSchema(), 'issues');
    const colAt = (path: string) => view.cols.find((c) => c.kind === 'col' && c.path === path) as TableViewCol;

    it.each([
      ['team.id', 'Team', 'teams'],
      ['project.id', 'Project', 'projects'],
      ['cycle.id', 'Cycle', 'cycles'],
      ['assignee.id', 'Assignee', 'users'],
      ['creator.id', 'Creator', 'users'],
    ])('should link %s to the %s table as a single-valued foreign key', (path, name, linkedTableId) => {
      const col = colAt(path);
      expect(col.foreignKey).toEqual({ linkedTableId, isSingleValued: true });
      expect(col.name).toBe(name);
      expect(col.type).toBe('string');
    });

    it('should link labelIds to Labels as a multi-valued foreign key on its own path', () => {
      const col = colAt('labelIds');
      expect(col.foreignKey).toEqual({ linkedTableId: 'labels', isSingleValued: false });
    });

    it('should not give a foreign-key column subfields, which would drop the declaration', () => {
      for (const path of ['team.id', 'assignee.id', 'labelIds']) {
        expect(colAt(path).subfields).toBeUndefined();
        expect(colAt(path).selectedSubfield).toBeUndefined();
      }
    });

    it('should carry the relation objects read-only flag onto the link column', () => {
      expect(colAt('team.id').readonly).toBe(true);
      // labelIds is writable on Linear, so its link column must not be marked read-only
      expect(colAt('labelIds').readonly).toBeUndefined();
    });

    it('should no longer emit the raw relation object as its own column', () => {
      for (const path of ['team', 'project', 'cycle', 'assignee', 'creator']) {
        expect(colAt(path)).toBeUndefined();
      }
    });
  });

  describe('markdown bodies (DEV-11028)', () => {
    it('should type a contentMediaType: text/markdown field as richtext', () => {
      const schema = Type.Object({
        title: Type.Optional(Type.Union([Type.String(), Type.Null()])),
        description: Type.Optional(Type.Union([Type.String(), Type.Null()])),
      });
      // Annotated the same way `linear-json-schema.ts` annotates the generated schemas.
      (schema.properties.description as Record<string, unknown>).contentMediaType = 'text/markdown';
      const view = buildLinearDefaultView(schema, 'issues');
      const descriptionCol = view.cols.find((c) => c.kind === 'col' && c.path === 'description') as TableViewCol;
      expect(descriptionCol.type).toBe('richtext');
      const titleCol = view.cols.find((c) => c.kind === 'col' && c.path === 'title') as TableViewCol;
      expect(titleCol.type).toBeUndefined();
    });
  });

  describe('TimelessDate fields (DEV-11026)', () => {
    it('should map a format: date string to the date type', () => {
      const schema = Type.Object({
        dueDate: Type.Optional(Type.Union([Type.String({ format: 'date' }), Type.Null()])),
      });
      const view = buildLinearDefaultView(schema, 'issues');
      const col = view.cols.find((c) => c.kind === 'col' && c.path === 'dueDate') as TableViewCol;
      expect(col.type).toBe('date');
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
