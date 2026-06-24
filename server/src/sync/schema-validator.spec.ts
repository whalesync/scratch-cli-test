import { Type } from '@sinclair/typebox';
import { ColumnMapping, ColumnMappingV2 } from '@spinner/shared-types';
import { findConstantTypeMismatches, isTypeCompatible, validateSchemaMapping } from './schema-validator';

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

  it('flags string -> object when no transformer bridges it (the CRM-Bridge-into-Notion failure)', () => {
    const columnMappings: ColumnMapping[] = [{ sourceColumnId: 'name', destinationColumnId: 'meta' }];
    const errors = validateSchemaMapping(sourceSchema, destSchema, columnMappings);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("Source type 'string' cannot be mapped to Destination type 'object'");
  });

  it('skips the raw type check when a transformer is present (it bridges the mismatch)', () => {
    const withPipeline: ColumnMapping[] = [
      {
        sourceColumnId: 'name',
        destinationColumnId: 'meta',
        transformers: [{ type: 'wrap_object', options: { template: {} } }],
      },
    ];
    expect(validateSchemaMapping(sourceSchema, destSchema, withPipeline)).toHaveLength(0);

    const withSingle: ColumnMapping[] = [
      {
        sourceColumnId: 'name',
        destinationColumnId: 'meta',
        transformer: { type: 'wrap_object', options: { template: {} } },
      },
    ];
    expect(validateSchemaMapping(sourceSchema, destSchema, withSingle)).toHaveLength(0);
  });

  it('still flags a missing destination field even when a transformer is present', () => {
    const columnMappings: ColumnMapping[] = [
      {
        sourceColumnId: 'name',
        destinationColumnId: 'nope',
        transformers: [{ type: 'wrap_object', options: { template: {} } }],
      },
    ];
    const errors = validateSchemaMapping(sourceSchema, destSchema, columnMappings);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("Destination field 'nope' not found");
  });
});

describe('findConstantTypeMismatches', () => {
  const destSchema = Type.Object({
    title: Type.String(),
    amount: Type.Number(),
    count: Type.Integer(),
    archived: Type.Boolean(),
    payload: Type.Object({ inner: Type.String() }),
    nickname: Type.Union([Type.String(), Type.Null()]),
    anything: Type.Any(),
  });

  const constant = (destinationColumnId: string, value: string | number | boolean | null): ColumnMappingV2 => ({
    destinationColumnId,
    when: 'unmatched',
    source: { kind: 'constant', value },
  });

  it('accepts constants whose type matches the destination column', () => {
    const mappings: ColumnMappingV2[] = [
      constant('title', 'stale'),
      constant('amount', 42),
      constant('archived', true),
    ];
    expect(findConstantTypeMismatches(destSchema, mappings)).toEqual([]);
  });

  it('accepts a numeric constant for an integer column', () => {
    expect(findConstantTypeMismatches(destSchema, [constant('count', 7)])).toEqual([]);
  });

  it('flags a string constant written to a boolean column', () => {
    const mismatches = findConstantTypeMismatches(destSchema, [constant('archived', 'true')]);
    expect(mismatches).toEqual([{ destinationColumnId: 'archived', expected: 'boolean', got: 'string' }]);
  });

  it('flags a numeric constant written to a string column', () => {
    const mismatches = findConstantTypeMismatches(destSchema, [constant('title', 5)]);
    expect(mismatches).toEqual([{ destinationColumnId: 'title', expected: 'string', got: 'number' }]);
  });

  it('flags a primitive constant written to an object column', () => {
    const mismatches = findConstantTypeMismatches(destSchema, [constant('payload', 'oops')]);
    expect(mismatches).toEqual([{ destinationColumnId: 'payload', expected: 'object', got: 'string' }]);
  });

  it('allows a null constant on any column (clears the field)', () => {
    const mappings: ColumnMappingV2[] = [constant('archived', null), constant('amount', null)];
    expect(findConstantTypeMismatches(destSchema, mappings)).toEqual([]);
  });

  it('unwraps a nullable column type before comparing', () => {
    expect(findConstantTypeMismatches(destSchema, [constant('nickname', 'who')])).toEqual([]);
    expect(findConstantTypeMismatches(destSchema, [constant('nickname', 3)])).toEqual([
      { destinationColumnId: 'nickname', expected: 'string', got: 'number' },
    ]);
  });

  it('skips constants whose destination column is unknown or untyped', () => {
    const mappings: ColumnMappingV2[] = [
      constant('doesNotExist', 'x'), // column not in schema
      constant('anything', 5), // Type.Any() — no resolvable type
    ];
    expect(findConstantTypeMismatches(destSchema, mappings)).toEqual([]);
  });

  it('ignores column-source mappings (only constants are checked)', () => {
    const mappings: ColumnMappingV2[] = [
      { destinationColumnId: 'archived', source: { kind: 'column', columnId: 'someBool' } },
      constant('title', 5), // the only mismatch
    ];
    expect(findConstantTypeMismatches(destSchema, mappings)).toEqual([
      { destinationColumnId: 'title', expected: 'string', got: 'number' },
    ]);
  });

  it('returns one entry per mismatching constant', () => {
    const mappings: ColumnMappingV2[] = [constant('title', 5), constant('archived', 'nope')];
    expect(findConstantTypeMismatches(destSchema, mappings)).toHaveLength(2);
  });
});
