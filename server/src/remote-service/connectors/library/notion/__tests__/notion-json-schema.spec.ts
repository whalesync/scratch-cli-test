import { type DataSourceObjectResponse } from '@notionhq/client';
import {
  TransformerConfig,
  X_SCRATCH_ASSET_FIELD,
  X_SCRATCH_CONNECTOR_DATA_TYPE,
  X_SCRATCH_FOREIGN_KEY_OPTIONS,
  X_SCRATCH_LAST_MODIFIED_FIELD,
  X_SCRATCH_READONLY,
  X_SCRATCH_REMOTE_FIELD_ID,
  X_SCRATCH_SUGGESTED_IN_TRANSFORMER,
  X_SCRATCH_SUGGESTED_IN_TRANSFORMER_INPUT_TYPE,
  X_SCRATCH_SUGGESTED_TRANSFORMER,
  X_SCRATCH_VIRTUAL_FIELDS,
} from '@spinner/shared-types';
import { Service } from 'src/remote-service/connectors/service-constants';
import { applyTransformerPipeline, createNullLookupTools } from 'src/sync/transformers';
import { buildNotionJsonTableSpec, notionPropertyToJsonSchema } from '../notion-json-schema';

type SchemaNode = Record<string, unknown>;

/** Generate the envelope schema for a single property, as a navigable record. */
function prop(type: string, extra: Record<string, unknown> = {}): SchemaNode {
  const property = {
    id: `id_${type}`,
    name: `${type} field`,
    type,
    ...extra,
  } as unknown as DataSourceObjectResponse['properties'][string];
  return notionPropertyToJsonSchema(property) as unknown as SchemaNode;
}

/** The `properties` map of an object schema node. */
function props(node: SchemaNode): Record<string, SchemaNode> {
  return node.properties as Record<string, SchemaNode>;
}

/** The `const` of a Type.Literal node. */
function literalConst(node: SchemaNode): unknown {
  return node.const;
}

/** Recursively collect every string `format` reachable through anyOf/allOf wrappers. */
function collectStringFormats(node: SchemaNode | undefined): string[] {
  if (!node) return [];
  if (typeof node.format === 'string') return [node.format];
  const variants = (node.anyOf as SchemaNode[]) ?? (node.allOf as SchemaNode[]) ?? [];
  return variants.flatMap((variant) => collectStringFormats(variant));
}

