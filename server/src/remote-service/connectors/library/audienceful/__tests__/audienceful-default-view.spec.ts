import { Type } from '@sinclair/typebox';
import { TableViewCol, X_SCRATCH_READONLY } from '@spinner/shared-types';
import { buildAudiencefulDefaultView } from '../audienceful-default-view';

/** Build a schema resembling the Audienceful People table. */
function makeSchema() {
  return Type.Object({
    id: Type.Integer({ description: 'Numeric database ID', [X_SCRATCH_READONLY]: true }),
    uid: Type.String({ description: 'Unique identifier', [X_SCRATCH_READONLY]: true }),
    email: Type.String({ description: 'Email address', format: 'email' }),
    tags: Type.Array(Type.Object({ name: Type.String() }), { description: 'Tags' }),
    notes: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    extra_data: Type.Object({}, { description: 'Custom fields' }),
    status: Type.Union([Type.Literal('active'), Type.Literal('unsubscribed')], {
      description: 'Subscription status',
      [X_SCRATCH_READONLY]: true,
    }),
    source: Type.Optional(Type.Union([Type.String(), Type.Null()], { [X_SCRATCH_READONLY]: true })),
    created_at: Type.String({ description: 'Created', format: 'date-time', [X_SCRATCH_READONLY]: true }),
    updated_at: Type.String({ description: 'Updated', format: 'date-time', [X_SCRATCH_READONLY]: true }),
    last_activity: Type.String({ description: 'Last active', format: 'date-time', [X_SCRATCH_READONLY]: true }),
    unsubscribed: Type.Optional(
      Type.Union([Type.String({ format: 'date-time' }), Type.Null()], { [X_SCRATCH_READONLY]: true }),
    ),
    country: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    double_opt_in: Type.Union([Type.Literal('not_required'), Type.Literal('complete')], {
      [X_SCRATCH_READONLY]: true,
    }),
    bounced: Type.Boolean({ description: 'Bounced', [X_SCRATCH_READONLY]: true }),
    open_rate: Type.Optional(Type.Union([Type.Number(), Type.Null()], { [X_SCRATCH_READONLY]: true })),
    click_rate: Type.Optional(Type.Union([Type.Number(), Type.Null()], { [X_SCRATCH_READONLY]: true })),
  });
}

