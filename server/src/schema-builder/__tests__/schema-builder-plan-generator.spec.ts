import { TransformerTypes } from '@spinner/shared-types';
import type { SchemaField } from 'src/utils/schema-helpers';
import { linkedTableIdIndexKeysForRemoteTableId } from '../foreign-key-linked-table-id';
import {
  generateCreatePlanFromSources,
  inferLogicalFieldType,
  PlanGeneratorSource,
} from '../schema-builder-plan-generator';

const field = (overrides: Partial<SchemaField> & { path: string }): SchemaField => ({
  type: 'string',
  ...overrides,
});

describe('inferLogicalFieldType', () => {
  it('maps primitives from the JSON-Schema type', () => {
    expect(inferLogicalFieldType(field({ path: 'b', type: 'boolean' }))).toMatchObject({
      status: 'mapped',
      fieldType: { kind: 'boolean' },
    });
    expect(inferLogicalFieldType(field({ path: 'i', type: 'integer' }))).toMatchObject({
      status: 'mapped',
      fieldType: { kind: 'number', format: 'integer' },
    });
    expect(inferLogicalFieldType(field({ path: 'n', type: 'number' })).fieldType).toEqual({ kind: 'number' });
    expect(inferLogicalFieldType(field({ path: 's', type: 'string' })).fieldType).toEqual({ kind: 'text' });
  });

  it('downgrades structurally complex (object/array) fields to text', () => {
    expect(inferLogicalFieldType(field({ path: 'o', type: 'object' }))).toMatchObject({
      status: 'downgraded',
      fieldType: { kind: 'text' },
    });
    expect(inferLogicalFieldType(field({ path: 'a', type: 'array' }))).toMatchObject({
      status: 'downgraded',
      fieldType: { kind: 'text' },
    });
  });

  it('names the source service in downgrade/unrecognized notes when known, and stays generic when not', () => {
    // Unrecognized type — names the service when we know it, "this" otherwise.
    expect(inferLogicalFieldType(field({ path: 'x', type: 'weird' }), undefined, 'Notion').message).toBe(
      'Don\'t recognize Notion field type "weird", syncing as plain text',
    );
    expect(inferLogicalFieldType(field({ path: 'x', type: 'weird' })).message).toBe(
      'Don\'t recognize this field type "weird", syncing as plain text',
    );

    // Complex object/array field — "Can't unpack this <service> <type> field".
    expect(inferLogicalFieldType(field({ path: 'o', type: 'object' }), undefined, 'Notion').message).toBe(
      "Can't unpack this Notion object field, syncing as plain text",
    );
    expect(inferLogicalFieldType(field({ path: 'a', type: 'array' })).message).toBe(
      "Can't unpack this array field, syncing as plain text",
    );

    // The 'object' view hint takes the same wording.
    expect(inferLogicalFieldType(field({ path: 'o', type: 'string' }), 'object', 'Notion').message).toBe(
      "Can't unpack this Notion object field, syncing as plain text",
    );
  });

  // DEV-11076: a multi-valued source into a created text field once earned an extra "only the first value
  // will sync … dropped" warning (DEV-10956). It was false — the picker comma-joins every element into any
  // destination slot that consumes a string, Notion `rich_text`/`title` included since DEV-10952 — so the
  // note is gone and the accurate base wording stands for EVERY destination.
  describe('multi-valued source into a created text field (DEV-11076)', () => {
    it('keeps the base "syncing as plain text" wording for a native array source, whatever the destination', () => {
      const result = inferLogicalFieldType(field({ path: 'tags', type: 'array' }), undefined, 'Notion');
      expect(result).toMatchObject({ status: 'downgraded', fieldType: { kind: 'text' } });
      expect(result.message).toBe("Can't unpack this Notion array field, syncing as plain text");
    });

    it('keeps the base wording for a source declared multi-valued by an array-emitting suggestedTransformer', () => {
      const arraySource = field({
        path: 'people',
        type: 'object',
        suggestedTransformer: {
          type: TransformerTypes.JSONPath,
          options: { expression: '$[*]', arrayHandling: 'array' },
        },
      });
      const result = inferLogicalFieldType(arraySource, undefined, 'Notion');
      expect(result).toMatchObject({ status: 'downgraded' });
      expect(result.message).not.toContain('only the first value will sync');
    });

    it('does not warn at all for a single-valued source', () => {
      expect(inferLogicalFieldType(field({ path: 's', type: 'string' }), undefined, 'Notion')).toMatchObject({
        status: 'mapped',
        fieldType: { kind: 'text' },
      });
    });
  });

  it('keeps read-only fields at their real type instead of downgrading to text', () => {
    // This tool copies a table for a sync, so a read-only source field becomes an
    // editable destination column of the SAME logical type (e.g. a read-only
    // last_edited_time stays a date), not a text field.
    expect(inferLogicalFieldType(field({ path: 'rn', type: 'number', readonly: true }))).toMatchObject({
      status: 'mapped',
      fieldType: { kind: 'number' },
    });
    expect(inferLogicalFieldType(field({ path: 'rd', type: 'string', readonly: true }), 'date')).toMatchObject({
      status: 'mapped',
      fieldType: { kind: 'date' },
    });
    expect(inferLogicalFieldType(field({ path: 'rs', type: 'string', readonly: true }))).toMatchObject({
      status: 'mapped',
      fieldType: { kind: 'text' },
    });
  });

  it('preserves time-of-day for a datetime source field (format: date-time)', () => {
    // DEV-10788: a datetime source (Webflow published-on, Shopify createdAt, HubSpot
    // closedate) carries the coarse 'date' view hint but a `format: 'date-time'`
    // annotation — promote it to a real datetime so the destination keeps the time.
    expect(inferLogicalFieldType(field({ path: 'dt', type: 'string', format: 'date-time' }), 'date').fieldType).toEqual(
      { kind: 'date', includesTime: true },
    );
    // A plain calendar date (format: 'date', or no format) stays date-only.
    expect(inferLogicalFieldType(field({ path: 'd0', type: 'string', format: 'date' }), 'date').fieldType).toEqual({
      kind: 'date',
    });
    expect(inferLogicalFieldType(field({ path: 'd1', type: 'string' }), 'date').fieldType).toEqual({ kind: 'date' });
  });

  it('prefers a TablePropertyType view hint when present', () => {
    expect(inferLogicalFieldType(field({ path: 'd', type: 'string' }), 'date').fieldType).toEqual({ kind: 'date' });
    expect(inferLogicalFieldType(field({ path: 'u', type: 'string' }), 'url').fieldType).toEqual({ kind: 'url' });
    expect(inferLogicalFieldType(field({ path: 'rt', type: 'string' }), 'richtext').fieldType).toEqual({
      kind: 'longText',
    });
    expect(inferLogicalFieldType(field({ path: 'c', type: 'string' }), 'checkbox').fieldType).toEqual({
      kind: 'boolean',
    });
  });

  it('honors the semantic email / phone view hints a connector unwraps to', () => {
    expect(inferLogicalFieldType(field({ path: 'e', type: 'string' }), 'email')).toEqual({
      status: 'mapped',
      fieldType: { kind: 'email' },
    });
    expect(inferLogicalFieldType(field({ path: 'p', type: 'string' }), 'phone')).toEqual({
      status: 'mapped',
      fieldType: { kind: 'phone' },
    });
  });
});

