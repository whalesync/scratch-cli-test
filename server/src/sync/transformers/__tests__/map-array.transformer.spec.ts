import { MapArrayOptions } from '@spinner/shared-types';
import { Service } from 'src/remote-service/connectors/service-constants';
import { mapArrayTransformer } from '../implementations/map-array.transformer';
import '../implementations/wrap-object.transformer';
import { createNullLookupTools } from '../lookup-tools';
import { SyncRecord, TransformContext } from '../transformer.types';

function createContext(sourceValue: unknown, options?: MapArrayOptions): TransformContext {
  const sourceRecord: SyncRecord = { id: 'test', filePath: '/test', fields: { value: sourceValue } };
  return {
    sourceRecord,
    sourceFieldPath: 'value',
    sourceValue,
    sourceTableSpec: null,
    sourceService: Service.AIRTABLE,
    destinationFieldPath: 'value',
    destinationTableSpec: null,
    destinationService: Service.WEBFLOW,
    lookupTools: createNullLookupTools(),
    options: options ?? {},
    phase: 'DATA',
  };
}

describe('mapArrayTransformer', () => {
  it('should have correct type', () => {
    expect(mapArrayTransformer.type).toBe('map_array');
  });

  it('should apply wrap_object to each element', async () => {
    const result = await mapArrayTransformer.transform(
      createContext(['Tag 1', 'Tag 2', 'Tag 3'], {
        elementTransformer: {
          type: 'wrap_object',
          options: { template: { name: '$value' } },
        },
      }),
    );
    expect(result).toEqual({
      success: true,
      value: [{ name: 'Tag 1' }, { name: 'Tag 2' }, { name: 'Tag 3' }],
    });
  });

  it('should handle empty arrays', async () => {
    const result = await mapArrayTransformer.transform(
      createContext([], {
        elementTransformer: {
          type: 'wrap_object',
          options: { template: { name: '$value' } },
        },
      }),
    );
    expect(result).toEqual({ success: true, value: [] });
  });

  it('should return null for null input', async () => {
    const result = await mapArrayTransformer.transform(
      createContext(null, {
        elementTransformer: {
          type: 'wrap_object',
          options: { template: { name: '$value' } },
        },
      }),
    );
    expect(result).toEqual({ success: true, value: null });
  });

  it('should error on non-array input', async () => {
    const result = await mapArrayTransformer.transform(
      createContext('not an array', {
        elementTransformer: {
          type: 'wrap_object',
          options: { template: { name: '$value' } },
        },
      }),
    );
    expect(result).toEqual({ success: false, error: 'map_array expects an array as input' });
  });

  it('should error when elementTransformer is missing', async () => {
    const result = await mapArrayTransformer.transform(createContext(['a', 'b']));
    expect(result).toEqual({ success: false, error: 'map_array requires an "elementTransformer" option' });
  });

  describe('resultTemplate (envelope after the element mapping)', () => {
    const notionRelationPackOptions: MapArrayOptions = {
      elementTransformer: { type: 'wrap_object', options: { template: { id: '$value' } } },
      resultTemplate: { type: 'relation', relation: '$value' },
    };

    it('wraps the mapped array into the envelope (Notion relation pack)', async () => {
      const result = await mapArrayTransformer.transform(createContext(['id1', 'id2'], notionRelationPackOptions));
      expect(result).toEqual({
        success: true,
        value: { type: 'relation', relation: [{ id: 'id1' }, { id: 'id2' }] },
      });
    });

    it('wraps an EMPTY array for null input — the cleared shape, not a dropped field', async () => {
      const result = await mapArrayTransformer.transform(createContext(null, notionRelationPackOptions));
      expect(result).toEqual({ success: true, value: { type: 'relation', relation: [] } });
    });

    it('wraps an empty input array into the cleared shape', async () => {
      const result = await mapArrayTransformer.transform(createContext([], notionRelationPackOptions));
      expect(result).toEqual({ success: true, value: { type: 'relation', relation: [] } });
    });
  });

  it('should propagate errors from the inner transformer', async () => {
    const result = await mapArrayTransformer.transform(
      createContext(['a', 'b'], {
        elementTransformer: {
          type: 'wrap_object',
          // Missing template — will cause an error
          options: {} as never,
        },
      }),
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('element 0');
    }
  });
});
