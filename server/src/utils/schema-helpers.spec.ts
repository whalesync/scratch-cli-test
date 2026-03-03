import { Type } from '@sinclair/typebox';
import { TransformerTypes } from '@spinner/shared-types';
import {
  FOREIGN_KEY_OPTIONS,
  READONLY_FLAG,
  REMOTE_FIELD_ID,
  SUGGESTED_TRANSFORMER,
  VIRTUAL_FIELDS,
} from '../remote-service/connectors/json-schema';
import { extractSchemaFields, extractSchemaPaths } from './schema-helpers';

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
        expect(titleField!.type).toBe('string');
      });

      it('should extract array fields', () => {
        const schema = Type.Object({
          items: Type.Array(Type.String()),
        });

        const fields = extractSchemaFields(schema);
        const itemsField = fields.find((f) => f.path === 'items');

        expect(itemsField).toBeDefined();
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

      it('should extract remoteFieldId', () => {
        const schema = Type.Object({
          title: Type.String({ [REMOTE_FIELD_ID]: 'fld123abc' }),
        });

        const fields = extractSchemaFields(schema);
        const titleField = fields.find((f) => f.path === 'title');

        expect(titleField?.remoteFieldId).toBe('fld123abc');
      });

      it('should extract readonly flag', () => {
        const schema = Type.Object({
          id: Type.String({ [READONLY_FLAG]: true }),
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
          authorId: Type.String({ [FOREIGN_KEY_OPTIONS]: { linkedTableId: 'table_authors' } }),
        });

        const fields = extractSchemaFields(schema);
        const fkField = fields.find((f) => f.path === 'authorId');

        expect(fkField?.foreignKey).toEqual({ linkedTableId: 'table_authors' });
      });

      it('should extract suggestedTransformer', () => {
        const transformer = { type: TransformerTypes.Slugify };
        const schema = Type.Object({
          slug: Type.String({ [SUGGESTED_TRANSFORMER]: transformer }),
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
            [REMOTE_FIELD_ID]: 'remote_1',
            [SUGGESTED_TRANSFORMER]: transformer,
            [READONLY_FLAG]: true,
            [FOREIGN_KEY_OPTIONS]: { linkedTableId: 'tbl_1' },
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
              [VIRTUAL_FIELDS]: [
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
        expect(titleField!.displayLabel).toBe('Page Title');
        expect(titleField!.type).toBe('string');
        expect(titleField!.suggestedTransformer).toEqual(virtualTransformer);
      });

      it('should override the original type with the virtual field type', () => {
        const schema = Type.Object({
          data: Type.Array(Type.Object({ value: Type.String() }), {
            [VIRTUAL_FIELDS]: [
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
        expect(dataField!.type).toBe('string');
      });

      it('should preserve description from the original schema when virtual field is present', () => {
        const schema = Type.Object({
          title: Type.Array(Type.String(), {
            description: 'Original description',
            [VIRTUAL_FIELDS]: [
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

        expect(titleField!.description).toBe('Original description');
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
            [SUGGESTED_TRANSFORMER]: originalTransformer,
            [VIRTUAL_FIELDS]: [
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
        expect(field!.suggestedTransformer).toEqual(virtualTransformer);
      });

      it('should not add displayLabel when no virtual fields are present', () => {
        const schema = Type.Object({
          name: Type.String(),
        });

        const fields = extractSchemaFields(schema);
        const nameField = fields.find((f) => f.path === 'name');

        expect(nameField!.displayLabel).toBeUndefined();
      });

      it('should handle empty virtual fields array', () => {
        const schema = Type.Object({
          name: Type.String({ [VIRTUAL_FIELDS]: [] }),
        });

        const fields = extractSchemaFields(schema);
        const nameField = fields.find((f) => f.path === 'name');

        expect(nameField!.type).toBe('string');
        expect(nameField!.displayLabel).toBeUndefined();
      });

      it('should use the first virtual field when multiple are defined', () => {
        const schema = Type.Object({
          field: Type.Array(Type.String(), {
            [VIRTUAL_FIELDS]: [
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

        expect(field!.displayLabel).toBe('First');
        expect(field!.type).toBe('string');
      });
    });
  });
});
