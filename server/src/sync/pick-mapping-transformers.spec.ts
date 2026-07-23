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

  it('coerces to the destination type even when the SOURCE field is unknown (a drilled/computed path)', () => {
    // e.g. a Notion property's inner value `properties.X.multi_select` — not surfaced as
    // its own flattened field, so no source hints — must still land in the text column.
    expect(pickMappingTransformers(undefined, field({ type: 'string' }))).toEqual([
      { type: 'auto_convert', options: { targetType: 'string' } },
    ]);
  });

  it('coerces a non-scalar source into a text destination (serialize) instead of leaving it unbridged', () => {
    expect(pickMappingTransformers(field({ type: 'array' }), field({ type: 'string' }))).toEqual([
      { type: 'auto_convert', options: { targetType: 'string' } },
    ]);
  });

  it('does NOT coerce into a structured destination even for an unknown source (needs a pack hint)', () => {
    expect(pickMappingTransformers(undefined, field({ type: 'object' }))).toEqual([]);
  });

  describe('unknown / object source → destination pack (pre-pack stringify)', () => {
    const stringify: TransformerConfig = { type: 'auto_convert', options: { targetType: 'string' } };

    it('stringifies an object source before the destination pack', () => {
      expect(pickMappingTransformers(field({ type: 'object' }), field({ suggestedInTransformer: pack }))).toEqual([
        stringify,
        pack,
      ]);
    });

    it("stringifies an 'unknown'-typed source before the pack (un-modeled connector field)", () => {
      expect(pickMappingTransformers(field({ type: 'unknown' }), field({ suggestedInTransformer: pack }))).toEqual([
        stringify,
        pack,
      ]);
    });

    it('stringifies a missing source field (drilled/computed path) before the pack', () => {
      expect(pickMappingTransformers(undefined, field({ suggestedInTransformer: pack }))).toEqual([stringify, pack]);
    });

    it('leaves a declared array source to the pack (its natural pairing is an array-consuming pack)', () => {
      expect(pickMappingTransformers(field({ type: 'array' }), field({ suggestedInTransformer: pack }))).toEqual([
        pack,
      ]);
    });

    it('leaves known scalar sources un-stringified before the pack', () => {
      expect(pickMappingTransformers(field({ type: 'number' }), field({ suggestedInTransformer: pack }))).toEqual([
        pack,
      ]);
      expect(pickMappingTransformers(field({ type: 'string' }), field({ suggestedInTransformer: pack }))).toEqual([
        pack,
      ]);
    });
  });

  // DEV-10952: when the pack DECLARES the primitive it consumes, coercion is driven by that primitive
  // (not the source-type heuristic), closing the blind spot for known scalars / arrays into a text pack.
  describe('declared pack input type (DEV-10952)', () => {
    const stringify: TransformerConfig = { type: 'auto_convert', options: { targetType: 'string' } };
    const numberPack: TransformerConfig = { type: 'wrap_object', options: { template: { number: '$value' } } };
    const toNumber: TransformerConfig = { type: 'auto_convert', options: { targetType: 'number' } };

    it('stringifies a KNOWN numeric source into a string-consuming pack (Postgres integer → rich_text)', () => {
      expect(
        pickMappingTransformers(
          field({ type: 'number' }),
          field({ suggestedInTransformer: pack, suggestedInTransformerInputType: 'string' }),
        ),
      ).toEqual([stringify, pack]);
    });

    it('does NOT stringify a string source into a string-consuming pack', () => {
      expect(
        pickMappingTransformers(
          field({ type: 'string' }),
          field({ suggestedInTransformer: pack, suggestedInTransformerInputType: 'string' }),
        ),
      ).toEqual([pack]);
    });

    it('runs source unpack (already a CoreValue string) then the string pack — no extra coercion', () => {
      expect(
        pickMappingTransformers(
          field({ type: 'object', suggestedTransformer: unpack }),
          field({ suggestedInTransformer: pack, suggestedInTransformerInputType: 'string' }),
        ),
      ).toEqual([unpack, pack]);
    });

    it('coerces a string source to number before a number-consuming pack (text "5" → Notion number)', () => {
      expect(
        pickMappingTransformers(
          field({ type: 'string' }),
          field({ suggestedInTransformer: numberPack, suggestedInTransformerInputType: 'number' }),
        ),
      ).toEqual([toNumber, numberPack]);
    });

    it('leaves a numeric source un-coerced into a number-consuming pack', () => {
      expect(
        pickMappingTransformers(
          field({ type: 'number' }),
          field({ suggestedInTransformer: numberPack, suggestedInTransformerInputType: 'number' }),
        ),
      ).toEqual([numberPack]);
    });
  });
});
