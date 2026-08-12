import { TSchema, Type } from '@sinclair/typebox';
import {
  TransformerTypes,
  X_SCRATCH_AIRTABLE_FIELD_ORDER,
  X_SCRATCH_ASSET_TABLE,
  X_SCRATCH_CONNECTOR_DATA_TYPE,
  X_SCRATCH_FOREIGN_KEY_OPTIONS,
  X_SCRATCH_READONLY,
  X_SCRATCH_REMOTE_FIELD_ID,
  X_SCRATCH_SUGGESTED_TRANSFORMER,
  X_SCRATCH_VIRTUAL_FIELDS,
} from '@spinner/shared-types';
import { extractSchemaFields, extractSchemaPaths, findCreatedDestinationField, SchemaField } from './schema-helpers';

/** Set an x-scratch annotation on a TypeBox schema node (mirrors the connector generators). */
function annotate(schema: TSchema, key: string, value: unknown): TSchema {
  (schema as unknown as Record<string, unknown>)[key] = value;
  return schema;
}

describe('schema-helpers', () => {
  describe('extractSchemaPaths', () => {
    it('should extract paths from a flat object', () => {
      const schema = Type.Object({
        name: Type.String(),
        age: Type.Number(),
      });
      const paths = extractSchemaPaths(schema);
      expect(paths).toContain('name');
      expect(paths).toContain('age');
    });

    it('should extract nested paths', () => {
      const schema = Type.Object({
        user: Type.Object({
          name: Type.String(),
          email: Type.String(),
        }),
      });
      const paths = extractSchemaPaths(schema);
      expect(paths).toContain('user');
      expect(paths).toContain('user.name');
      expect(paths).toContain('user.email');
    });

    it('should handle nullable fields via anyOf', () => {
      const schema = Type.Object({
        title: Type.Union([Type.String(), Type.Null()]),
      });
      const paths = extractSchemaPaths(schema);
      expect(paths).toContain('title');
    });

    it('should return empty array for empty object', () => {
      const schema = Type.Object({});
      const paths = extractSchemaPaths(schema);
      expect(paths).toEqual([]);
    });

    it('should include array fields as leaf paths', () => {
      const schema = Type.Object({
        tags: Type.Array(Type.String()),
      });
      const paths = extractSchemaPaths(schema);
      expect(paths).toContain('tags');
    });
  });

  describe('extractSchemaFields', () => {
    describe('basic field extraction', () => {
      it('should extract fields with types from a flat object', () => {
        const schema = Type.Object({
          name: Type.String(),
          count: Type.Number(),
          active: Type.Boolean(),
        });

        const fields = extractSchemaFields(schema);

        expect(fields).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ path: 'name', type: 'string' }),
            expect.objectContaining({ path: 'count', type: 'number' }),
            expect.objectContaining({ path: 'active', type: 'boolean' }),
          ]),
        );
      });

      it('should extract nested object fields', () => {
        const schema = Type.Object({
          address: Type.Object({
            city: Type.String(),
            zip: Type.Number(),
          }),
        });

        const fields = extractSchemaFields(schema);

        expect(fields).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ path: 'address', type: 'object' }),
            expect.objectContaining({ path: 'address.city', type: 'string' }),
            expect.objectContaining({ path: 'address.zip', type: 'number' }),
          ]),
        );
      });

      it('should resolve nullable union types to the non-null type', () => {
        const schema = Type.Object({
          title: Type.Union([Type.String(), Type.Null()]),
        });

        const fields = extractSchemaFields(schema);
        const titleField = fields.find((f) => f.path === 'title');

        expect(titleField).toBeDefined();
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        expect(titleField!.type).toBe('string');
      });

      it('should extract array fields', () => {
        const schema = Type.Object({
          items: Type.Array(Type.String()),
        });

        const fields = extractSchemaFields(schema);
        const itemsField = fields.find((f) => f.path === 'items');

        expect(itemsField).toBeDefined();
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        expect(itemsField!.type).toBe('array');
      });

      it('should return empty array for empty object schema', () => {
        const schema = Type.Object({});
        const fields = extractSchemaFields(schema);
        expect(fields).toEqual([]);
      });
    });

    describe('metadata extraction', () => {
      it('should extract description', () => {
        const schema = Type.Object({
          name: Type.String({ description: 'The user name' }),
        });

        const fields = extractSchemaFields(schema);
        const nameField = fields.find((f) => f.path === 'name');

        expect(nameField?.description).toBe('The user name');
      });

      it('should extract the string format annotation, unwrapping a nullable union', () => {
        const schema = Type.Object({
          // Webflow/Shopify/HubSpot put `format` on the inner String of a nullable union.
          publishedAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
          // No connector annotates the union wrapper itself today, but tolerate it anyway.
          closeDate: Type.Union([Type.String(), Type.Null()], { format: 'date-time' }),
          birthday: Type.String({ format: 'date' }),
          plain: Type.String(),
        });

        const fields = extractSchemaFields(schema);
        expect(fields.find((f) => f.path === 'publishedAt')?.format).toBe('date-time');
        expect(fields.find((f) => f.path === 'closeDate')?.format).toBe('date-time');
        expect(fields.find((f) => f.path === 'birthday')?.format).toBe('date');
        expect(fields.find((f) => f.path === 'plain')?.format).toBeUndefined();
      });

      it('should extract remoteFieldId', () => {
        const schema = Type.Object({
          title: Type.String({ [X_SCRATCH_REMOTE_FIELD_ID]: 'fld123abc' }),
        });

        const fields = extractSchemaFields(schema);
        const titleField = fields.find((f) => f.path === 'title');

        expect(titleField?.remoteFieldId).toBe('fld123abc');
      });

      it('should extract readonly flag', () => {
        const schema = Type.Object({
          id: Type.String({ [X_SCRATCH_READONLY]: true }),
          name: Type.String(),
        });

        const fields = extractSchemaFields(schema);
        const idField = fields.find((f) => f.path === 'id');
        const nameField = fields.find((f) => f.path === 'name');

        expect(idField?.readonly).toBe(true);
        expect(nameField?.readonly).toBeUndefined();
      });

      it('should extract foreignKey options', () => {
        const schema = Type.Object({
          authorId: Type.String({ [X_SCRATCH_FOREIGN_KEY_OPTIONS]: { linkedTableId: 'table_authors' } }),
        });

        const fields = extractSchemaFields(schema);
        const fkField = fields.find((f) => f.path === 'authorId');

        expect(fkField?.foreignKey).toEqual({ linkedTableId: 'table_authors' });
      });

      it('should carry targetKeyPath through the foreignKey whitelist copy (DEV-11085)', () => {
        // The copy is a whitelist, so an option missing from it is silently dropped and the FK
        // resolver never learns the value names its target by something other than the id.
        const schema = Type.Object({
          tag: Type.String({
            [X_SCRATCH_FOREIGN_KEY_OPTIONS]: { linkedTableId: 'col_tags', targetKeyPath: 'slug' },
          }),
        });

        const fkField = extractSchemaFields(schema).find((f) => f.path === 'tag');

        expect(fkField?.foreignKey).toEqual({ linkedTableId: 'col_tags', targetKeyPath: 'slug' });
      });

      it('should extract suggestedTransformer', () => {
        const transformer = { type: TransformerTypes.Slugify };
        const schema = Type.Object({
          slug: Type.String({ [X_SCRATCH_SUGGESTED_TRANSFORMER]: transformer }),
        });

        const fields = extractSchemaFields(schema);
        const slugField = fields.find((f) => f.path === 'slug');

        expect(slugField?.suggestedTransformer).toEqual(transformer);
      });

      it('should extract all metadata together', () => {
        const transformer = { type: TransformerTypes.AutoConvert, options: { targetType: 'string' } };
        const schema = Type.Object({
          field: Type.String({
            description: 'A field',
            [X_SCRATCH_REMOTE_FIELD_ID]: 'remote_1',
            [X_SCRATCH_SUGGESTED_TRANSFORMER]: transformer,
            [X_SCRATCH_READONLY]: true,
            [X_SCRATCH_FOREIGN_KEY_OPTIONS]: { linkedTableId: 'tbl_1' },
          }),
        });

        const fields = extractSchemaFields(schema);
        const field = fields.find((f) => f.path === 'field');

        expect(field).toEqual({
          path: 'field',
          type: 'string',
          description: 'A field',
          remoteFieldId: 'remote_1',
          suggestedTransformer: transformer,
          readonly: true,
          foreignKey: { linkedTableId: 'tbl_1' },
        });
      });
    });

    // DEV-11288: read so a view that opts a column into `'select'` gets the destination's native
    // select with the schema's real choices. Purely additive — nothing changes for an open string.
    describe('declared string option sets (enumValues)', () => {
      const fieldAt = (fields: SchemaField[], path: string): SchemaField => {
        const found = fields.find((f) => f.path === path);
        if (!found) throw new Error(`No extracted field at path "${path}"`);
        return found;
      };

      it('should read a union of string literals (how TypeBox serializes a literal union)', () => {
        const schema = Type.Object({
          state: Type.Union([Type.Literal('published'), Type.Literal('draft')]),
        });
        expect(fieldAt(extractSchemaFields(schema), 'state').enumValues).toEqual(['published', 'draft']);
      });

      it('should read a plain JSON-Schema enum', () => {
        const schema = Type.Object({ state: Type.Unsafe<string>({ type: 'string', enum: ['open', 'closed'] }) });
        expect(fieldAt(extractSchemaFields(schema), 'state').enumValues).toEqual(['open', 'closed']);
      });

      it('should see through a nullable wrapper', () => {
        const schema = Type.Object({
          state: Type.Union([Type.Union([Type.Literal('open'), Type.Literal('closed')]), Type.Null()]),
        });
        expect(fieldAt(extractSchemaFields(schema), 'state').enumValues).toEqual(['open', 'closed']);
      });

      it('should leave an open string alone', () => {
        const schema = Type.Object({ title: Type.String(), nullableTitle: Type.Union([Type.String(), Type.Null()]) });
        const fields = extractSchemaFields(schema);
        expect(fieldAt(fields, 'title').enumValues).toBeUndefined();
        expect(fieldAt(fields, 'nullableTitle').enumValues).toBeUndefined();
      });

      // Half an option set is worse than none: a union mixing literals with a free string or a
      // number has no closed set, and a destination select built from part of it would reject the
      // rest of the values.
      it('should refuse a union that mixes literals with anything else', () => {
        const schema = Type.Object({
          mixedWithString: Type.Union([Type.Literal('a'), Type.String()]),
          mixedWithNumber: Type.Union([Type.Literal('a'), Type.Number()]),
        });
        const fields = extractSchemaFields(schema);
        expect(fieldAt(fields, 'mixedWithString').enumValues).toBeUndefined();
        expect(fieldAt(fields, 'mixedWithNumber').enumValues).toBeUndefined();
      });
    });

    describe('virtual fields', () => {
      it('should apply virtual field displayLabel, type, and suggestedTransformer', () => {
        const virtualTransformer = {
          type: TransformerTypes.JSONPath,
          options: { expression: '$.title[*].plain_text', arrayHandling: 'concat' as const },
        };

        const schema = Type.Object({
          title: Type.Array(
            Type.Object({
              plain_text: Type.String(),
            }),
            {
              description: 'Page Title',
              [X_SCRATCH_VIRTUAL_FIELDS]: [
                {
                  displayLabel: 'Page Title',
                  type: 'string',
                  suggestedTransformer: virtualTransformer,
                },
              ],
            },
          ),
        });

        const fields = extractSchemaFields(schema);
        const titleField = fields.find((f) => f.path === 'title');

        expect(titleField).toBeDefined();
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        expect(titleField!.displayLabel).toBe('Page Title');
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        expect(titleField!.type).toBe('string');
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        expect(titleField!.suggestedTransformer).toEqual(virtualTransformer);
      });

      it('should override the original type with the virtual field type', () => {
        const schema = Type.Object({
          data: Type.Array(Type.Object({ value: Type.String() }), {
            [X_SCRATCH_VIRTUAL_FIELDS]: [
              {
                displayLabel: 'Data Value',
                type: 'string',
                suggestedTransformer: {
                  type: TransformerTypes.JSONPath,
                  options: { expression: '$.data[*].value', arrayHandling: 'first' as const },
                },
              },
            ],
          }),
        });

        const fields = extractSchemaFields(schema);
        const dataField = fields.find((f) => f.path === 'data');

        // The original type was 'array' but virtual field overrides it to 'string'
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        expect(dataField!.type).toBe('string');
      });

      it('should preserve description from the original schema when virtual field is present', () => {
        const schema = Type.Object({
          title: Type.Array(Type.String(), {
            description: 'Original description',
            [X_SCRATCH_VIRTUAL_FIELDS]: [
              {
                displayLabel: 'Title',
                type: 'string',
                suggestedTransformer: {
                  type: TransformerTypes.JSONPath,
                  options: { expression: '$.title[*]', arrayHandling: 'concat' as const },
                },
              },
            ],
          }),
        });

        const fields = extractSchemaFields(schema);
        const titleField = fields.find((f) => f.path === 'title');

        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        expect(titleField!.description).toBe('Original description');
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        expect(titleField!.displayLabel).toBe('Title');
      });

      it('should override suggestedTransformer from schema with virtual field transformer', () => {
        const originalTransformer = { type: TransformerTypes.Slugify };
        const virtualTransformer = {
          type: TransformerTypes.JSONPath,
          options: { expression: '$.items[0]', arrayHandling: 'first' as const },
        };

        const schema = Type.Object({
          field: Type.Array(Type.String(), {
            [X_SCRATCH_SUGGESTED_TRANSFORMER]: originalTransformer,
            [X_SCRATCH_VIRTUAL_FIELDS]: [
              {
                displayLabel: 'Field',
                type: 'string',
                suggestedTransformer: virtualTransformer,
              },
            ],
          }),
        });

        const fields = extractSchemaFields(schema);
        const field = fields.find((f) => f.path === 'field');

        // Virtual field transformer should win
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        expect(field!.suggestedTransformer).toEqual(virtualTransformer);
      });

      it('should not add displayLabel when no virtual fields are present', () => {
        const schema = Type.Object({
          name: Type.String(),
        });

        const fields = extractSchemaFields(schema);
        const nameField = fields.find((f) => f.path === 'name');

        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        expect(nameField!.displayLabel).toBeUndefined();
      });

      it('should handle empty virtual fields array', () => {
        const schema = Type.Object({
          name: Type.String({ [X_SCRATCH_VIRTUAL_FIELDS]: [] }),
        });

        const fields = extractSchemaFields(schema);
        const nameField = fields.find((f) => f.path === 'name');

        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        expect(nameField!.type).toBe('string');
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        expect(nameField!.displayLabel).toBeUndefined();
      });

      it('should use the first virtual field when multiple are defined', () => {
        const schema = Type.Object({
          field: Type.Array(Type.String(), {
            [X_SCRATCH_VIRTUAL_FIELDS]: [
              {
                displayLabel: 'First',
                type: 'string',
                suggestedTransformer: {
                  type: TransformerTypes.JSONPath,
                  options: { expression: '$.field[0]', arrayHandling: 'first' as const },
                },
              },
              {
                displayLabel: 'Second',
                type: 'number',
                suggestedTransformer: {
                  type: TransformerTypes.JSONPath,
                  options: { expression: '$.field[1]', arrayHandling: 'first' as const },
                },
              },
            ],
          }),
        });

        const fields = extractSchemaFields(schema);
        const field = fields.find((f) => f.path === 'field');

        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        expect(field!.displayLabel).toBe('First');
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        expect(field!.type).toBe('string');
      });
    });

    // D4: an object that carries x-scratch metadata (a Notion property envelope
    // `{ id, type, <typeKey>: value }`) is a single leaf — extractSchemaFields
    // must NOT recurse into its id/type/value sub-properties. Plain wrappers that
    // carry no x-scratch metadata (HubSpot `properties`, Airtable `fields`) must
    // still expand. Mirrors the desktop build-column-definitions guard.
    describe('x-scratch envelope leaf guard (D4)', () => {
      /** A Notion-style email property envelope tagged with connector metadata. */
      function emailEnvelope(): TSchema {
        const envelope = Type.Object({
          id: Type.String(),
          type: Type.Literal('email'),
          email: Type.Union([Type.String(), Type.Null()]),
        });
        annotate(envelope, X_SCRATCH_CONNECTOR_DATA_TYPE, 'email');
        annotate(envelope, X_SCRATCH_REMOTE_FIELD_ID, 'e1');
        return envelope;
      }

      it('yields exactly ONE field for an enveloped property, not its sub-fields', () => {
        const schema = Type.Object({ properties: Type.Object({ Email: emailEnvelope() }) });

        const fields = extractSchemaFields(schema);
        const paths = fields.map((f) => f.path);

        expect(paths).toContain('properties.Email');
        expect(paths).not.toContain('properties.Email.id');
        expect(paths).not.toContain('properties.Email.type');
        expect(paths).not.toContain('properties.Email.email');

        const emailField = fields.find((f) => f.path === 'properties.Email');
        expect(emailField?.remoteFieldId).toBe('e1');
      });

      it('applies the envelope virtual field as the single leaf type (title → string)', () => {
        const titleEnvelope = Type.Object({
          id: Type.String(),
          type: Type.Literal('title'),
          title: Type.Array(Type.Object({ plain_text: Type.String() })),
        });
        annotate(titleEnvelope, X_SCRATCH_CONNECTOR_DATA_TYPE, 'title');
        annotate(titleEnvelope, X_SCRATCH_VIRTUAL_FIELDS, [
          {
            displayLabel: 'Name',
            type: 'string',
            suggestedTransformer: {
              type: TransformerTypes.JSONPath,
              options: { expression: '$.title[*].plain_text', arrayHandling: 'concat' as const },
            },
          },
        ]);

        const schema = Type.Object({ properties: Type.Object({ Name: titleEnvelope }) });
        const fields = extractSchemaFields(schema);
        const nameField = fields.find((f) => f.path === 'properties.Name');

        expect(nameField?.type).toBe('string');
        expect(nameField?.displayLabel).toBe('Name');
        expect(fields.map((f) => f.path)).not.toContain('properties.Name.title');
      });

      it('keeps the relation FK field path at properties.<rel> (not properties.<rel>.relation)', () => {
        const relationEnvelope = Type.Object({
          id: Type.String(),
          type: Type.Literal('relation'),
          relation: Type.Array(Type.Object({ id: Type.String() })),
          has_more: Type.Optional(Type.Boolean()),
        });
        annotate(relationEnvelope, X_SCRATCH_CONNECTOR_DATA_TYPE, 'relation');
        annotate(relationEnvelope, X_SCRATCH_FOREIGN_KEY_OPTIONS, { linkedTableId: 'db_linked', map: 'id' });

        const schema = Type.Object({ properties: Type.Object({ Linked: relationEnvelope }) });
        const fields = extractSchemaFields(schema);

        const linked = fields.find((f) => f.path === 'properties.Linked');
        expect(linked?.foreignKey).toEqual({ linkedTableId: 'db_linked' });
        expect(fields.map((f) => f.path)).not.toContain('properties.Linked.relation');
      });

      it('still expands a HubSpot-style `properties` wrapper (no x-scratch on the wrapper)', () => {
        const schema = Type.Object({
          properties: Type.Object({
            firstname: Type.String({ [X_SCRATCH_REMOTE_FIELD_ID]: 'firstname' }),
            lastname: Type.String(),
          }),
        });

        const paths = extractSchemaFields(schema).map((f) => f.path);
        expect(paths).toContain('properties.firstname');
        expect(paths).toContain('properties.lastname');
      });

      it('still expands an Airtable-style `fields` wrapper (no x-scratch on the wrapper)', () => {
        const schema = Type.Object({
          fields: Type.Object({
            Name: Type.String(),
            Count: Type.Number(),
          }),
        });

        const paths = extractSchemaFields(schema).map((f) => f.path);
        expect(paths).toContain('fields.Name');
        expect(paths).toContain('fields.Count');
      });

      it('still expands the REAL Airtable `fields` wrapper carrying x-scratch-airtable-field-order', () => {
        // Regression: the live Airtable schema annotates the `fields` container with the
        // field-order key. That is container metadata, not a value envelope — the guard must
        // still recurse, or created columns can't be resolved for new Airtable tables.
        const fieldsWrapper = Type.Object({ Name: Type.String(), Slug: Type.String() });
        annotate(fieldsWrapper, X_SCRATCH_AIRTABLE_FIELD_ORDER, ['Name', 'Slug']);
        const schema = Type.Object({ id: Type.String(), fields: fieldsWrapper });

        const paths = extractSchemaFields(schema).map((f) => f.path);
        expect(paths).toContain('fields.Name');
        expect(paths).toContain('fields.Slug');
      });

      it('still expands an asset-table root carrying x-scratch-asset-table', () => {
        const schema = Type.Object({ hostedUrl: Type.String(), originalFileName: Type.String() });
        annotate(schema, X_SCRATCH_ASSET_TABLE, { urlPath: 'hostedUrl', filenamePath: 'originalFileName' });

        const paths = extractSchemaFields(schema).map((f) => f.path);
        expect(paths).toContain('hostedUrl');
        expect(paths).toContain('originalFileName');
      });
    });
  });

  describe('findCreatedDestinationField', () => {
    /**
     * Build the flattened fields of a live Airtable record schema — top-level
     * `id`/`fields`/`createdTime` meta (no remote field id) alongside the real
     * writable columns at `fields.<name>` (each carrying a remote field id).
     */
    function airtableRecordFields(userColumns: { name: string; fieldId: string; readonly?: boolean }[]): TSchema {
      const fieldProperties: Record<string, TSchema> = {};
      for (const column of userColumns) {
        const columnSchema = Type.String();
        annotate(columnSchema, X_SCRATCH_REMOTE_FIELD_ID, column.fieldId);
        if (column.readonly) annotate(columnSchema, X_SCRATCH_READONLY, true);
        fieldProperties[column.name] = columnSchema;
      }
      const fieldsWrapper = Type.Object(fieldProperties);
      annotate(
        fieldsWrapper,
        X_SCRATCH_AIRTABLE_FIELD_ORDER,
        userColumns.map((c) => c.name),
      );
      return Type.Object({ id: Type.String(), fields: fieldsWrapper, createdTime: Type.String() });
    }

    it('binds a created field named `id` to the writable `fields.id` column, not top-level record meta', () => {
      const fields = extractSchemaFields(airtableRecordFields([{ name: 'id', fieldId: 'fldUserId' }]));

      const match = findCreatedDestinationField(fields, { fieldName: 'id' });

      expect(match?.path).toBe('fields.id');
    });

    it('binds a created field named `fields` to `fields.fields`, not the top-level `fields` wrapper', () => {
      const fields = extractSchemaFields(airtableRecordFields([{ name: 'fields', fieldId: 'fldUserFields' }]));

      const match = findCreatedDestinationField(fields, { fieldName: 'fields' });

      expect(match?.path).toBe('fields.fields');
    });

    it('prefers an exact remote-field-id match over a leaf-name match (field addition)', () => {
      const fields = extractSchemaFields(airtableRecordFields([{ name: 'id', fieldId: 'fldUserId' }]));

      const match = findCreatedDestinationField(fields, { fieldName: 'id', remoteFieldId: 'fldUserId' });

      expect(match?.path).toBe('fields.id');
      expect(match?.remoteFieldId).toBe('fldUserId');
    });

    it('resolves a non-colliding created column by its leaf name', () => {
      const fields = extractSchemaFields(airtableRecordFields([{ name: 'Name', fieldId: 'fldName' }]));

      const match = findCreatedDestinationField(fields, { fieldName: 'Name' });

      expect(match?.path).toBe('fields.Name');
    });

    it('matches by display label when no path leaf matches', () => {
      const fields: SchemaField[] = [{ path: 'fields.fld123', type: 'string', displayLabel: 'Category' }];

      const match = findCreatedDestinationField(fields, { fieldName: 'Category' });

      expect(match?.path).toBe('fields.fld123');
    });

    it('returns undefined when nothing matches', () => {
      const fields = extractSchemaFields(airtableRecordFields([{ name: 'Name', fieldId: 'fldName' }]));

      expect(findCreatedDestinationField(fields, { fieldName: 'Missing' })).toBeUndefined();
    });

    it('falls back to a column whose REMOTE FIELD ID is the created name (slug-keyed grid destinations)', () => {
      // Google Sheets keys its schema by a derived slug ('customer_name') while the
      // column's x-scratch-remote-field-id is the verbatim header — exactly the
      // name the field was created with.
      const fields: SchemaField[] = [
        { path: 'scratch_id', type: 'string', readonly: true },
        { path: 'customer_name', type: 'string', remoteFieldId: 'Customer Name' },
      ];

      const match = findCreatedDestinationField(fields, { fieldName: 'Customer Name' });

      expect(match?.path).toBe('customer_name');
    });

    it('the remote-field-id-as-name fallback never overrides a name/label match', () => {
      const fields: SchemaField[] = [
        { path: 'Customer Name', type: 'string' }, // a real path match…
        { path: 'other', type: 'string', remoteFieldId: 'Customer Name' }, // …beats a remote-id-as-name match
      ];

      const match = findCreatedDestinationField(fields, { fieldName: 'Customer Name' });

      expect(match?.path).toBe('Customer Name');
    });

    it('resolves an Airtable `fields.<name>` column whose name contains a dot (DEV-10815)', () => {
      const fields = extractSchemaFields(airtableRecordFields([{ name: 'No. of Employees', fieldId: 'fldCount' }]));

      const match = findCreatedDestinationField(fields, { fieldName: 'No. of Employees' });

      expect(match?.path).toBe('fields.No. of Employees');
    });

    it('resolves a flat (Supabase-style) top-level column whose name contains a dot (DEV-10815)', () => {
      const fields = extractSchemaFields(Type.Object({ 'Est. Close Date': Type.String() }));

      const match = findCreatedDestinationField(fields, { fieldName: 'Est. Close Date' });

      expect(match?.path).toBe('Est. Close Date');
    });
  });
});
