import { type DataSourceObjectResponse } from '@notionhq/client';
import { Type } from '@sinclair/typebox';
import { TableViewCol } from '@spinner/shared-types';
import { buildNotionDefaultView } from '../notion-default-view';
import { buildNotionJsonTableSpec } from '../notion-json-schema';

/**
 * Build the real generated table schema for a set of property types, then derive
 * the default view from it. Exercises buildPropertyCol against the actual on-disk
 * envelope schema (not a hand-rolled stand-in), so the path-drilling and subfield
 * re-anchoring are validated end-to-end with the generator.
 */
function buildView(properties: Record<string, { id: string; type: string; relation?: { database_id: string } }>) {
  const dataSource = {
    object: 'data_source',
    id: 'ds_123',
    title: [{ plain_text: 'My DB' }],
    properties: Object.fromEntries(Object.entries(properties).map(([name, def]) => [name, { name, ...def }])),
  } as unknown as DataSourceObjectResponse;

  const spec = buildNotionJsonTableSpec({ wsId: 'db', remoteId: ['db_123', 'ds_123'] }, dataSource);
  return buildNotionDefaultView(spec.schema);
}

const ALL_TYPES = {
  // Status deliberately first so we can assert the title gets reordered ahead of it.
  Status: { id: 'p_status', type: 'status' },
  Name: { id: 'title', type: 'title' },
  Priority: { id: 'p_select', type: 'select' },
  Tags: { id: 'p_ms', type: 'multi_select' },
  'Due Date': { id: 'p_date', type: 'date' },
  Assignee: { id: 'p_people', type: 'people' },
  Notes: { id: 'p_rt', type: 'rich_text' },
  Score: { id: 'p_num', type: 'number' },
  Done: { id: 'p_cb', type: 'checkbox' },
  Website: { id: 'p_url', type: 'url' },
  Email: { id: 'p_email', type: 'email' },
  Formula: { id: 'p_formula', type: 'formula' },
  'Created By Prop': { id: 'p_cbp', type: 'created_by' },
  'Computed Total': { id: 'p_rollup', type: 'rollup' },
  Linked: { id: 'p_rel', type: 'relation', relation: { database_id: 'db_linked' } },
};

function findCol(view: ReturnType<typeof buildView>, path: string): TableViewCol | undefined {
  return view.cols.find((c) => c.kind === 'col' && c.path === path) as TableViewCol | undefined;
}

