import { FieldTransformHints, pickMappingTransformers, TransformerConfig } from '@spinner/shared-types';

const unpack: TransformerConfig = { type: 'jsonpath', options: { expression: '$.rich_text[*].plain_text' } };
const pack: TransformerConfig = {
  type: 'wrap_object',
  options: { template: { type: 'rich_text', rich_text: '$value' } },
};

const field = (hints: Partial<FieldTransformHints>): FieldTransformHints => ({ type: 'string', ...hints });

describe('pickMappingTransformers', () => {
  it('returns nothing when both fields are absent', () => {
    expect(pickMappingTransformers(undefined, undefined)).toEqual([]);
  });

  it('composes source unpack then destination pack', () => {
    expect(
      pickMappingTransformers(field({ suggestedTransformer: unpack }), field({ suggestedInTransformer: pack })),
    ).toEqual([unpack, pack]);
  });

  it('applies only the source unpack when the destination has no pack hint (Notion → Airtable)', () => {
    expect(pickMappingTransformers(field({ type: 'object', suggestedTransformer: unpack }), field({}))).toEqual([
      unpack,
    ]);
  });

  it('applies only the destination pack when the source has no unpack hint (Airtable → Notion)', () => {
    expect(pickMappingTransformers(field({}), field({ type: 'object', suggestedInTransformer: pack }))).toEqual([pack]);
  });

  it('returns nothing for a hint-free same-type mapping', () => {
    expect(pickMappingTransformers(field({ type: 'string' }), field({ type: 'string' }))).toEqual([]);
  });

  it('falls back to auto_convert for a hint-free primitive type mismatch', () => {
    expect(pickMappingTransformers(field({ type: 'string' }), field({ type: 'number' }))).toEqual([
      { type: 'auto_convert', options: { targetType: 'number' } },
    ]);
  });

  it('does NOT auto_convert into a non-primitive (object) destination — that needs a connector pack hint', () => {
    expect(pickMappingTransformers(field({ type: 'string' }), field({ type: 'object' }))).toEqual([]);
  });
});