describe('buildAudiencefulDefaultView', () => {
  const schema = makeSchema();
  const view = buildAudiencefulDefaultView(schema);

  it('should return a view named "Default"', () => {
    expect(view.name).toBe('Default');
  });

  describe('priority ordering', () => {
    it('should place email first', () => {
      const paths = view.cols.map((c) => (c as TableViewCol).path);
      expect(paths[0]).toBe('email');
    });

    it('should place id second', () => {
      const paths = view.cols.map((c) => (c as TableViewCol).path);
      expect(paths[1]).toBe('id');
    });

    it('should follow the full priority order for listed fields', () => {
      const paths = view.cols.map((c) => (c as TableViewCol).path);
      const priorityFields = ['email', 'id', 'tags', 'status', 'source', 'country', 'created_at', 'updated_at'];
      const priorityIndices = priorityFields.map((f) => paths.indexOf(f));

      for (let i = 1; i < priorityIndices.length; i++) {
        expect(priorityIndices[i]).toBeGreaterThan(priorityIndices[i - 1]);
      }
    });

    it('should place priority fields before non-priority fields', () => {
      const paths = view.cols.map((c) => (c as TableViewCol).path);
      const lastPriority = paths.indexOf('updated_at');
      const firstNonPriority = paths.indexOf('uid');
      expect(lastPriority).toBeLessThan(firstNonPriority);
    });
  });

  describe('hidden fields', () => {
    it('should hide uid', () => {
      const col = view.cols.find((c) => c.kind === 'col' && c.path === 'uid') as TableViewCol;
      expect(col.hidden).toBe(true);
    });

    it('should hide extra_data', () => {
      const col = view.cols.find((c) => c.kind === 'col' && c.path === 'extra_data') as TableViewCol;
      expect(col.hidden).toBe(true);
    });

    it('should hide double_opt_in', () => {
      const col = view.cols.find((c) => c.kind === 'col' && c.path === 'double_opt_in') as TableViewCol;
      expect(col.hidden).toBe(true);
    });

    it('should hide bounced', () => {
      const col = view.cols.find((c) => c.kind === 'col' && c.path === 'bounced') as TableViewCol;
      expect(col.hidden).toBe(true);
    });

    it('should not hide email', () => {
      const col = view.cols.find((c) => c.kind === 'col' && c.path === 'email') as TableViewCol;
      expect(col.hidden).toBeUndefined();
    });
  });

  describe('type mapping', () => {
    it('should map date-time fields to date type', () => {
      const col = view.cols.find((c) => c.kind === 'col' && c.path === 'created_at') as TableViewCol;
      expect(col.type).toBe('date');
    });

    it('should map date-time inside Union to date type', () => {
      const col = view.cols.find((c) => c.kind === 'col' && c.path === 'unsubscribed') as TableViewCol;
      expect(col.type).toBe('date');
    });

    it('should map Boolean to checkbox type', () => {
      const col = view.cols.find((c) => c.kind === 'col' && c.path === 'bounced') as TableViewCol;
      expect(col.type).toBe('checkbox');
    });

    it('should map Number inside Union to number type', () => {
      const col = view.cols.find((c) => c.kind === 'col' && c.path === 'open_rate') as TableViewCol;
      expect(col.type).toBe('number');
    });

    it('should map Integer to number type', () => {
      const col = view.cols.find((c) => c.kind === 'col' && c.path === 'id') as TableViewCol;
      expect(col.type).toBe('number');
    });

    it('should map Array to object type', () => {
      const col = view.cols.find((c) => c.kind === 'col' && c.path === 'tags') as TableViewCol;
      expect(col.type).toBe('object');
    });

    it('should map Object to object type', () => {
      const col = view.cols.find((c) => c.kind === 'col' && c.path === 'extra_data') as TableViewCol;
      expect(col.type).toBe('object');
    });
  });

  describe('readonly propagation', () => {
    it('should mark readonly fields', () => {
      const col = view.cols.find((c) => c.kind === 'col' && c.path === 'created_at') as TableViewCol;
      expect(col.readonly).toBe(true);
    });

    it('should mark id as readonly', () => {
      const col = view.cols.find((c) => c.kind === 'col' && c.path === 'id') as TableViewCol;
      expect(col.readonly).toBe(true);
    });

    it('should not mark writable fields as readonly', () => {
      const col = view.cols.find((c) => c.kind === 'col' && c.path === 'email') as TableViewCol;
      expect(col.readonly).toBeUndefined();
    });
  });

  describe('name formatting', () => {
    it('should format snake_case as Title Case', () => {
      const col = view.cols.find((c) => c.kind === 'col' && c.path === 'created_at') as TableViewCol;
      expect(col.name).toBe('Created At');
    });

    it('should format single-word fields with initial cap', () => {
      const col = view.cols.find((c) => c.kind === 'col' && c.path === 'email') as TableViewCol;
      expect(col.name).toBe('Email');
    });

    it('should format multi-segment names', () => {
      const col = view.cols.find((c) => c.kind === 'col' && c.path === 'open_rate') as TableViewCol;
      expect(col.name).toBe('Open Rate');
    });
  });

  it('should handle an empty schema', () => {
    const emptySchema = Type.Object({});
    const emptyView = buildAudiencefulDefaultView(emptySchema);
    expect(emptyView.name).toBe('Default');
    expect(emptyView.cols).toHaveLength(0);
  });

  it('should not produce any banner groups', () => {
    const groups = view.cols.filter((c) => c.kind === 'banner-group');
    expect(groups).toHaveLength(0);
  });
});