describe('generateCreatePlanFromSources', () => {
  const authors: PlanGeneratorSource = {
    ref: 'authors',
    dataFolderId: 'authors',
    tableName: 'Authors',
    remoteTableIds: ['tblAuthors'],
    primaryFieldPath: 'name',
    schemaFields: [field({ path: 'name', type: 'string' })],
  };
  const posts: PlanGeneratorSource = {
    ref: 'posts',
    dataFolderId: 'posts',
    tableName: 'Posts',
    remoteTableIds: ['tblPosts'],
    idFieldPath: 'id',
    primaryFieldPath: 'title',
    schemaFields: [
      field({ path: 'id', type: 'string' }),
      field({ path: 'title', type: 'string' }),
      field({ path: 'author', type: 'string', foreignKey: { linkedTableId: 'tblAuthors' } }),
    ],
  };

  it('renames a field that collides with a destination reserved name (Postgres auto "id")', () => {
    const colors: PlanGeneratorSource = {
      ref: 'colors',
      dataFolderId: 'colors',
      tableName: 'Colors',
      remoteTableIds: ['tblColors'],
      primaryFieldPath: 'name',
      // "ID" folds to the reserved "id"; without the rename it is dropped at create (the Postgres
      // connector rejects it) and then unresolvable at apply. Case-insensitive.
      schemaFields: [field({ path: 'name', type: 'string' }), field({ path: 'ID', type: 'string' })],
    };
    const { tables, notes } = generateCreatePlanFromSources({
      sources: [colors],
      destinationConnectorAccountId: 'destConn',
      destinationReservedFieldNames: ['id'],
    });

    const table = tables.find((t) => t.ref === 'colors');
    expect(table?.fields.map((f) => f.name)).toContain('ID 2');
    expect(table?.fields.map((f) => f.name)).not.toContain('ID');
    const idNote = notes.find((n) => n.sourceFieldPath === 'ID');
    expect(idNote?.fieldName).toBe('ID 2');
    expect(idNote?.renamedFromName).toBe('ID');
    expect(idNote?.message).toContain('reserved by the destination');
  });

  it('resolves a foreignKey to a sibling source as an in-plan ref', () => {
    const { tables, notes } = generateCreatePlanFromSources({
      sources: [authors, posts],
      destinationConnectorAccountId: 'destConn',
    });

    const postsTable = tables.find((table) => table.ref === 'posts');
    expect(postsTable).toBeDefined();
    // id column is skipped; title + author remain, plus the injected source-record-id
    // field (generic name here since this source has no connectorService).
    expect(postsTable?.fields.map((f) => f.name)).toEqual(['title', 'author', 'source_record_id']);
    const authorField = postsTable?.fields.find((f) => f.name === 'author');
    expect(authorField?.fieldType).toEqual({ kind: 'foreignKey', target: { ref: 'authors' } });

    const titleField = postsTable?.fields.find((f) => f.name === 'title');
    expect(titleField?.isPrimary).toBe(true);

    const authorNote = notes.find((note) => note.sourceFieldPath === 'author');
    expect(authorNote).toMatchObject({ status: 'mapped', mappedKind: 'foreignKey' });
  });

  it('emits an unresolvable foreignKey as needs_target with a pending target (not dropped)', () => {
    const orphan: PlanGeneratorSource = {
      ref: 'posts',
      dataFolderId: 'posts',
      tableName: 'Posts',
      remoteTableIds: ['tblPosts'],
      idFieldPath: 'id',
      schemaFields: [field({ path: 'author', type: 'string', foreignKey: { linkedTableId: 'tblMissing' } })],
    };
    const { tables, notes } = generateCreatePlanFromSources({
      sources: [orphan],
      destinationConnectorAccountId: 'destConn',
    });

    // The FK is kept as an available field carrying a pending target (alongside the
    // injected source-record-id), not silently omitted.
    expect(tables[0].fields.map((f) => f.name)).toEqual(['author', 'source_record_id']);
    expect(tables[0].fields.find((f) => f.name === 'author')?.fieldType).toEqual({
      kind: 'foreignKey',
      target: { unresolvedLinkedTableId: 'tblMissing' },
    });
    expect(notes.find((note) => note.sourceFieldPath === 'author')).toMatchObject({
      status: 'needs_target',
      mappedKind: 'foreignKey',
      sourceLinkedTableId: 'tblMissing',
    });
  });

  it("carries the source foreignKey's linkedTableRemoteId onto the pending target when the connector emits it", () => {
    const orphan: PlanGeneratorSource = {
      ref: 'posts',
      dataFolderId: 'posts',
      tableName: 'Posts',
      remoteTableIds: ['projectRef', 'public', 'posts'],
      idFieldPath: 'id',
      schemaFields: [
        field({
          path: 'author_id',
          type: 'string',
          foreignKey: { linkedTableId: 'authors', linkedTableRemoteId: ['projectRef', 'public', 'authors'] },
        }),
      ],
    };
    const { tables } = generateCreatePlanFromSources({
      sources: [orphan],
      destinationConnectorAccountId: 'destConn',
    });

    // The array rides alongside the string token so a consumer can bind the pending target
    // by comparing it to the source folder's `DataFolder.tableId` directly.
    expect(tables[0].fields.find((f) => f.name === 'author_id')?.fieldType).toEqual({
      kind: 'foreignKey',
      target: {
        unresolvedLinkedTableId: 'authors',
        unresolvedLinkedTableRemoteId: ['projectRef', 'public', 'authors'],
      },
    });
  });

  it("binds a sibling foreignKey by the linked table's remote id when the string token matches nothing (DEV-10941)", () => {
    // QuickBooks annotates a foreign key with its LOWER-CASED wsId while `listTables` gives the
    // linked table the RAW-cased remote id, so the string token can never match the sibling's
    // remote-table keys — only the `linkedTableRemoteId` array binds the two.
    const invoice: PlanGeneratorSource = {
      ref: 'invoice',
      dataFolderId: 'invoice',
      tableName: 'Invoice',
      remoteTableIds: linkedTableIdIndexKeysForRemoteTableId(['Invoice']),
      schemaFields: [
        field({
          path: 'CustomerRef',
          type: 'string',
          foreignKey: { linkedTableId: 'customer', linkedTableRemoteId: ['Customer'] },
        }),
      ],
    };
    const customer: PlanGeneratorSource = {
      ref: 'customer',
      dataFolderId: 'customer',
      tableName: 'Customer',
      remoteTableIds: linkedTableIdIndexKeysForRemoteTableId(['Customer']),
      schemaFields: [field({ path: 'DisplayName', type: 'string' })],
    };
    const { tables, notes } = generateCreatePlanFromSources({
      sources: [invoice, customer],
      destinationConnectorAccountId: 'destConn',
    });

    expect(tables.find((table) => table.ref === 'invoice')?.fields[0].fieldType).toEqual({
      kind: 'foreignKey',
      target: { ref: 'customer' },
    });
    expect(notes.find((note) => note.sourceFieldPath === 'CustomerRef')?.status).not.toBe('needs_target');
  });

  it('resolves a foreignKey via linkedTableMappings to an existing remote table', () => {
    const orphan: PlanGeneratorSource = {
      ref: 'posts',
      dataFolderId: 'posts',
      tableName: 'Posts',
      remoteTableIds: ['tblPosts'],
      schemaFields: [field({ path: 'author', type: 'string', foreignKey: { linkedTableId: 'tblExternal' } })],
    };
    const { tables } = generateCreatePlanFromSources({
      sources: [orphan],
      destinationConnectorAccountId: 'destConn',
      linkedTableMappings: [{ sourceLinkedTableId: 'tblExternal', destinationRemoteTableId: ['destTbl'] }],
    });

    expect(tables[0].fields[0].fieldType).toEqual({
      kind: 'foreignKey',
      target: { existingRemoteTableId: ['destTbl'] },
    });
  });
});