describe('buildNotionDefaultView', () => {
  const view = buildView(ALL_TYPES);

  it('should return a view named "Default"', () => {
    expect(view.name).toBe('Default');
  });

  describe('ordering', () => {
    it('should place the title property first (drilled into the title array)', () => {
      const firstCol = view.cols[0] as TableViewCol;
      expect(firstCol.path).toBe('properties.Name.title');
    });

    it('should place property columns before fixed fields', () => {
      const paths = view.cols.map((c) => (c as TableViewCol).path);
      expect(paths.indexOf('properties.Name.title')).toBeLessThan(paths.indexOf('id'));
    });

    it('should use property names as column names', () => {
      const col = findCol(view, 'properties.Due Date.date');
      expect(col?.name).toBe('Due Date');
    });
  });

  describe('one-level path drilling (D2)', () => {
    it('drills scalar properties to properties.<name>.<typeKey>', () => {
      expect(findCol(view, 'properties.Email.email')).toBeDefined();
      expect(findCol(view, 'properties.Score.number')).toBeDefined();
      expect(findCol(view, 'properties.Website.url')).toBeDefined();
      expect(findCol(view, 'properties.Done.checkbox')).toBeDefined();
    });

    it('drills array properties one level (shown as the inner array)', () => {
      expect(findCol(view, 'properties.Tags.multi_select')).toBeDefined();
      expect(findCol(view, 'properties.Assignee.people')).toBeDefined();
      expect(findCol(view, 'properties.Name.title')).toBeDefined();
    });

    it('drills formula/rollup exactly one level to their inner object', () => {
      const formula = findCol(view, 'properties.Formula.formula');
      const rollup = findCol(view, 'properties.Computed Total.rollup');
      expect(formula?.type).toBe('object');
      expect(rollup?.type).toBe('object');
      // No deep extraction of the doubly-nested result value.
      expect(formula?.subfields).toBeUndefined();
      expect(rollup?.subfields).toBeUndefined();
    });
  });

  describe('inner-value type mapping (derived from the corrected schema)', () => {
    it('maps number/checkbox/url/string scalar inner values', () => {
      expect(findCol(view, 'properties.Score.number')?.type).toBe('number');
      expect(findCol(view, 'properties.Done.checkbox')?.type).toBe('checkbox');
      expect(findCol(view, 'properties.Website.url')?.type).toBe('url');
      expect(findCol(view, 'properties.Email.email')?.type).toBe('string');
    });

    it('types url columns from the connector data type, not a schema format', () => {
      // Notion url properties are free-text, so notion-json-schema.ts emits NO
      // format:'uri' on the inner value (otherwise enforce_schema rejects verbatim
      // values like "lu.ma/adithya"). The 'url' column type must therefore derive
      // from x-scratch-connector-data-type. This builds the real generated schema
      // (which has no format) and asserts the column still types as 'url' — guarding
      // against re-coupling url display-typing to a format assertion.
      const urlOnly = buildView({ Website: { id: 'p_url', type: 'url' } });
      expect(findCol(urlOnly, 'properties.Website.url')?.type).toBe('url');
    });

    it('maps object/array inner values to object', () => {
      expect(findCol(view, 'properties.Priority.select')?.type).toBe('object');
      expect(findCol(view, 'properties.Tags.multi_select')?.type).toBe('object');
    });

    it('maps title and rich_text inner values to richtext (flattened to plain_text on display)', () => {
      expect(findCol(view, 'properties.Name.title')?.type).toBe('richtext');
      expect(findCol(view, 'properties.Notes.rich_text')?.type).toBe('richtext');
    });
  });

  describe('display transformer (declarative rich-text flattening)', () => {
    it('attaches an array-relative JSONPath concat transformer to title and rich_text', () => {
      const expected = {
        type: 'jsonpath',
        options: { expression: '$[*].plain_text', arrayHandling: 'concat' },
      };
      expect(findCol(view, 'properties.Name.title')?.displayTransformer).toEqual(expected);
      expect(findCol(view, 'properties.Notes.rich_text')?.displayTransformer).toEqual(expected);
    });

    it('does not attach a display transformer to non-rich-text columns', () => {
      expect(findCol(view, 'properties.Score.number')?.displayTransformer).toBeUndefined();
      expect(findCol(view, 'properties.Status.status')?.displayTransformer).toBeUndefined();
      expect(findCol(view, 'properties.Tags.multi_select')?.displayTransformer).toBeUndefined();
    });
  });

  describe('subfield re-anchoring relative to the drilled path', () => {
    it('anchors select/status name subfield to the inner object', () => {
      const status = findCol(view, 'properties.Status.status');
      expect(status?.subfields?.[0].relativePath).toBe('name');
      expect(status?.selectedSubfield).toBe(0);

      const priority = findCol(view, 'properties.Priority.select');
      expect(priority?.subfields?.[0].relativePath).toBe('name');
    });

    it('anchors the date start subfield to the inner object', () => {
      const due = findCol(view, 'properties.Due Date.date');
      expect(due?.subfields?.[0].relativePath).toBe('start');
      expect(due?.subfields?.[0].type).toBe('date');
      expect(due?.selectedSubfield).toBe(0);
    });

    it('anchors id/name subfields for user property types', () => {
      const creator = findCol(view, 'properties.Created By Prop.created_by');
      expect(creator?.subfields?.[0].relativePath).toBe('id');
      expect(creator?.subfields?.[1].relativePath).toBe('name');
      expect(creator?.selectedSubfield).toBe(0);
    });

    it('does not add subfields to array properties (no array indexing)', () => {
      expect(findCol(view, 'properties.Name.title')?.subfields).toBeUndefined();
      expect(findCol(view, 'properties.Tags.multi_select')?.subfields).toBeUndefined();
    });

    it('does not add subfields to simple scalar types', () => {
      expect(findCol(view, 'properties.Score.number')?.subfields).toBeUndefined();
    });
  });

  describe('readonly', () => {
    it('marks read-only property types readonly', () => {
      expect(findCol(view, 'properties.Formula.formula')?.readonly).toBe(true);
      expect(findCol(view, 'properties.Computed Total.rollup')?.readonly).toBe(true);
      expect(findCol(view, 'properties.Created By Prop.created_by')?.readonly).toBe(true);
    });

    it('does not mark writable properties readonly', () => {
      expect(findCol(view, 'properties.Name.title')?.readonly).toBeUndefined();
    });

    it('marks the fixed read-only system fields readonly', () => {
      expect(findCol(view, 'created_time')?.readonly).toBe(true);
      expect(findCol(view, 'last_edited_time')?.readonly).toBe(true);
      expect(findCol(view, 'created_by')?.readonly).toBe(true);
      expect(findCol(view, 'last_edited_by')?.readonly).toBe(true);
      expect(findCol(view, 'url')?.readonly).toBe(true);
    });

    it('does not mark writable fixed fields (in_trash) readonly', () => {
      expect(findCol(view, 'in_trash')?.readonly).toBeUndefined();
    });
  });

  describe('hidden fixed fields', () => {
    it('hides object, parent, archived, is_archived, public_url', () => {
      expect(findCol(view, 'object')?.hidden).toBe(true);
      expect(findCol(view, 'parent')?.hidden).toBe(true);
      expect(findCol(view, 'archived')?.hidden).toBe(true);
      expect(findCol(view, 'is_archived')?.hidden).toBe(true);
      expect(findCol(view, 'public_url')?.hidden).toBe(true);
    });

    it('shows in_trash (the canonical 2026-03-11 trash flag)', () => {
      expect(findCol(view, 'in_trash')?.hidden).toBeUndefined();
    });

    it('does not hide property columns', () => {
      expect(findCol(view, 'properties.Name.title')?.hidden).toBeUndefined();
    });
  });

  describe('subfields on fixed fields', () => {
    it('adds the id subfield to created_by / last_edited_by', () => {
      expect(findCol(view, 'created_by')?.subfields?.[0].relativePath).toBe('id');
      expect(findCol(view, 'last_edited_by')?.subfields?.[0].relativePath).toBe('id');
    });

    it('adds the database_id subfield to parent', () => {
      expect(findCol(view, 'parent')?.subfields?.[0].relativePath).toBe('database_id');
    });
  });

  describe('fixed-field type mapping', () => {
    it('maps date-time fixed fields to date and uri fixed fields to url', () => {
      expect(findCol(view, 'created_time')?.type).toBe('date');
      expect(findCol(view, 'url')?.type).toBe('url');
    });
  });

  it('should handle an empty properties schema (fixed fields only)', () => {
    const emptySchema = Type.Object({
      object: Type.Literal('page'),
      id: Type.String(),
      properties: Type.Object({}),
    });
    const emptyView = buildNotionDefaultView(emptySchema);
    expect(emptyView.cols.length).toBe(2); // object and id
  });

  it('should not produce any banner groups', () => {
    expect(view.cols.filter((c) => c.kind === 'banner-group')).toHaveLength(0);
  });
});

describe('buildNotionDefaultView — missing connector data type guard (T2)', () => {
  it('falls back to properties.<name> instead of properties.<name>.undefined', () => {
    // A property envelope with no x-scratch-connector-data-type annotation: the
    // view cannot know the envelope key to drill into, so it must not emit a
    // `.undefined` path (which would silently render a blank cell).
    const schema = Type.Object({
      object: Type.Literal('page'),
      id: Type.String(),
      properties: Type.Object({
        Weird: Type.Optional(Type.Object({ id: Type.String(), type: Type.String() })),
      }),
    });

    const view = buildNotionDefaultView(schema);
    const weird = view.cols.find(
      (c) => c.kind === 'col' && (c.path === 'properties.Weird' || c.path.startsWith('properties.Weird.')),
    ) as TableViewCol;

    expect(weird).toBeDefined();
    expect(weird.path).toBe('properties.Weird');
  });
});