describe('notionPropertyToJsonSchema — transform hints', () => {
  it('rich_text carries a pack (in) hint with a clear emptyTemplate and an unpack (out) hint', () => {
    const node = prop('rich_text');
    expect(node[X_SCRATCH_SUGGESTED_IN_TRANSFORMER]).toEqual({
      type: 'wrap_object',
      options: {
        template: {
          type: 'rich_text',
          rich_text: [{ type: 'text', text: { content: '$value' }, plain_text: '$value' }],
        },
        emptyTemplate: { type: 'rich_text', rich_text: [] },
      },
    });
    expect(node[X_SCRATCH_SUGGESTED_TRANSFORMER]).toEqual({
      type: 'jsonpath',
      options: { expression: '$.rich_text[*].plain_text', arrayHandling: 'concat' },
    });
  });

  it('title carries a pack hint with a clear emptyTemplate; its unpack stays a virtual field', () => {
    const node = prop('title');
    expect(node[X_SCRATCH_SUGGESTED_IN_TRANSFORMER]).toEqual({
      type: 'wrap_object',
      options: {
        template: { type: 'title', title: [{ type: 'text', text: { content: '$value' }, plain_text: '$value' }] },
        emptyTemplate: { type: 'title', title: [] },
      },
    });
    expect(node[X_SCRATCH_SUGGESTED_TRANSFORMER]).toBeUndefined();
    expect(node[X_SCRATCH_VIRTUAL_FIELDS]).toBeDefined();
  });

  it('scalar types carry a pack hint that wraps into their envelope, with a null clear shape', () => {
    expect(prop('number')[X_SCRATCH_SUGGESTED_IN_TRANSFORMER]).toEqual({
      type: 'wrap_object',
      options: { template: { type: 'number', number: '$value' }, emptyTemplate: { type: 'number', number: null } },
    });
    expect(prop('select')[X_SCRATCH_SUGGESTED_IN_TRANSFORMER]).toEqual({
      type: 'wrap_object',
      options: {
        template: { type: 'select', select: { name: '$value' } },
        emptyTemplate: { type: 'select', select: null },
      },
    });
    expect(prop('email')[X_SCRATCH_SUGGESTED_IN_TRANSFORMER]).toEqual({
      type: 'wrap_object',
      options: { template: { type: 'email', email: '$value' }, emptyTemplate: { type: 'email', email: null } },
    });
  });

  it('checkbox has no clear shape (boolean is never empty), so it omits emptyTemplate', () => {
    expect(prop('checkbox')[X_SCRATCH_SUGGESTED_IN_TRANSFORMER]).toEqual({
      type: 'wrap_object',
      options: { template: { type: 'checkbox', checkbox: '$value' } },
    });
  });

  it('deferred / reference types carry no pack hint', () => {
    expect(prop('multi_select')[X_SCRATCH_SUGGESTED_IN_TRANSFORMER]).toBeUndefined();
  });

  // DEV-10952: each single-value pack declares the CoreValue primitive it consumes, so the picker
  // coerces a non-matching source (a Postgres integer, an attachment object, a text "5") before it.
  it('declares the pack input primitive: string for text slots, number/boolean for native scalars', () => {
    for (const stringPackType of ['title', 'rich_text', 'url', 'email', 'phone_number', 'select', 'date']) {
      expect(prop(stringPackType)[X_SCRATCH_SUGGESTED_IN_TRANSFORMER_INPUT_TYPE]).toBe('string');
    }
    expect(prop('number')[X_SCRATCH_SUGGESTED_IN_TRANSFORMER_INPUT_TYPE]).toBe('number');
    expect(prop('checkbox')[X_SCRATCH_SUGGESTED_IN_TRANSFORMER_INPUT_TYPE]).toBe('boolean');
  });

  it('relation (a multi-value map_array pack) declares no single-value input type', () => {
    expect(
      prop('relation', { relation: { database_id: 'db1' } })[X_SCRATCH_SUGGESTED_IN_TRANSFORMER_INPUT_TYPE],
    ).toBeUndefined();
  });

  it('a type with no pack hint declares no input type', () => {
    expect(prop('multi_select')[X_SCRATCH_SUGGESTED_IN_TRANSFORMER_INPUT_TYPE]).toBeUndefined();
  });

  it('relation packs a CoreValue id array into the relation envelope (DEV-10942)', () => {
    // What `source_fk_to_dest_fk` emits is a raw id array; without this pack it lands
    // verbatim in the property and Notion rejects the write. Each id wraps to `{ id }`,
    // the list into the `{ type: 'relation', relation: [...] }` envelope; an empty/null
    // value packs to `relation: []` — Notion's clear shape.
    expect(prop('relation', { relation: { database_id: 'db1' } })[X_SCRATCH_SUGGESTED_IN_TRANSFORMER]).toEqual({
      type: 'map_array',
      options: {
        elementTransformer: { type: 'wrap_object', options: { template: { id: '$value' } } },
        resultTemplate: { type: 'relation', relation: '$value' },
      },
    });
  });
});