describe('generateCreatePlanFromSources — array source into a created text field (DEV-11076)', () => {
  const withArrayField: PlanGeneratorSource = {
    ref: 'items',
    dataFolderId: 'items',
    tableName: 'Items',
    remoteTableIds: ['tblItems'],
    primaryFieldPath: 'name',
    schemaFields: [field({ path: 'name', type: 'string' }), field({ path: 'tags', type: 'array' })],
  };

  // Every destination comma-joins an array into a text field — Notion included, since its `rich_text`
  // pack declares `fromCoreInputType: 'string'` (DEV-10952). So no destination gets the old
  // "only the first value will sync … dropped" note; they all get the accurate base wording.
  it.each([['Notion'], [undefined]])('keeps the base downgrade wording for destination %s', (displayName) => {
    const { notes } = generateCreatePlanFromSources({
      sources: [withArrayField],
      destinationConnectorAccountId: 'destConn',
      ...(displayName ? { destinationServiceDisplayName: displayName } : {}),
    });

    const tagsNote = notes.find((n) => n.sourceFieldPath === 'tags');
    expect(tagsNote).toMatchObject({ status: 'downgraded', mappedKind: 'text' });
    expect(tagsNote?.message).toBe("Can't unpack this array field, syncing as plain text");
  });
});

describe('generateCreatePlanFromSources — injected source-record-id field', () => {
  const sourceWith = (overrides: Partial<PlanGeneratorSource>): PlanGeneratorSource => ({
    ref: 'posts',
    dataFolderId: 'posts',
    tableName: 'Posts',
    remoteTableIds: ['tblPosts'],
    idFieldPath: 'id',
    schemaFields: [field({ path: 'id', type: 'string' }), field({ path: 'title', type: 'string' })],
    ...overrides,
  });

  it('injects a text field named for the source connector service, marked isSourceRecordId', () => {
    const { tables } = generateCreatePlanFromSources({
      sources: [sourceWith({ connectorService: 'POSTGRES' })],
      destinationConnectorAccountId: 'destConn',
    });

    const injected = tables[0].fields.find((f) => f.name === 'postgres_record_id');
    expect(injected).toEqual({
      name: 'postgres_record_id',
      fieldType: { kind: 'text' },
      description: 'Remote id of the source record this row was synced from.',
      isSourceRecordId: true,
    });
    // It is bookkeeping-only — never the DB-level required flag, never primary.
    expect(injected?.required).toBeUndefined();
    expect(injected?.isPrimary).toBeUndefined();
  });

  it('disambiguates with a _source_ infix when source and destination are the same service', () => {
    const { tables } = generateCreatePlanFromSources({
      sources: [sourceWith({ connectorService: 'POSTGRES' })],
      destinationConnectorAccountId: 'destConn',
      destinationConnectorService: 'POSTGRES',
    });
    expect(tables[0].fields.some((f) => f.name === 'postgres_source_record_id' && f.isSourceRecordId)).toBe(true);
    expect(tables[0].fields.some((f) => f.name === 'postgres_record_id')).toBe(false);
  });

  it('keeps the plain name when source and destination services differ', () => {
    const { tables } = generateCreatePlanFromSources({
      sources: [sourceWith({ connectorService: 'POSTGRES' })],
      destinationConnectorAccountId: 'destConn',
      destinationConnectorService: 'AIRTABLE',
    });
    expect(tables[0].fields.some((f) => f.name === 'postgres_record_id' && f.isSourceRecordId)).toBe(true);
  });

  it('falls back to a generic name when the source has no connector service', () => {
    const { tables } = generateCreatePlanFromSources({
      sources: [sourceWith({})],
      destinationConnectorAccountId: 'destConn',
    });
    expect(tables[0].fields.some((f) => f.name === 'source_record_id' && f.isSourceRecordId)).toBe(true);
  });

  it('does not inject when a same-named field already exists on the source (case-insensitive)', () => {
    const { tables } = generateCreatePlanFromSources({
      sources: [
        sourceWith({
          connectorService: 'POSTGRES',
          schemaFields: [field({ path: 'id', type: 'string' }), field({ path: 'Postgres_Record_Id', type: 'string' })],
        }),
      ],
      destinationConnectorAccountId: 'destConn',
    });
    const matching = tables[0].fields.filter((f) => f.name.toLowerCase() === 'postgres_record_id');
    expect(matching).toHaveLength(1);
    // The pre-existing source field is left as-is — not relabelled as the source id.
    expect(matching[0].isSourceRecordId).toBeUndefined();
  });

  it('emits a mapped note feeding the injected field from the source remote-id path', () => {
    const { tables, notes } = generateCreatePlanFromSources({
      sources: [sourceWith({ connectorService: 'POSTGRES', idFieldPath: 'id.record_id' })],
      destinationConnectorAccountId: 'destConn',
    });
    const injected = tables[0].fields.find((f) => f.isSourceRecordId);
    expect(injected?.name).toBe('postgres_record_id');
    // The note pairs the source's idPath path with the injected field name,
    // so the client/sync knows where to source this column's value from.
    expect(notes.find((note) => note.fieldName === 'postgres_record_id')).toEqual({
      sourceDataFolderId: 'posts',
      sourceFieldPath: 'id.record_id',
      fieldName: 'postgres_record_id',
      status: 'mapped',
      mappedKind: 'text',
    });
  });

  it('does not inject (or emit a note) when the source has no remote-id path', () => {
    const { tables, notes } = generateCreatePlanFromSources({
      sources: [sourceWith({ connectorService: 'POSTGRES', idFieldPath: undefined })],
      destinationConnectorAccountId: 'destConn',
    });
    // No source identity to preserve -> no point creating the field.
    expect(tables[0].fields.some((f) => f.isSourceRecordId)).toBe(false);
    expect(tables[0].fields.some((f) => f.name === 'postgres_record_id')).toBe(false);
    expect(notes.some((note) => note.fieldName === 'postgres_record_id')).toBe(false);
  });

  it('does not inject into an add-fields plan for an existing destination table', () => {
    const { tables, fieldPlans } = generateCreatePlanFromSources({
      sources: [
        sourceWith({
          connectorService: 'POSTGRES',
          existingDestination: { dataFolderId: 'destPosts', remoteTableId: ['tblDestPosts'], existingFields: [] },
        }),
      ],
      destinationConnectorAccountId: 'destConn',
    });
    expect(tables).toHaveLength(0);
    expect(fieldPlans[0].fields.some((f) => f.isSourceRecordId)).toBe(false);
  });
});

