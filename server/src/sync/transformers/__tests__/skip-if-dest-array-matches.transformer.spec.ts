import { SkipIfDestArrayMatchesOptions } from '@spinner/shared-types';
import { Service } from 'src/remote-service/connectors/service-constants';
import { skipIfDestArrayMatchesTransformer } from '../implementations/skip-if-dest-array-matches.transformer';
import { createNullLookupTools } from '../lookup-tools';
import { SyncRecord, TransformContext } from '../transformer.types';

function createContext(
  sourceValue: unknown,
  destinationValue?: unknown,
  options?: SkipIfDestArrayMatchesOptions,
): TransformContext {
  const sourceRecord: SyncRecord = { id: 'test', filePath: '/test', fields: { value: sourceValue } };
  return {
    sourceRecord,
    sourceFieldPath: 'value',
    sourceValue,
    sourceTableSpec: null,
    sourceService: Service.AIRTABLE,
    destinationFieldPath: 'value',
    destinationValue,
    destinationTableSpec: null,
    destinationService: Service.WEBFLOW,
    lookupTools: createNullLookupTools(),
    options: options ?? {},
    phase: 'DATA',
  };
}

describe('skipIfDestArrayMatchesTransformer', () => {
  it('should have correct type', () => {
    expect(skipIfDestArrayMatchesTransformer.type).toBe('skip_if_dest_array_matches');
  });

  describe('default options (no JSONPath extraction)', () => {
    it('should skip when arrays are equal', async () => {
      const result = await skipIfDestArrayMatchesTransformer.transform(createContext(['a', 'b'], ['a', 'b']));
      expect(result).toEqual({ success: true, skip: true });
    });

    it('should skip when arrays have same elements in different order', async () => {
      const result = await skipIfDestArrayMatchesTransformer.transform(createContext(['b', 'a'], ['a', 'b']));
      expect(result).toEqual({ success: true, skip: true });
    });

    it('should pass through when arrays differ', async () => {
      const result = await skipIfDestArrayMatchesTransformer.transform(createContext(['a', 'b'], ['a', 'c']));
      expect(result).toEqual({ success: true, value: ['a', 'b'] });
    });

    it('should pass through when arrays have different lengths', async () => {
      const result = await skipIfDestArrayMatchesTransformer.transform(createContext(['a', 'b', 'c'], ['a', 'b']));
      expect(result).toEqual({ success: true, value: ['a', 'b', 'c'] });
    });

    it('should skip when both are empty arrays', async () => {
      const result = await skipIfDestArrayMatchesTransformer.transform(createContext([], []));
      expect(result).toEqual({ success: true, skip: true });
    });

    it('should skip when both are null', async () => {
      const result = await skipIfDestArrayMatchesTransformer.transform(createContext(null, null));
      expect(result).toEqual({ success: true, skip: true });
    });

    it('should pass through when source has value but dest is null', async () => {
      const result = await skipIfDestArrayMatchesTransformer.transform(createContext(['a'], null));
      expect(result).toEqual({ success: true, value: ['a'] });
    });
  });

  describe('with matchOrdering: true', () => {
    it('should skip when arrays are in same order', async () => {
      const result = await skipIfDestArrayMatchesTransformer.transform(
        createContext(['a', 'b'], ['a', 'b'], { matchOrdering: true }),
      );
      expect(result).toEqual({ success: true, skip: true });
    });

    it('should pass through when arrays have same elements in different order', async () => {
      const result = await skipIfDestArrayMatchesTransformer.transform(
        createContext(['b', 'a'], ['a', 'b'], { matchOrdering: true }),
      );
      expect(result).toEqual({ success: true, value: ['b', 'a'] });
    });
  });

  describe('Moco → Audienceful tag use case', () => {
    const mocoTags = ['Test Tag 1', 'Test Tag 2', 'Test Tag 3'];
    const audiencefulTags = [
      { id: 16354, name: 'Test Tag 1', color: 'blue' },
      { id: 16355, name: 'Test Tag 2', color: 'blue' },
      { id: 16356, name: 'Test Tag 3', color: 'blue' },
    ];

    it('should skip when source tags match destination tag names', async () => {
      const result = await skipIfDestArrayMatchesTransformer.transform(
        createContext(mocoTags, audiencefulTags, {
          destinationElementExpression: '$.name',
        }),
      );
      expect(result).toEqual({ success: true, skip: true });
    });

    it('should pass through when source tags differ from destination', async () => {
      const result = await skipIfDestArrayMatchesTransformer.transform(
        createContext(['New Tag'], audiencefulTags, {
          destinationElementExpression: '$.name',
        }),
      );
      expect(result).toEqual({ success: true, value: ['New Tag'] });
    });

    it('should pass through when a tag is added', async () => {
      const result = await skipIfDestArrayMatchesTransformer.transform(
        createContext([...mocoTags, 'New Tag'], audiencefulTags, {
          destinationElementExpression: '$.name',
        }),
      );
      expect(result).toEqual({ success: true, value: [...mocoTags, 'New Tag'] });
    });

    it('should pass through when a tag is removed', async () => {
      const result = await skipIfDestArrayMatchesTransformer.transform(
        createContext(['Test Tag 1'], audiencefulTags, {
          destinationElementExpression: '$.name',
        }),
      );
      expect(result).toEqual({ success: true, value: ['Test Tag 1'] });
    });
  });

  describe('with sourceElementExpression', () => {
    it('should extract from source elements before comparison', async () => {
      const source = [{ label: 'A' }, { label: 'B' }];
      const dest = ['A', 'B'];
      const result = await skipIfDestArrayMatchesTransformer.transform(
        createContext(source, dest, { sourceElementExpression: '$.label' }),
      );
      expect(result).toEqual({ success: true, skip: true });
    });
  });

  describe('with both expressions', () => {
    it('should extract from both sides before comparison', async () => {
      const source = [{ tag: 'X' }, { tag: 'Y' }];
      const dest = [
        { name: 'X', id: 1 },
        { name: 'Y', id: 2 },
      ];
      const result = await skipIfDestArrayMatchesTransformer.transform(
        createContext(source, dest, {
          sourceElementExpression: '$.tag',
          destinationElementExpression: '$.name',
        }),
      );
      expect(result).toEqual({ success: true, skip: true });
    });
  });
});
