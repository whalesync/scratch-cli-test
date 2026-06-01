import { Type } from '@sinclair/typebox';
import { TransformerTypes, type TransformerConfig } from '@spinner/shared-types';
import '../index';
import { validate } from '../type-validator';

describe('Type Validation Pipeline', () => {
  it('should return no warnings when types match exactly without transformers', () => {
    const sourceSchema = Type.Object({
      name: Type.String(),
    });
    const destSchema = Type.Object({
      title: Type.String(),
    });

    const mappings = [{ sourceColumnId: 'name', destinationColumnId: 'title' }];

    const result = validate(mappings, sourceSchema, destSchema);
    expect(result.isValid).toBe(true);
    expect(result.warnings).toHaveLength(0);
  });

  it('should return a warning when types do not match', () => {
    const sourceSchema = Type.Object({
      count: Type.Number(),
    });
    const destSchema = Type.Object({
      countStr: Type.String(),
    });

    const mappings = [{ sourceColumnId: 'count', destinationColumnId: 'countStr' }];

    const result = validate(mappings, sourceSchema, destSchema);
    expect(result.isValid).toBe(false);
    expect(result.warnings[0]).toContain(
      'Type mismatch for mapping count -> countStr. Expected type `string`, but pipeline resolved to `number`.',
    );
  });

  it('should predict correct output type when using EnsureType transformer', () => {
    const sourceSchema = Type.Object({
      // Source provides a union type. EnsureType guarantees a number or null.
      age: Type.Union([Type.Number(), Type.String()]),
    });
    const destSchema = Type.Object({
      ageNumber: Type.Number(),
    });

    const mappings = [
      {
        sourceColumnId: 'age',
        destinationColumnId: 'ageNumber',
        transformer: {
          type: TransformerTypes.EnsureType,
          options: {
            expectedType: 'number',
            onFailure: 'null',
          },
        } as unknown as TransformerConfig,
      },
    ];

    const result = validate(mappings, sourceSchema, destSchema);
    if (!result.isValid) {
      console.log('Warnings:', result.warnings);
    }
    expect(result.isValid).toBe(true);
    expect(result.warnings).toHaveLength(0);
  });

  it('should predict correct output type when using StringToNumber transformer', () => {
    const sourceSchema = Type.Object({
      price: Type.String(),
    });
    const destSchema = Type.Object({
      priceNumber: Type.Number(),
    });

    const mappings = [
      {
        sourceColumnId: 'price',
        destinationColumnId: 'priceNumber',
        transformer: {
          type: TransformerTypes.StringToNumber,
          options: {},
        },
      },
    ];

    const result = validate(mappings, sourceSchema, destSchema);
    expect(result.isValid).toBe(true);
    expect(result.warnings).toHaveLength(0);
  });

  it('should predict correct output type when using AutoConvert transformer', () => {
    const sourceSchema = Type.Object({
      count: Type.String(),
    });
    const destSchema = Type.Object({
      countNum: Type.Number(),
    });

    const mappings = [
      {
        sourceColumnId: 'count',
        destinationColumnId: 'countNum',
        transformer: {
          type: TransformerTypes.AutoConvert,
          options: { targetType: 'number' },
        } as unknown as TransformerConfig,
      },
    ];

    const result = validate(mappings, sourceSchema, destSchema);
    expect(result.isValid).toBe(true);
    expect(result.warnings).toHaveLength(0);
  });

  it('should predict correct output type when using WebflowOptionIdToValue transformer', () => {
    const sourceSchema = Type.Object({
      optionId: Type.String(),
    });
    const destSchema = Type.Object({
      optionLabel: Type.String(),
    });

    const mappings = [
      {
        sourceColumnId: 'optionId',
        destinationColumnId: 'optionLabel',
        transformer: {
          type: TransformerTypes.WebflowOptionIdToValue,
          options: {},
        },
      },
    ];

    const result = validate(mappings, sourceSchema, destSchema);
    expect(result.isValid).toBe(true);
    expect(result.warnings).toHaveLength(0);
  });
});