describe('notionPropertyToJsonSchema — raw envelope shape', () => {
  describe('every property is an object envelope { id, type, <typeKey> }', () => {
    it('wraps a scalar property (email) in the envelope', () => {
      const s = prop('email');
      expect(s.type).toBe('object');
      expect(props(s).id.type).toBe('string');
      expect(literalConst(props(s).type)).toBe('email');
      // inner value is the unwrapped email value (nullable string union)
      expect(props(s).email.anyOf).toBeDefined();
    });

    it('wraps an array property (multi_select) in the envelope', () => {
      const s = prop('multi_select');
      expect(s.type).toBe('object');
      expect(literalConst(props(s).type)).toBe('multi_select');
      expect(props(s).multi_select.type).toBe('array');
    });

    it('wraps the title property; inner value is the rich-text array', () => {
      const s = prop('title');
      expect(literalConst(props(s).type)).toBe('title');
      expect(props(s).title.type).toBe('array');
    });
  });

  describe('annotations live on the OUTER envelope object', () => {
    it('puts connector-data-type and remote-field-id on the envelope', () => {
      const s = prop('email');
      expect(s[X_SCRATCH_CONNECTOR_DATA_TYPE]).toBe('email');
      expect(s[X_SCRATCH_REMOTE_FIELD_ID]).toBe('id_email');
    });

    it('marks read-only property types readonly on the envelope', () => {
      expect(prop('formula')[X_SCRATCH_READONLY]).toBe(true);
      expect(prop('rollup')[X_SCRATCH_READONLY]).toBe(true);
      expect(prop('created_time')[X_SCRATCH_READONLY]).toBe(true);
    });

    it('does not mark writable property types readonly', () => {
      expect(prop('email')[X_SCRATCH_READONLY]).toBeUndefined();
      expect(prop('number')[X_SCRATCH_READONLY]).toBeUndefined();
    });

    it('puts the title virtual field on the envelope with an envelope-relative JSONPath', () => {
      const s = prop('title');
      const virtual = s[X_SCRATCH_VIRTUAL_FIELDS] as Array<{
        suggestedTransformer: { options: { expression: string } };
      }>;
      expect(virtual).toBeDefined();
      expect(virtual[0].suggestedTransformer.options.expression).toBe('$.title[*].plain_text');
    });

    it('puts the files asset-field and virtual field on the envelope', () => {
      const s = prop('files');
      expect(s[X_SCRATCH_ASSET_FIELD]).toEqual({ idPath: null, urlExpires: true });
      expect(s[X_SCRATCH_VIRTUAL_FIELDS]).toBeDefined();
      expect(props(s).files.type).toBe('array');
    });
  });

  describe('relation — modeled with has_more and FK on the outer envelope', () => {
    const s = prop('relation', { relation: { database_id: 'db_linked', data_source_id: 'ds_linked' } });

    it('models the relation array and the has_more sibling', () => {
      expect(literalConst(props(s).type)).toBe('relation');
      expect(props(s).relation.type).toBe('array');
      expect(props(s).has_more).toBeDefined();
      expect(props(s).has_more.type).toBe('boolean');
    });

    it('makes has_more optional (not in required)', () => {
      const required = s.required as string[];
      expect(required).toContain('id');
      expect(required).toContain('relation');
      expect(required).not.toContain('has_more');
    });

    it('puts the foreign-key options on the outer envelope, without the legacy `map`', () => {
      // `map: 'id'` used to ride here, but its only consumer (file-reference extraction)
      // read `envelope.id` — the property's OWN id — producing a bogus reference row per
      // relation. The linked-page ids are extracted from the id leaf instead.
      // `linkedTableRemoteId` is the linked table's FULL folder remoteId — `[database_id,
      // data_source_id]` — which deep-equals `parseDataSourceTablePreview`'s
      // `[parentDatabaseId, dataSourceId]`.
      expect(s[X_SCRATCH_FOREIGN_KEY_OPTIONS]).toEqual({
        linkedTableId: 'db_linked',
        linkedTableRemoteId: ['db_linked', 'ds_linked'],
      });
    });

    it('ALSO puts the foreign-key options on the inner relation[].id leaf (DEV-10942)', () => {
      // The leaf annotation is what makes refs nested inside the envelope
      // (`relation: [{ id: '…' }]`) visible to the schema-driven FK walkers: the publish
      // ref-cleaner drops a stripped ref's enclosing element, and file-reference extraction
      // reads the linked-page ids for inbound-reference detection.
      const relationItems = props(s).relation.items as Record<string, Record<string, Record<string, unknown>>>;
      expect(relationItems.properties.id[X_SCRATCH_FOREIGN_KEY_OPTIONS]).toEqual({
        linkedTableId: 'db_linked',
        linkedTableRemoteId: ['db_linked', 'ds_linked'],
      });
    });

    it('carries inverseFieldId on the leaf for a dual_property relation', () => {
      const dual = prop('relation', {
        relation: {
          database_id: 'db_linked',
          data_source_id: 'ds_linked',
          type: 'dual_property',
          dual_property: { synced_property_id: 'prop_back', synced_property_name: 'Back' },
        },
      });
      const relationItems = props(dual).relation.items as Record<string, Record<string, Record<string, unknown>>>;
      expect(relationItems.properties.id[X_SCRATCH_FOREIGN_KEY_OPTIONS]).toEqual({
        linkedTableId: 'db_linked',
        linkedTableRemoteId: ['db_linked', 'ds_linked'],
        inverseFieldId: 'prop_back',
      });
    });

    it('omits foreign-key options when the relation has no database_id', () => {
      const noFk = prop('relation', { relation: {} });
      expect(noFk[X_SCRATCH_FOREIGN_KEY_OPTIONS]).toBeUndefined();
      const relationItems = props(noFk).relation.items as Record<string, Record<string, Record<string, unknown>>>;
      expect(relationItems.properties.id[X_SCRATCH_FOREIGN_KEY_OPTIONS]).toBeUndefined();
    });

    // DEV-10753: a dual_property (symmetric) relation carries the reciprocal property's id so the
    // create-plan generator can suggest only one side; a single_property (one-way) relation has none.
    it('surfaces inverseFieldId for a dual_property (symmetric) relation', () => {
      const dual = prop('relation', {
        relation: {
          database_id: 'db_linked',
          data_source_id: 'ds_linked',
          type: 'dual_property',
          dual_property: { synced_property_id: 'prop_back', synced_property_name: 'Back' },
        },
      });
      expect(dual[X_SCRATCH_FOREIGN_KEY_OPTIONS]).toEqual({
        linkedTableId: 'db_linked',
        linkedTableRemoteId: ['db_linked', 'ds_linked'],
        inverseFieldId: 'prop_back',
      });
    });

    it('omits inverseFieldId for a single_property (one-way) relation', () => {
      const single = prop('relation', {
        relation: {
          database_id: 'db_linked',
          data_source_id: 'ds_linked',
          type: 'single_property',
          single_property: {},
        },
      });
      expect(single[X_SCRATCH_FOREIGN_KEY_OPTIONS]).toEqual({
        linkedTableId: 'db_linked',
        linkedTableRemoteId: ['db_linked', 'ds_linked'],
      });
    });

    it('omits linkedTableRemoteId when the relation carries no data_source_id', () => {
      // Without the data-source segment we can't reconstruct the full 2-element folder
      // remoteId, so we emit only `linkedTableId` rather than a partial/wrong array.
      const noDataSource = prop('relation', { relation: { database_id: 'db_linked' } });
      expect(noDataSource[X_SCRATCH_FOREIGN_KEY_OPTIONS]).toEqual({ linkedTableId: 'db_linked' });
    });
  });

  describe('rollup — both nesting levels modeled', () => {
    const s = prop('rollup');

    it('models the inner rollup object with function/type', () => {
      expect(literalConst(props(s).type)).toBe('rollup');
      const rollupInner = props(s).rollup;
      expect(rollupInner.type).toBe('object');
      expect(props(rollupInner).function).toBeDefined();
      expect(props(rollupInner).type).toBeDefined();
    });
  });

  describe('null inner values', () => {
    it('models select as a nullable inner object', () => {
      const s = prop('select');
      const inner = props(s).select;
      const variants = inner.anyOf as SchemaNode[];
      expect(variants).toBeDefined();
      expect(variants.some((v) => v.type === 'null')).toBe(true);
    });

    it('models number as a nullable inner number', () => {
      const s = prop('number');
      const variants = props(s).number.anyOf as SchemaNode[];
      expect(variants.some((v) => v.type === 'null')).toBe(true);
      expect(variants.some((v) => v.type === 'number')).toBe(true);
    });
  });

  describe('date — accepts both date-only and date-time', () => {
    // Notion emits all-day dates as date-only ("2025-02-20") and timed dates as
    // full RFC3339, so start/end must validate under either precision.
    it('models start and end as a date|date-time string union', () => {
      const s = prop('date');
      const dateVariants = props(s).date.anyOf as SchemaNode[];
      const inner = dateVariants.find((v) => v.type !== 'null');
      expect(inner).toBeDefined();
      const innerProps = (inner?.properties ?? {}) as Record<string, SchemaNode>;

      expect(collectStringFormats(innerProps.start).sort()).toEqual(['date', 'date-time']);
      // `end` is Optional(Union([dateString, Null])) — same two formats, deeper.
      expect(collectStringFormats(innerProps.end).sort()).toEqual(['date', 'date-time']);
    });
  });

  describe('unknown / future property type', () => {
    it('keeps the envelope shape with an opaque inner value', () => {
      const s = prop('wacky_future_type');
      expect(s.type).toBe('object');
      expect(literalConst(props(s).type)).toBe('wacky_future_type');
      expect(props(s).wacky_future_type).toBeDefined();
      expect(s[X_SCRATCH_CONNECTOR_DATA_TYPE]).toBe('wacky_future_type');
    });
  });
});