describe('generateCreatePlanFromSources — existing destination table (add-fields diff)', () => {
  // A source whose destination table already exists yields an add-fields plan: the
  // source fields diffed against the destination's current fields, never a new table.
  const authorsSource: PlanGeneratorSource = {
    ref: 'authors',
    dataFolderId: 'authors',
    tableName: 'Authors',
    remoteTableIds: ['tblAuthors'],
    primaryFieldPath: 'name',
    idFieldPath: 'id',
    schemaFields: [
      field({ path: 'id', type: 'string' }),
      field({ path: 'name', type: 'string' }),
      field({ path: 'bio', type: 'string' }),
      field({ path: 'age', type: 'integer' }),
    ],
  };

  // Each existing destination field is given the kind of the same-named source
  // field, so a name match is a kind match → adoption (the re-add case).
  const authorsIntoExisting = (existingNames: string[]): PlanGeneratorSource => ({
    ...authorsSource,
    existingDestination: {
      dataFolderId: 'destAuthors',
      remoteTableId: ['tblDestAuthors'],
      existingFields: existingNames.map((name) => {
        const sourceField = authorsSource.schemaFields.find(
          (f) => (f.displayLabel ?? f.path.split('.').pop() ?? '').toLowerCase() === name.trim().toLowerCase(),
        );
        return {
          name,
          columnPath: name.trim().toLowerCase(),
          kind: sourceField ? inferLogicalFieldType(sourceField).fieldType.kind : 'text',
        };
      }),
    },
  });

  it('emits a fieldPlan (not a table) and drops fields the destination already has', () => {
    const { tables, fieldPlans, notes } = generateCreatePlanFromSources({
      sources: [authorsIntoExisting(['name'])],
      destinationConnectorAccountId: 'destConn',
    });

    expect(tables).toHaveLength(0);
    expect(fieldPlans).toHaveLength(1);
    expect(fieldPlans[0]).toMatchObject({
      sourceDataFolderId: 'authors',
      destinationDataFolderId: 'destAuthors',
      connectorAccountId: 'destConn',
      remoteTableId: ['tblDestAuthors'],
    });
    // id is skipped (destination owns it); 'name' already exists (adopted); bio + age remain.
    expect(fieldPlans[0].fields.map((f) => f.name)).toEqual(['bio', 'age']);
    expect(notes.find((note) => note.fieldName === 'name')).toMatchObject({
      status: 'adopted',
      mappedKind: 'text',
      existingDestinationColumnId: 'name',
    });
  });

  it('matches existing field names case-insensitively', () => {
    const { fieldPlans } = generateCreatePlanFromSources({
      sources: [authorsIntoExisting(['NAME', ' Bio '])],
      destinationConnectorAccountId: 'destConn',
    });
    expect(fieldPlans[0].fields.map((f) => f.name)).toEqual(['age']);
  });

  it('does not re-designate a primary field on an existing table', () => {
    const { fieldPlans } = generateCreatePlanFromSources({
      sources: [authorsIntoExisting([])],
      destinationConnectorAccountId: 'destConn',
    });
    expect(fieldPlans[0].fields.map((f) => f.name)).toEqual(['name', 'bio', 'age']);
    expect(fieldPlans[0].fields.every((f) => f.isPrimary === undefined)).toBe(true);
  });

  it('still yields a fieldPlan with no fields when the destination already has everything', () => {
    const { fieldPlans, notes } = generateCreatePlanFromSources({
      sources: [authorsIntoExisting(['name', 'bio', 'age'])],
      destinationConnectorAccountId: 'destConn',
    });
    expect(fieldPlans).toHaveLength(1);
    expect(fieldPlans[0].fields).toHaveLength(0);
    // Every source field has a same-kind match on the destination → all adopted,
    // nothing dropped silently.
    expect(notes.filter((note) => note.status === 'adopted')).toHaveLength(3);
  });

  it('adopts an existing destination field of the same name and kind (maps to it, does not recreate)', () => {
    const { fieldPlans, notes } = generateCreatePlanFromSources({
      sources: [authorsIntoExisting(['bio'])],
      destinationConnectorAccountId: 'destConn',
    });
    // bio is adopted (text → text), so it's not in the create list; name + age are.
    expect(fieldPlans[0].fields.map((f) => f.name)).toEqual(['name', 'age']);
    expect(notes.find((note) => note.fieldName === 'bio')).toMatchObject({
      status: 'adopted',
      mappedKind: 'text',
      existingDestinationColumnId: 'bio',
    });
  });

  it('does not adopt an existing field of the same name but a different kind — skips it instead', () => {
    // The destination "age" is text, but the source "age" is a number → can't adopt.
    const source: PlanGeneratorSource = {
      ...authorsSource,
      existingDestination: {
        dataFolderId: 'destAuthors',
        remoteTableId: ['tblDestAuthors'],
        existingFields: [{ name: 'age', columnPath: 'age', kind: 'text' }],
      },
    };
    const { fieldPlans, notes } = generateCreatePlanFromSources({
      sources: [source],
      destinationConnectorAccountId: 'destConn',
      destinationServiceDisplayName: 'Airtable',
    });
    // age is neither created (name collision) nor adopted (kind mismatch) → exists.
    expect(fieldPlans[0].fields.map((f) => f.name)).toEqual(['name', 'bio']);
    expect(notes.find((note) => note.fieldName === 'age')).toMatchObject({
      status: 'exists',
      message: 'Skipping "age", a field with that name already exists in Airtable with an incompatible type',
    });
  });

  it('emits a sibling-ref foreignKey as needs_target when adding to an existing table', () => {
    const postsIntoExisting: PlanGeneratorSource = {
      ref: 'posts',
      dataFolderId: 'posts',
      tableName: 'Posts',
      remoteTableIds: ['tblPosts'],
      schemaFields: [field({ path: 'author', type: 'string', foreignKey: { linkedTableId: 'tblAuthors' } })],
      existingDestination: { dataFolderId: 'destPosts', remoteTableId: ['tblDestPosts'], existingFields: [] },
    };
    // authorsSource registers tblAuthors as a sibling; a sibling { ref } can't be added
    // to an existing table via /schema/fields, so it's emitted with a pending target to
    // be bound to an existing remote table rather than dropped.
    const { tables, fieldPlans, notes } = generateCreatePlanFromSources({
      sources: [authorsSource, postsIntoExisting],
      destinationConnectorAccountId: 'destConn',
    });

    // Mixed: authors is a new table, posts is an add-fields plan.
    expect(tables.map((table) => table.ref)).toEqual(['authors']);
    const postsPlan = fieldPlans.find((plan) => plan.sourceDataFolderId === 'posts');
    expect(postsPlan?.fields).toHaveLength(1);
    expect(postsPlan?.fields[0].fieldType).toEqual({
      kind: 'foreignKey',
      target: { unresolvedLinkedTableId: 'tblAuthors' },
    });
    expect(notes.find((note) => note.sourceFieldPath === 'author')).toMatchObject({
      status: 'needs_target',
      sourceLinkedTableId: 'tblAuthors',
    });
  });

  it('keeps a linkedTableMappings foreignKey as existingRemoteTableId in a fieldPlan', () => {
    const postsIntoExisting: PlanGeneratorSource = {
      ref: 'posts',
      dataFolderId: 'posts',
      tableName: 'Posts',
      remoteTableIds: ['tblPosts'],
      schemaFields: [field({ path: 'author', type: 'string', foreignKey: { linkedTableId: 'tblExternal' } })],
      existingDestination: { dataFolderId: 'destPosts', remoteTableId: ['tblDestPosts'], existingFields: [] },
    };
    const { fieldPlans } = generateCreatePlanFromSources({
      sources: [postsIntoExisting],
      destinationConnectorAccountId: 'destConn',
      linkedTableMappings: [{ sourceLinkedTableId: 'tblExternal', destinationRemoteTableId: ['destTbl'] }],
    });

    expect(fieldPlans[0].fields[0].fieldType).toEqual({
      kind: 'foreignKey',
      target: { existingRemoteTableId: ['destTbl'] },
    });
  });
});

