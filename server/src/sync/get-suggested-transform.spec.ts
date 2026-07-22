import {
  ClientSafeTransformer,
  ColumnTransformInput,
  getSuggestedTransform,
  TransformerConfig,
  TransformSuggestion,
} from '@spinner/shared-types';

const col = (input: Partial<ColumnTransformInput>): ColumnTransformInput => ({ cardinality: 'single', ...input });

const chainOf = (suggestion: TransformSuggestion): TransformerConfig[] => {
  if (suggestion.result !== 'valid') throw new Error(`expected valid, got invalid: ${suggestion.reason}`);
  // Exactly one option today; the array grows when we surface multiple user-pickable options.
  expect(suggestion.options).toHaveLength(1);
  return suggestion.options[0].transformerChain;
};

const richTextUnpack: ClientSafeTransformer = {
  type: 'jsonpath',
  options: { expression: '$.rich_text[*].plain_text' },
};
const richTextPack: ClientSafeTransformer = {
  type: 'wrap_object',
  options: { template: { type: 'rich_text', rich_text: '$value' } },
};

const takeFirst: TransformerConfig = { type: 'jsonpath', options: { expression: '$[*]', arrayHandling: 'first' } };
const wrapArray: TransformerConfig = { type: 'auto_convert', options: { targetType: 'array' } };
const autoConvert = (targetType: 'string' | 'number'): TransformerConfig => ({
  type: 'auto_convert',
  options: { targetType },
});