describe('url/email properties are free-text — no format assertion', () => {
  // Notion does NOT validate the content of url/email properties. The API returns
  // verbatim whatever the user typed: schemeless domains ("lu.ma/adithya"), phone
  // numbers ("845-240-9716"), Twitter handles ("@_adenab"), notes ("Yohei tweet"),
  // even multiple comma-separated emails ("a@x.com, b@y.com"). The generated schema
  // must therefore NOT carry format:'uri'/'email' — the CLI's enforce_schema validator
  // runs with should_validate_formats(true) and would reject that legitimate data.
  // Regression for the 109 false-positive errors seen in the Whalesync Internal workspace.
  it('models the url inner value as a nullable string with no uri format', () => {
    const inner = props(prop('url')).url;
    expect(collectStringFormats(inner)).toEqual([]);
    const variants = inner.anyOf as SchemaNode[];
    expect(variants.some((v) => v.type === 'string' && v.format === undefined)).toBe(true);
    expect(variants.some((v) => v.type === 'null')).toBe(true);
  });

  it('models the email inner value as a nullable string with no email format', () => {
    const inner = props(prop('email')).email;
    expect(collectStringFormats(inner)).toEqual([]);
    const variants = inner.anyOf as SchemaNode[];
    expect(variants.some((v) => v.type === 'string' && v.format === undefined)).toBe(true);
    expect(variants.some((v) => v.type === 'null')).toBe(true);
  });
});