describe('generateCreatePlanFromSources — duplicate field names (DEV-10441)', () => {
  it('suffixes a duplicate field name within a table and records renamedFromName', () => {
    const source: PlanGeneratorSource = {
      ref: 'contacts',
      dataFolderId: 'contacts',
      tableName: 'Contacts',
      remoteTableIds: ['tblContacts'],
      idFieldPath: 'id',
      schemaFields: [
        field({ path: 'a', type: 'string', displayLabel: 'Email' }),
        field({ path: 'b', type: 'string', displayLabel: 'Email' }),
      ],
    };
    const { tables, notes } = generateCreatePlanFromSources({
      sources: [source],
      destinationConnectorAccountId: 'destConn',
    });

    expect(tables[0].fields.map((f) => f.name)).toEqual(['Email', 'Email 2', 'source_record_id']);
    const renamedNote = notes.find((note) => note.sourceFieldPath === 'b');
    expect(renamedNote).toMatchObject({ fieldName: 'Email 2', renamedFromName: 'Email', status: 'mapped' });
    expect(renamedNote?.message).toContain('renamed from "Email"');
  });

  it('treats duplicate field names case-insensitively', () => {
    const source: PlanGeneratorSource = {
      ref: 'contacts',
      dataFolderId: 'contacts',
      tableName: 'Contacts',
      remoteTableIds: ['tblContacts'],
      idFieldPath: 'id',
      schemaFields: [
        field({ path: 'a', type: 'string', displayLabel: 'Name' }),
        field({ path: 'b', type: 'string', displayLabel: 'name' }),
      ],
    };
    const { tables } = generateCreatePlanFromSources({
      sources: [source],
      destinationConnectorAccountId: 'destConn',
    });
    expect(tables[0].fields.map((f) => f.name)).toEqual(['Name', 'name 2', 'source_record_id']);
  });

  it('dedupes field names independently per table (same name across tables is fine)', () => {
    const t1: PlanGeneratorSource = {
      ref: 't1',
      dataFolderId: 't1',
      tableName: 'T1',
      remoteTableIds: ['tbl1'],
      idFieldPath: 'id',
      schemaFields: [field({ path: 'a', type: 'string', displayLabel: 'Name' })],
    };
    const t2: PlanGeneratorSource = {
      ref: 't2',
      dataFolderId: 't2',
      tableName: 'T2',
      remoteTableIds: ['tbl2'],
      idFieldPath: 'id',
      schemaFields: [field({ path: 'a', type: 'string', displayLabel: 'Name' })],
    };
    const { tables } = generateCreatePlanFromSources({
      sources: [t1, t2],
      destinationConnectorAccountId: 'destConn',
    });
    expect(tables.find((t) => t.ref === 't1')?.fields.map((f) => f.name)).toEqual(['Name', 'source_record_id']);
    expect(tables.find((t) => t.ref === 't2')?.fields.map((f) => f.name)).toEqual(['Name', 'source_record_id']);
  });

  it('suffixes a duplicate NEW field while still skipping one that matches an existing destination field', () => {
    const source: PlanGeneratorSource = {
      ref: 'contacts',
      dataFolderId: 'contacts',
      tableName: 'Contacts',
      remoteTableIds: ['tblContacts'],
      schemaFields: [
        field({ path: 'a', type: 'string', displayLabel: 'Name' }), // already on destination → adopted
        field({ path: 'b', type: 'string', displayLabel: 'Color' }), // new → Color
        field({ path: 'c', type: 'string', displayLabel: 'Color' }), // duplicate new → Color 2
      ],
      existingDestination: {
        dataFolderId: 'destContacts',
        remoteTableId: ['tblDest'],
        existingFields: [{ name: 'Name', columnPath: 'Name', kind: 'text' }],
      },
    };
    const { fieldPlans, notes } = generateCreatePlanFromSources({
      sources: [source],
      destinationConnectorAccountId: 'destConn',
    });

    expect(fieldPlans[0].fields.map((f) => f.name)).toEqual(['Color', 'Color 2']);
    expect(notes.find((note) => note.sourceFieldPath === 'a')).toMatchObject({ status: 'adopted' });
    expect(notes.find((note) => note.sourceFieldPath === 'c')).toMatchObject({
      fieldName: 'Color 2',
      renamedFromName: 'Color',
    });
  });

  it('suffixes around an existing destination field name when deduping new fields', () => {
    const source: PlanGeneratorSource = {
      ref: 'contacts',
      dataFolderId: 'contacts',
      tableName: 'Contacts',
      remoteTableIds: ['tblContacts'],
      schemaFields: [
        field({ path: 'b', type: 'string', displayLabel: 'Color' }),
        field({ path: 'c', type: 'string', displayLabel: 'Color' }),
      ],
      existingDestination: {
        dataFolderId: 'destContacts',
        remoteTableId: ['tblDest'],
        existingFields: [{ name: 'Color 2', columnPath: 'Color 2', kind: 'text' }],
      },
    };
    const { fieldPlans } = generateCreatePlanFromSources({
      sources: [source],
      destinationConnectorAccountId: 'destConn',
    });
    // 'Color' is free; the duplicate skips the existing 'Color 2' and becomes 'Color 3'.
    expect(fieldPlans[0].fields.map((f) => f.name)).toEqual(['Color', 'Color 3']);
  });
});