describe('getSuggestedTransform', () => {
  it('always returns a valid result with a non-empty options tuple', () => {
    const suggestion = getSuggestedTransform(col({}), col({}));
    expect(suggestion.result).toBe('valid');
    if (suggestion.result === 'valid') expect(suggestion.options.length).toBeGreaterThanOrEqual(1);
  });

  describe('same cardinality (no middle reshape)', () => {
    it('single→single with no codecs and same type is an empty (verbatim-copy) chain', () => {
      expect(
        chainOf(getSuggestedTransform(col({ primitiveType: 'string' }), col({ primitiveType: 'string' }))),
      ).toEqual([]);
    });

    it('single→single composes source toCore then destination fromCore', () => {
      expect(chainOf(getSuggestedTransform(col({ toCore: richTextUnpack }), col({ fromCore: richTextPack })))).toEqual([
        richTextUnpack,
        richTextPack,
      ]);
    });

    it('single→single falls back to the auto_convert floor on a primitive mismatch', () => {
      expect(
        chainOf(getSuggestedTransform(col({ primitiveType: 'string' }), col({ primitiveType: 'number' }))),
      ).toEqual([autoConvert('number')]);
    });

    it('multi→multi with matching element strings is an empty (verbatim-copy) chain', () => {
      expect(
        chainOf(
          getSuggestedTransform(
            col({ cardinality: 'multi', primitiveType: 'array' }),
            col({ cardinality: 'multi', primitiveType: 'array' }),
          ),
        ),
      ).toEqual([]);
    });
  });

  describe('multi → single collapse (type-aware)', () => {
    it('comma-joins (total, via auto_convert string) into a text-like target and skips the redundant floor', () => {
      expect(
        chainOf(
          getSuggestedTransform(
            col({ cardinality: 'multi', primitiveType: 'array' }),
            col({ cardinality: 'single', primitiveType: 'string', logicalType: 'string' }),
          ),
        ),
      ).toEqual([autoConvert('string')]);
    });

    it('comma-joins into an unknown-typed target (non-destructive default)', () => {
      expect(
        chainOf(
          getSuggestedTransform(col({ cardinality: 'multi', primitiveType: 'array' }), col({ cardinality: 'single' })),
        ),
      ).toEqual([autoConvert('string')]);
    });

    it('takes the first element into a strict target, then types it with the floor', () => {
      expect(
        chainOf(
          getSuggestedTransform(
            col({ cardinality: 'multi', primitiveType: 'array' }),
            col({ cardinality: 'single', primitiveType: 'number', logicalType: 'number' }),
          ),
        ),
      ).toEqual([takeFirst, autoConvert('number')]);
    });

    it('takes the first element into a strict single-select target, then floors it (element type unknown after first)', () => {
      expect(
        chainOf(
          getSuggestedTransform(
            col({ cardinality: 'multi', primitiveType: 'array' }),
            col({ cardinality: 'single', primitiveType: 'string', logicalType: 'single_select' }),
          ),
        ),
      ).toEqual([takeFirst, autoConvert('string')]);
    });
  });

  describe('single → multi wrap', () => {
    it('wraps the scalar into a one-element array and skips the redundant array floor', () => {
      expect(
        chainOf(
          getSuggestedTransform(
            col({ cardinality: 'single', primitiveType: 'string' }),
            col({ cardinality: 'multi', primitiveType: 'array' }),
          ),
        ),
      ).toEqual([wrapArray]);
    });

    it('runs source toCore before the wrap', () => {
      expect(
        chainOf(
          getSuggestedTransform(
            col({ cardinality: 'single', toCore: richTextUnpack }),
            col({ cardinality: 'multi', primitiveType: 'array' }),
          ),
        ),
      ).toEqual([richTextUnpack, wrapArray]);
    });
  });

  it('prefers an explicit destination fromCore over the coercion floor', () => {
    expect(
      chainOf(
        getSuggestedTransform(
          col({ primitiveType: 'string' }),
          col({ primitiveType: 'number', fromCore: richTextPack }),
        ),
      ),
    ).toEqual([richTextPack]);
  });

  it('does NOT coerce into a structured (non-primitive) destination — that needs a pack hint', () => {
    expect(chainOf(getSuggestedTransform(col({ primitiveType: 'string' }), col({ primitiveType: 'object' })))).toEqual(
      [],
    );
  });

  describe('non-scalar source → destination pack (DEV-10828)', () => {
    it('JSON-stringifies an object source into a CoreValue string before the fromCore pack', () => {
      // Shopify `featuredImage` (single object, no toCore) → a Notion rich_text column (wrap_object pack).
      // Without the coercion the raw object lands in the pack's string-only `content` slot and Notion rejects it.
      expect(
        chainOf(
          getSuggestedTransform(
            col({ primitiveType: 'object' }),
            col({ primitiveType: 'string', fromCore: richTextPack }),
          ),
        ),
      ).toEqual([autoConvert('string'), richTextPack]);
    });

    it('also stringifies a single-cardinality JSON-array source before the pack', () => {
      expect(
        chainOf(
          getSuggestedTransform(
            col({ cardinality: 'single', primitiveType: 'array' }),
            col({ primitiveType: 'string', fromCore: richTextPack }),
          ),
        ),
      ).toEqual([autoConvert('string'), richTextPack]);
    });

    it('does NOT stringify a scalar source into the pack (numbers/booleans reach a native pack as-is)', () => {
      expect(
        chainOf(
          getSuggestedTransform(
            col({ primitiveType: 'number' }),
            col({ primitiveType: 'number', fromCore: richTextPack }),
          ),
        ),
      ).toEqual([richTextPack]);
    });

    it('does NOT add the pre-pack coercion on the pack-less path (the coercion floor still handles it)', () => {
      // No destination fromCore → the existing floor coerces object→string exactly as before (single auto_convert).
      expect(
        chainOf(getSuggestedTransform(col({ primitiveType: 'object' }), col({ primitiveType: 'string' }))),
      ).toEqual([autoConvert('string')]);
    });

    it('leaves an object source with a toCore codec to that codec (no extra stringify)', () => {
      expect(
        chainOf(
          getSuggestedTransform(
            col({ primitiveType: 'object', toCore: richTextUnpack }),
            col({ fromCore: richTextPack }),
          ),
        ),
      ).toEqual([richTextUnpack, richTextPack]);
    });

    it('stringifies an UNKNOWN-typed source before the pack (nothing guarantees a CoreValue string)', () => {
      // Webflow's un-modeled e-commerce fields (`sku-properties`/`sku-values`, `Type.Unknown()` until
      // DEV-10937) resolve with NO primitiveType. Their runtime values are raw arrays/objects, so
      // without the stringify they land verbatim in Notion rich_text's string-only `content` slot and
      // every create fails (DEV-10875's validation_error → unresolvable-pseudo-ref cascade).
      expect(chainOf(getSuggestedTransform(col({}), col({ primitiveType: 'string', fromCore: richTextPack })))).toEqual(
        [autoConvert('string'), richTextPack],
      );
    });

    it('does NOT stringify an unknown-typed MULTI source before the pack (reshape handles the arm)', () => {
      const suggestion = getSuggestedTransform(
        col({ cardinality: 'multi' }),
        col({ cardinality: 'multi', fromCore: richTextPack }),
      );
      expect(chainOf(suggestion)).toEqual([richTextPack]);
    });
  });
});