describe('people property — accepts group members, not just users', () => {
  // A Notion `people` property can hold workspace/teamspace GROUPS as well as individual
  // users: a group mentioned in a person property is returned verbatim as
  // `{ id, object: 'group', name }` (no `person` sub-object). If the member `object` were
  // locked to the literal 'user', enforce_schema would reject every group member ("user"
  // was expected) — the 19 false-positive errors on the Optemization design-partner
  // workspace (DEV-10571).

  /** The schema for a single item of the `people` array. */
  function peopleMember(): SchemaNode {
    return props(prop('people')).people.items as SchemaNode;
  }

  /** Every literal value the node accepts, whether modeled as const, enum, or an anyOf of those. */
  function acceptedConsts(node: SchemaNode | undefined): unknown[] {
    if (!node) return [];
    if (Array.isArray(node.enum)) return [...(node.enum as unknown[])];
    if (node.const !== undefined) return [node.const];
    const variants = (node.anyOf as SchemaNode[]) ?? (node.allOf as SchemaNode[]) ?? [];
    return variants.flatMap((variant) => acceptedConsts(variant));
  }

  it('models the member object field as a user|group union', () => {
    const objectField = props(peopleMember()).object;
    expect(acceptedConsts(objectField).sort()).toEqual(['group', 'user']);
  });

  it('keeps object constrained (a genuinely-wrong object like "page" still fails)', () => {
    const objectField = props(peopleMember()).object;
    // Must stay a closed set of the two known values — not widened to a free string,
    // which would stop surfacing genuinely-bad data.
    expect(acceptedConsts(objectField)).toHaveLength(2);
    expect(objectField.type).toBeUndefined();
  });

  it('requires only object and id, so the slimmer group shape (no person) still validates', () => {
    const member = peopleMember();
    expect((member.required as string[]).sort()).toEqual(['id', 'object']);
    // `person` (user-only) must remain optional, else groups would fail on its absence.
    expect((member.required as string[]).includes('person')).toBe(false);
  });
});