describe('generateCreatePlanFromSources — duplicate table names (DEV-10441)', () => {
  const makeSource = (ref: string, tableName: string): PlanGeneratorSource => ({
    ref,
    dataFolderId: ref,
    tableName,
    remoteTableIds: [`tbl_${ref}`],
    schemaFields: [field({ path: 'name', type: 'string' })],
  });

  it('suffixes a table name that duplicates another new table in the same plan', () => {
    const { tables, tableNotes } = generateCreatePlanFromSources({
      sources: [makeSource('a', 'Tasks'), makeSource('b', 'Tasks')],
      destinationConnectorAccountId: 'destConn',
    });

    expect(tables.map((t) => t.name)).toEqual(['Tasks', 'Tasks 2']);
    // refs are preserved despite the rename, so FK wiring is unaffected.
    expect(tables.map((t) => t.ref)).toEqual(['a', 'b']);
    expect(tableNotes).toHaveLength(1);
    expect(tableNotes[0]).toMatchObject({
      ref: 'b',
      tableName: 'Tasks 2',
      renamedFromName: 'Tasks',
      reason: 'duplicate_in_plan',
    });
  });

  it('suffixes a table name that conflicts with an existing destination table', () => {
    const { tables, tableNotes } = generateCreatePlanFromSources({
      sources: [makeSource('a', 'Tasks')],
      destinationConnectorAccountId: 'destConn',
      existingDestinationTableNames: ['tasks'], // case-insensitive
    });

    expect(tables.map((t) => t.name)).toEqual(['Tasks 2']);
    expect(tableNotes[0]).toMatchObject({
      tableName: 'Tasks 2',
      renamedFromName: 'Tasks',
      reason: 'conflicts_with_existing_table',
    });
  });

  it('emits no table note when no rename is needed', () => {
    const { tables, tableNotes } = generateCreatePlanFromSources({
      sources: [makeSource('a', 'Tasks'), makeSource('b', 'Notes')],
      destinationConnectorAccountId: 'destConn',
      existingDestinationTableNames: ['Other'],
    });

    expect(tables.map((t) => t.name)).toEqual(['Tasks', 'Notes']);
    expect(tableNotes).toEqual([]);
  });
});

describe('generateCreatePlanFromSources — name-length limits (DEV-10816)', () => {
  const LONG_FIELD_NAME = 'a_very_long_field_name_that_exceeds_the_destination_identifier_limit';
  const LONG_TABLE_NAME = 'A Very Long Table Name That Exceeds The Destination Identifier Limit';

  it('elides a field name over the destination limit, keeping the plan under it', () => {
    const source: PlanGeneratorSource = {
      ref: 'contacts',
      dataFolderId: 'contacts',
      tableName: 'Contacts',
      remoteTableIds: ['tblContacts'],
      idFieldPath: 'id',
      schemaFields: [field({ path: 'a', type: 'string', displayLabel: LONG_FIELD_NAME })],
    };
    const { tables, notes } = generateCreatePlanFromSources({
      sources: [source],
      destinationConnectorAccountId: 'destConn',
      destinationMaxFieldNameLength: 63,
    });

    const emittedField = tables[0].fields[0];
    expect(emittedField.name.length).toBeLessThanOrEqual(63);
    expect(emittedField.name).toContain('…');
    // The distinguishing tail survives the middle elision.
    expect(emittedField.name.endsWith('limit')).toBe(true);

    const note = notes.find((n) => n.sourceFieldPath === 'a');
    expect(note?.renamedFromName).toBe(LONG_FIELD_NAME);
    expect(note?.message).toContain('63-character field-name limit');
  });

  it('elides a table name over the destination limit and notes the truncation', () => {
    const source: PlanGeneratorSource = {
      ref: 't',
      dataFolderId: 't',
      tableName: LONG_TABLE_NAME,
      remoteTableIds: ['tbl'],
      schemaFields: [field({ path: 'name', type: 'string' })],
    };
    const { tables, tableNotes } = generateCreatePlanFromSources({
      sources: [source],
      destinationConnectorAccountId: 'destConn',
      destinationMaxTableNameLength: 63,
    });

    expect(tables[0].name.length).toBeLessThanOrEqual(63);
    expect(tables[0].name).toContain('…');
    expect(tableNotes[0]).toMatchObject({
      ref: 't',
      renamedFromName: LONG_TABLE_NAME,
      reason: 'truncated_to_length_limit',
    });
    expect(tableNotes[0].message).toContain('63-character table-name limit');
  });

  it('keeps deduped field names under the limit (suffix reserved)', () => {
    const source: PlanGeneratorSource = {
      ref: 'contacts',
      dataFolderId: 'contacts',
      tableName: 'Contacts',
      remoteTableIds: ['tblContacts'],
      idFieldPath: 'id',
      schemaFields: [
        field({ path: 'a', type: 'string', displayLabel: LONG_FIELD_NAME }),
        field({ path: 'b', type: 'string', displayLabel: LONG_FIELD_NAME }),
      ],
    };
    const { tables } = generateCreatePlanFromSources({
      sources: [source],
      destinationConnectorAccountId: 'destConn',
      destinationMaxFieldNameLength: 63,
    });

    const [first, second] = tables[0].fields;
    expect(first.name.length).toBeLessThanOrEqual(63);
    expect(second.name.length).toBeLessThanOrEqual(63);
    expect(second.name).not.toBe(first.name);
    expect(second.name.endsWith(' 2')).toBe(true);
  });

  it('leaves names that already fit unchanged (no elision, no note)', () => {
    const source: PlanGeneratorSource = {
      ref: 't',
      dataFolderId: 't',
      tableName: 'Tasks',
      remoteTableIds: ['tbl'],
      schemaFields: [field({ path: 'a', type: 'string', displayLabel: 'Title' })],
    };
    const { tables, notes, tableNotes } = generateCreatePlanFromSources({
      sources: [source],
      destinationConnectorAccountId: 'destConn',
      destinationMaxTableNameLength: 63,
      destinationMaxFieldNameLength: 63,
    });

    expect(tables[0].name).toBe('Tasks');
    expect(tables[0].fields[0].name).toBe('Title');
    expect(tableNotes).toEqual([]);
    expect(notes.find((n) => n.sourceFieldPath === 'a')?.renamedFromName).toBeUndefined();
  });
});

