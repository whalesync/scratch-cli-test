import { Type } from '@sinclair/typebox';
import { ColumnMapping } from '@spinner/shared-types';
import { isTypeCompatible, validateSchemaMapping } from './schema-validator';

describe('isTypeCompatible', () => {
  it('matches identical primitives', () => {
    expect(isTypeCompatible(Type.String(), Type.String())).toBe(true);
    expect(isTypeCompatible(Type.Number(), Type.Number())).toBe(true);
    expect(isTypeCompatible(Type.Boolean(), Type.Boolean())).toBe(true);
  });

  it('rejects mismatched primitives', () => {
    expect(isTypeCompatible(Type.String(), Type.Number())).toBe(false);
    expect(isTypeCompatible(Type.Number(), Type.Boolean())).toBe(false);
    expect(isTypeCompatible(Type.Boolean(), Type.String())).toBe(false);
  });

  it('matches object to object', () => {
    expect(isTypeCompatible(Type.Object({}), Type.Object({}))).toBe(true);
  });

  it('allows source type into anyOf dest that contains it', () => {
    expect(isTypeCompatible(Type.String(), Type.Union([Type.String(), Type.Null()]))).toBe(true);
    expect(isTypeCompatible(Type.Number(), Type.Union([Type.Number(), Type.String()]))).toBe(true);
  });

  it('rejects source type not in anyOf dest', () => {
    expect(isTypeCompatible(Type.Boolean(), Type.Union([Type.String(), Type.Null()]))).toBe(false);
  });

  it('handles Optional (which is anyOf with null) on dest', () => {
    expect(isTypeCompatible(Type.String(), Type.Optional(Type.String()))).toBe(true);
    expect(isTypeCompatible(Type.Number(), Type.Optional(Type.String()))).toBe(false);
  });
});

describe('validateSchemaMapping', () => {
  const sourceSchema = Type.Object({
    name: Type.String(),
    age: Type.Number(),
    isActive: Type.Boolean(),
    details: Type.Object({
      description: Type.String(),
      count: Type.Integer(),
    }),
    optionalField: Type.Optional(Type.String()),
    nullableField: Type.Union([Type.String(), Type.Null()]),
  });

  const destSchema = Type.Object({
    fullName: Type.String(),
    years: Type.Number(),
    status: Type.String(), // String!
    meta: Type.Object({
      info: Type.String(),
      qty: Type.Number(),
    }),
    maybeString: Type.Optional(Type.String()),
    justString: Type.String(),
  });

  it('should return no errors for compatible mappings', () => {
    const columnMappings: ColumnMapping[] = [
      { sourceColumnId: 'name', destinationColumnId: 'fullName' },
      { sourceColumnId: 'details.description', destinationColumnId: 'meta.info' },
    ];

    const errors = validateSchemaMapping(sourceSchema, destSchema, columnMappings);
    expect(errors).toHaveLength(0);
  });

  it('should detect mismatching types', () => {
    const columnMappings: ColumnMapping[] = [
      { sourceColumnId: 'name', destinationColumnId: 'years' }, // string -> number
      { sourceColumnId: 'isActive', destinationColumnId: 'status' }, // boolean -> string
    ];

    const errors = validateSchemaMapping(sourceSchema, destSchema, columnMappings);
    expect(errors).toHaveLength(2);
    expect(errors[0]).toContain("Source type 'string' cannot be mapped to Destination type 'number'");
    expect(errors[1]).toContain("Source type 'boolean' cannot be mapped to Destination type 'string'");
  });

  it('should handle missing fields', () => {
    const columnMappings: ColumnMapping[] = [
      { sourceColumnId: 'nonExistent', destinationColumnId: 'fullName' },
      { sourceColumnId: 'name', destinationColumnId: 'missingDest' },
    ];

    const errors = validateSchemaMapping(sourceSchema, destSchema, columnMappings);
    expect(errors).toHaveLength(2);
    expect(errors[0]).toContain("Source field 'nonExistent' not found");
    expect(errors[1]).toContain("Destination field 'missingDest' not found");
  });

  it('should handle optional and union unwrapping', () => {
    const columnMappings: ColumnMapping[] = [
      { sourceColumnId: 'optionalField', destinationColumnId: 'justString' },
      { sourceColumnId: 'nullableField', destinationColumnId: 'maybeString' },
    ];
    const errors = validateSchemaMapping(sourceSchema, destSchema, columnMappings);
    expect(errors).toHaveLength(0);
  });
});