// ── Page-level envelope (unchanged behavior, kept as a guardrail) ──

function buildDataSource(): DataSourceObjectResponse {
  return {
    object: 'data_source',
    id: 'ds_123',
    title: [{ plain_text: 'My DB' }],
    properties: {
      Name: { id: 'title', name: 'Name', type: 'title' },
    },
  } as unknown as DataSourceObjectResponse;
}

describe('buildNotionJsonTableSpec top-level field annotations', () => {
  function topLevelProps(): Record<string, Record<string, unknown>> {
    const spec = buildNotionJsonTableSpec({ wsId: 'db', remoteId: ['db_123', 'ds_123'] }, buildDataSource());
    return (spec.schema as unknown as { properties: Record<string, Record<string, unknown>> }).properties;
  }

  it('annotates the top-level last_edited_time with x-scratch-last-modified-field=true', () => {
    expect(topLevelProps().last_edited_time[X_SCRATCH_LAST_MODIFIED_FIELD]).toBe(true);
  });

  it('does not annotate the created_time system field', () => {
    expect(topLevelProps().created_time[X_SCRATCH_LAST_MODIFIED_FIELD]).toBeUndefined();
  });

  it('marks the fixed read-only system fields readonly', () => {
    expect(topLevelProps().created_time[X_SCRATCH_READONLY]).toBe(true);
    expect(topLevelProps().last_edited_time[X_SCRATCH_READONLY]).toBe(true);
    expect(topLevelProps().created_by[X_SCRATCH_READONLY]).toBe(true);
    expect(topLevelProps().last_edited_by[X_SCRATCH_READONLY]).toBe(true);
    expect(topLevelProps().url[X_SCRATCH_READONLY]).toBe(true);
  });

  it('leaves genuinely writable fixed fields (cover, icon, in_trash) editable', () => {
    expect(topLevelProps().cover[X_SCRATCH_READONLY]).toBeUndefined();
    expect(topLevelProps().icon[X_SCRATCH_READONLY]).toBeUndefined();
    expect(topLevelProps().in_trash[X_SCRATCH_READONLY]).toBeUndefined();
  });

  it('icon union accepts emoji, external, file, built-in named icon, custom_emoji, and null', () => {
    const icon = topLevelProps().icon;
    const branches = (icon.anyOf ?? []) as Array<Record<string, unknown>>;
    const typeConsts = branches
      .map((branch) => (branch.properties as Record<string, { const?: unknown }> | undefined)?.type?.const)
      .filter((value): value is string => typeof value === 'string');
    expect(typeConsts).toEqual(expect.arrayContaining(['emoji', 'external', 'file', 'icon', 'custom_emoji']));
    // The null branch keeps the field nullable (a page with no icon).
    expect(branches.some((branch) => branch.type === 'null')).toBe(true);
  });
});