describe('generateCreatePlanFromSources — fallback primary field', () => {
  // A source that designated NO title column (no primaryFieldPath), as happens
  // when a Postgres table's headline column isn't named name/title/etc.
  const sourceWithoutTitleColumn = (schemaFields: SchemaField[]): PlanGeneratorSource => ({
    ref: 'people',
    dataFolderId: 'people',
    tableName: 'People',
    remoteTableIds: ['tblPeople'],
    schemaFields,
  });

  const primaryFieldNames = (table: { fields: { name: string; isPrimary?: boolean }[] }): string[] =>
    table.fields.filter((f) => f.isPrimary).map((f) => f.name);

  it('promotes the highest-priority primary-sounding field when the destination requires one', () => {
    const { tables } = generateCreatePlanFromSources({
      sources: [
        sourceWithoutTitleColumn([
          field({ path: 'created_at', type: 'string' }),
          field({ path: 'bio', type: 'string' }),
          field({ path: 'full_name', type: 'string' }),
        ]),
      ],
      destinationConnectorAccountId: 'destConn',
      destinationRequiresPrimaryField: true,
    });

    // `full_name` (normalizes to a listed candidate) wins over the non-candidate
    // `created_at`/`bio`, even though it comes last in column order.
    expect(primaryFieldNames(tables[0])).toEqual(['full_name']);
  });

  it('falls back to the first eligible field in column order when no name matches and there is no source id', () => {
    const { tables } = generateCreatePlanFromSources({
      sources: [
        // No idFieldPath ⇒ no injected source-record-id, so the id fallback can't apply.
        sourceWithoutTitleColumn([field({ path: 'bio', type: 'string' }), field({ path: 'website', type: 'string' })]),
      ],
      destinationConnectorAccountId: 'destConn',
      destinationRequiresPrimaryField: true,
    });

    expect(primaryFieldNames(tables[0])).toEqual(['bio']);
  });

  it('falls back to the source-record-id ("ID") field over an arbitrary data column when no name matches', () => {
    const { tables } = generateCreatePlanFromSources({
      sources: [
        {
          ...sourceWithoutTitleColumn([
            field({ path: 'id', type: 'string' }),
            field({ path: 'status', type: 'string' }),
            field({ path: 'comment', type: 'string' }),
          ]),
          // Injects a `<service>_record_id` field marked isSourceRecordId.
          idFieldPath: 'id',
          connectorService: 'WEBFLOW',
        },
      ],
      destinationConnectorAccountId: 'destConn',
      destinationRequiresPrimaryField: true,
    });

    // Prefer the stable id over the incidental first column ("status").
    expect(primaryFieldNames(tables[0])).toEqual(['webflow_record_id']);
  });

  it('prefers a real title column over the source-record-id when one exists', () => {
    const { tables } = generateCreatePlanFromSources({
      sources: [
        {
          ...sourceWithoutTitleColumn([
            field({ path: 'id', type: 'string' }),
            field({ path: 'headline', type: 'string' }),
          ]),
          idFieldPath: 'id',
          connectorService: 'WEBFLOW',
        },
      ],
      destinationConnectorAccountId: 'destConn',
      destinationRequiresPrimaryField: true,
    });

    // `headline` is a title-name candidate, so it wins over the id fallback.
    expect(primaryFieldNames(tables[0])).toEqual(['headline']);
  });

  it('only considers fields of an allowed kind, overriding name priority', () => {
    const { tables } = generateCreatePlanFromSources({
      sources: [
        sourceWithoutTitleColumn([
          // Best name, but a number kind Notion can't use as its title.
          field({ path: 'title', type: 'number' }),
          field({ path: 'description', type: 'string' }),
        ]),
      ],
      destinationConnectorAccountId: 'destConn',
      destinationRequiresPrimaryField: true,
      destinationPrimaryFieldKinds: ['text', 'longText'],
    });

    expect(primaryFieldNames(tables[0])).toEqual(['description']);
  });

  it('does not promote a primary when the destination does not require one', () => {
    const { tables } = generateCreatePlanFromSources({
      sources: [sourceWithoutTitleColumn([field({ path: 'full_name', type: 'string' })])],
      destinationConnectorAccountId: 'destConn',
    });

    expect(primaryFieldNames(tables[0])).toEqual([]);
  });

  it('keeps the source-designated primary and never marks a second', () => {
    const source: PlanGeneratorSource = {
      ref: 'people',
      dataFolderId: 'people',
      tableName: 'People',
      remoteTableIds: ['tblPeople'],
      primaryFieldPath: 'handle',
      schemaFields: [field({ path: 'handle', type: 'string' }), field({ path: 'name', type: 'string' })],
    };
    const { tables } = generateCreatePlanFromSources({
      sources: [source],
      destinationConnectorAccountId: 'destConn',
      destinationRequiresPrimaryField: true,
    });

    // `handle` was the source's title column; `name` is NOT also promoted even
    // though it's a stronger candidate name.
    expect(primaryFieldNames(tables[0])).toEqual(['handle']);
  });

  it('uses the injected source-record-id as primary for a table of only an id and a link', () => {
    const source: PlanGeneratorSource = {
      ref: 'joins',
      dataFolderId: 'joins',
      tableName: 'Joins',
      remoteTableIds: ['tblJoins'],
      idFieldPath: 'id',
      schemaFields: [
        field({ path: 'id', type: 'string' }),
        field({ path: 'author', type: 'string', foreignKey: { linkedTableId: 'tblPeople' } }),
      ],
      connectorService: 'POSTGRES',
    };
    const { tables } = generateCreatePlanFromSources({
      sources: [source],
      destinationConnectorAccountId: 'destConn',
      // The link is never primary-eligible; the injected source-record-id is the fallback.
      destinationRequiresPrimaryField: true,
      linkedTableMappings: [{ sourceLinkedTableId: 'tblPeople', destinationRemoteTableId: ['tblPeopleDest'] }],
    });

    expect(primaryFieldNames(tables[0])).toEqual(['postgres_record_id']);
  });

  it('leaves a truly degenerate table (only a link, no source id) without a primary', () => {
    const source: PlanGeneratorSource = {
      ref: 'joins',
      dataFolderId: 'joins',
      tableName: 'Joins',
      remoteTableIds: ['tblJoins'],
      // No idFieldPath ⇒ no injected source-record-id to fall back to.
      schemaFields: [field({ path: 'author', type: 'string', foreignKey: { linkedTableId: 'tblPeople' } })],
    };
    const { tables } = generateCreatePlanFromSources({
      sources: [source],
      destinationConnectorAccountId: 'destConn',
      destinationRequiresPrimaryField: true,
      linkedTableMappings: [{ sourceLinkedTableId: 'tblPeople', destinationRemoteTableId: ['tblPeopleDest'] }],
    });

    // Nothing is primary-eligible; the create-time validator surfaces this.
    expect(primaryFieldNames(tables[0])).toEqual([]);
  });
});