describe('notionPropertyToJsonSchema — pack/unpack round-trips for matchable types', () => {
  // Record matching canonicalizes a value with the field's OUTBOUND (unpack) transform.
  // For a locally-created record (packed by a sync but never round-tripped through Notion),
  // the INBOUND (pack) transform must populate exactly what the unpack reads — otherwise the
  // match key reduces to null and the next sync can't match the record, creating a duplicate
  // (and, if the push keeps failing, a fresh duplicate every run). This invariant —
  // unpack(pack(x)) === x — guards that contract for every type record matching can use.
  const SAMPLE = 'hubspot-12345';

  async function applyTransformer(config: TransformerConfig, value: unknown): Promise<unknown> {
    const result = await applyTransformerPipeline([config], value, {
      sourceRecord: { id: 'r', filePath: 'r.json', fields: {} },
      sourceFieldPath: 'field',
      sourceTableSpec: null,
      sourceService: Service.NOTION,
      destinationFieldPath: 'field',
      destinationTableSpec: null,
      destinationService: Service.NOTION,
      lookupTools: createNullLookupTools(),
      phase: 'DATA',
    });
    if (!result.success) throw new Error(`transform failed: ${result.error}`);
    return result.value;
  }

  /** The unpack transform a field exposes for matching — either directly or via its virtual field. */
  function unpackHint(node: SchemaNode): TransformerConfig | undefined {
    const direct = node[X_SCRATCH_SUGGESTED_TRANSFORMER] as TransformerConfig | undefined;
    if (direct) return direct;
    const virtual = node[X_SCRATCH_VIRTUAL_FIELDS] as Array<{ suggestedTransformer: TransformerConfig }> | undefined;
    return virtual?.[0]?.suggestedTransformer;
  }

  // The Notion types matching can use: they declare BOTH a pack and an unpack (rich_text's
  // unpack is a direct hint; title's is its virtual field). A type with a pack but no unpack
  // (number, date, …) can't be a match key, so the round-trip doesn't apply.
  it.each(['rich_text', 'title'])('%s: unpack(pack(value)) returns the original value', async (type) => {
    const node = prop(type);
    const pack = node[X_SCRATCH_SUGGESTED_IN_TRANSFORMER] as TransformerConfig | undefined;
    const unpack = unpackHint(node);
    expect(pack).toBeDefined();
    expect(unpack).toBeDefined();

    const packed = await applyTransformer(pack as TransformerConfig, SAMPLE);
    const unpacked = await applyTransformer(unpack as TransformerConfig, packed);

    // Fails if the pack omits what the unpack reads (e.g. rich_text/title `plain_text`),
    // which is exactly the bug that left pending files unmatchable.
    expect(unpacked).toBe(SAMPLE);
  });
});

describe('number pack coercion (DEV-10953)', () => {
  // A HubSpot-style source delivers numbers as strings, so the transform picker feeds Notion's number
  // pack the chain [auto_convert→number (preserveNull), wrap_object]. This exercises that exact chain to
  // prove (a) a numeric string becomes a REAL number Notion accepts, and (b) `preserveNull` lets an empty
  // value stay null so the pack's emptyTemplate CLEARS the field, rather than coercing null→0 and writing 0.
  const numberPack = prop('number')[X_SCRATCH_SUGGESTED_IN_TRANSFORMER] as TransformerConfig;
  const coerceToNumber: TransformerConfig = {
    type: 'auto_convert',
    options: { targetType: 'number', preserveNull: true },
  };

  async function runPackChain(value: unknown): Promise<unknown> {
    const result = await applyTransformerPipeline([coerceToNumber, numberPack], value, {
      sourceRecord: { id: 'r', filePath: 'r.json', fields: {} },
      sourceFieldPath: 'field',
      sourceTableSpec: null,
      sourceService: Service.NOTION,
      destinationFieldPath: 'field',
      destinationTableSpec: null,
      destinationService: Service.NOTION,
      lookupTools: createNullLookupTools(),
      phase: 'DATA',
    });
    if (!result.success) throw new Error(`transform failed: ${result.error}`);
    return result.value;
  }

  it('coerces a numeric string into a real number in the Notion number envelope', async () => {
    expect(await runPackChain('215000000')).toEqual({ type: 'number', number: 215000000 });
  });

  it('clears the field for an empty value (null → {number: null}), never 0', async () => {
    expect(await runPackChain(null)).toEqual({ type: 'number', number: null });
  });
});