describe('generateCreatePlanFromSources — reciprocal foreign keys (DEV-10753)', () => {
  // A symmetric relationship between two tables: Projects.tasks ↔ Tasks.project. Each side's
  // foreignKey.inverseFieldId points at the other side's remoteFieldId, so the two are recognized as
  // one relationship. `isSingleValued` distinguishes the many-side FK (Tasks.project → one project)
  // from the list side (Projects.tasks → many tasks).
  const projectsSide = (opts: { tasksIsSingleValued?: boolean } = {}): PlanGeneratorSource => ({
    ref: 'projects',
    dataFolderId: 'projects',
    tableName: 'Projects',
    remoteTableIds: ['tblProjects'],
    schemaFields: [
      field({ path: 'name', type: 'string' }),
      field({
        path: 'tasks',
        type: 'array',
        remoteFieldId: 'fldProjectsTasks',
        foreignKey: {
          linkedTableId: 'tblTasks',
          inverseFieldId: 'fldTasksProject',
          ...(opts.tasksIsSingleValued ? { isSingleValued: true } : {}),
        },
      }),
    ],
  });
  const tasksSide = (opts: { projectIsSingleValued?: boolean } = {}): PlanGeneratorSource => ({
    ref: 'tasks',
    dataFolderId: 'tasks',
    tableName: 'Tasks',
    remoteTableIds: ['tblTasks'],
    schemaFields: [
      field({ path: 'name', type: 'string' }),
      field({
        path: 'project',
        type: 'array',
        remoteFieldId: 'fldTasksProject',
        foreignKey: {
          linkedTableId: 'tblProjects',
          inverseFieldId: 'fldProjectsTasks',
          ...(opts.projectIsSingleValued ? { isSingleValued: true } : {}),
        },
      }),
    ],
  });

  const fieldNames = (tables: ReturnType<typeof generateCreatePlanFromSources>['tables'], ref: string): string[] =>
    tables.find((table) => table.ref === ref)?.fields.map((f) => f.name) ?? [];

  it('1→N: keeps the single-valued side and drops the multi-valued list side', () => {
    // A task belongs to one project (Tasks.project single-valued); a project has many tasks
    // (Projects.tasks multi-valued). Keep the normalized FK on the many-side (Tasks.project).
    const { tables, notes } = generateCreatePlanFromSources({
      sources: [projectsSide(), tasksSide({ projectIsSingleValued: true })],
      destinationConnectorAccountId: 'destConn',
    });

    expect(fieldNames(tables, 'tasks')).toContain('project');
    expect(fieldNames(tables, 'projects')).not.toContain('tasks');

    const droppedNote = notes.find((note) => note.sourceFieldPath === 'tasks');
    expect(droppedNote).toMatchObject({ status: 'skipped_reciprocal', mappedKind: 'foreignKey' });
    expect(droppedNote?.message).toContain('Tasks');
    expect(droppedNote?.message).toContain('project');
    // The kept side is a normal mapped FK, not suppressed.
    expect(notes.find((note) => note.sourceFieldPath === 'project')).toMatchObject({
      status: 'mapped',
      mappedKind: 'foreignKey',
    });
  });

  it('1→N: side order does not matter — always keeps the single-valued side', () => {
    const { tables } = generateCreatePlanFromSources({
      // Same pair, sources listed in the opposite order.
      sources: [tasksSide({ projectIsSingleValued: true }), projectsSide()],
      destinationConnectorAccountId: 'destConn',
    });
    expect(fieldNames(tables, 'tasks')).toContain('project');
    expect(fieldNames(tables, 'projects')).not.toContain('tasks');
  });

  it('N→N to a many-to-many-capable destination: keeps exactly one side (deterministically)', () => {
    const run = () =>
      generateCreatePlanFromSources({
        sources: [projectsSide(), tasksSide()],
        destinationConnectorAccountId: 'destConn',
        destinationSupportsManyToManyForeignKeys: true,
      });
    const { tables, notes } = run();

    // Exactly one of the two link fields survives.
    const projectsHasLink = fieldNames(tables, 'projects').includes('tasks');
    const tasksHasLink = fieldNames(tables, 'tasks').includes('project');
    expect(projectsHasLink !== tasksHasLink).toBe(true);
    // Deterministic tiebreak: 'projects tasks' < 'tasks project', so the projects side is kept.
    expect(projectsHasLink).toBe(true);

    expect(notes.filter((note) => note.status === 'skipped_reciprocal')).toHaveLength(1);
    // Reproducible across runs.
    const rerunTables = run().tables;
    expect(fieldNames(rerunTables, 'projects')).toEqual(fieldNames(tables, 'projects'));
    expect(fieldNames(rerunTables, 'tasks')).toEqual(fieldNames(tables, 'tasks'));
  });

  it('N→N to a destination that cannot represent it (e.g. Postgres): drops BOTH sides', () => {
    const { tables, notes } = generateCreatePlanFromSources({
      sources: [projectsSide(), tasksSide()],
      destinationConnectorAccountId: 'destConn',
      destinationSupportsManyToManyForeignKeys: false,
    });

    expect(fieldNames(tables, 'projects')).not.toContain('tasks');
    expect(fieldNames(tables, 'tasks')).not.toContain('project');
    const reciprocalNotes = notes.filter((note) => note.status === 'skipped_reciprocal');
    expect(reciprocalNotes).toHaveLength(2);
    for (const note of reciprocalNotes) expect(note.message).toContain('many-to-many');
  });

  it('does not deduplicate when only one side of the relationship is in the plan', () => {
    // Projects.tasks references tblTasks, but no Tasks source is present ⇒ nothing to collapse.
    const { tables } = generateCreatePlanFromSources({
      sources: [projectsSide()],
      destinationConnectorAccountId: 'destConn',
      linkedTableMappings: [{ sourceLinkedTableId: 'tblTasks', destinationRemoteTableId: ['tblTasksDest'] }],
    });
    expect(fieldNames(tables, 'projects')).toContain('tasks');
  });

  it('does not deduplicate one-way links that carry no inverse field id (asymmetric services)', () => {
    // Two mutually-linking tables whose FKs have NO inverseFieldId (e.g. Webflow, HubSpot). Both kept.
    const left: PlanGeneratorSource = {
      ref: 'left',
      dataFolderId: 'left',
      tableName: 'Left',
      remoteTableIds: ['tblLeft'],
      schemaFields: [field({ path: 'toRight', type: 'array', foreignKey: { linkedTableId: 'tblRight' } })],
    };
    const right: PlanGeneratorSource = {
      ref: 'right',
      dataFolderId: 'right',
      tableName: 'Right',
      remoteTableIds: ['tblRight'],
      schemaFields: [field({ path: 'toLeft', type: 'array', foreignKey: { linkedTableId: 'tblLeft' } })],
    };
    const { tables, notes } = generateCreatePlanFromSources({
      sources: [left, right],
      destinationConnectorAccountId: 'destConn',
    });
    expect(fieldNames(tables, 'left')).toContain('toRight');
    expect(fieldNames(tables, 'right')).toContain('toLeft');
    expect(notes.some((note) => note.status === 'skipped_reciprocal')).toBe(false);
  });

  it('downgrades a multi-valued one-way FK to a scalar-FK destination: field kept, note warns only the first links', () => {
    // A HubSpot-style association (multi-valued, no inverseFieldId) into a Postgres destination whose FK is a
    // single scalar column. The field is still emitted, but its note is `downgraded` to warn that only the
    // first linked record syncs — this is what the plan-output UI shows the user.
    const source: PlanGeneratorSource = {
      ref: 'calls',
      dataFolderId: 'calls',
      tableName: 'Calls',
      remoteTableIds: ['tblCalls'],
      schemaFields: [field({ path: 'contacts', type: 'array', foreignKey: { linkedTableId: 'tblContacts' } })],
    };
    const { tables, notes } = generateCreatePlanFromSources({
      sources: [source],
      destinationConnectorAccountId: 'destConn',
      linkedTableMappings: [{ sourceLinkedTableId: 'tblContacts', destinationRemoteTableId: ['tblContactsDest'] }],
      destinationSupportsManyToManyForeignKeys: false,
    });
    expect(fieldNames(tables, 'calls')).toContain('contacts');
    const note = notes.find((n) => n.fieldName === 'contacts');
    expect(note).toMatchObject({ status: 'downgraded', mappedKind: 'foreignKey' });
    expect(note?.message).toContain('only the first linked record will sync');
  });

  it('does not downgrade a single-valued FK to a scalar-FK destination (no data is lost)', () => {
    // A genuinely single-valued source FK fits a scalar destination column exactly — no narrowing, `mapped`.
    const source: PlanGeneratorSource = {
      ref: 'tasks',
      dataFolderId: 'tasks',
      tableName: 'Tasks',
      remoteTableIds: ['tblTasks'],
      schemaFields: [
        field({ path: 'project', type: 'string', foreignKey: { linkedTableId: 'tblProjects', isSingleValued: true } }),
      ],
    };
    const { notes } = generateCreatePlanFromSources({
      sources: [source],
      destinationConnectorAccountId: 'destConn',
      linkedTableMappings: [{ sourceLinkedTableId: 'tblProjects', destinationRemoteTableId: ['tblProjectsDest'] }],
      destinationSupportsManyToManyForeignKeys: false,
    });
    expect(notes.find((n) => n.fieldName === 'project')).toMatchObject({ status: 'mapped', mappedKind: 'foreignKey' });
  });
});
