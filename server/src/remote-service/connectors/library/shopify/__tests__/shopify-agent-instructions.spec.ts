import { TSchema, Type } from '@sinclair/typebox';
import { X_SCRATCH_AGENT_INSTRUCTIONS, X_SCRATCH_READONLY } from '@spinner/shared-types';
import { SHOPIFY_AGENT_FIELD_INSTRUCTIONS, applyShopifyAgentFieldInstructions } from '../shopify-agent-instructions';

describe('applyShopifyAgentFieldInstructions', () => {
  function buildProductsSchema() {
    return Type.Object({
      title: Type.Optional(Type.Union([Type.String(), Type.Null()])),
      // `description` is the read-only computed field; `descriptionHtml` is the writable one.
      description: Type.Optional(Type.Union([Type.String(), Type.Null()], { [X_SCRATCH_READONLY]: true })),
      descriptionHtml: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    });
  }

  function getProperties(schema: TSchema): Record<string, Record<string, unknown>> {
    return (schema as TSchema & { properties: Record<string, Record<string, unknown>> }).properties;
  }

  const expectedDescriptionInstruction = SHOPIFY_AGENT_FIELD_INSTRUCTIONS.products?.description;

  it('attaches the agent instruction to the products description field', () => {
    const annotated = applyShopifyAgentFieldInstructions(buildProductsSchema(), 'products');
    const descriptionSchema = getProperties(annotated).description;
    expect(descriptionSchema[X_SCRATCH_AGENT_INSTRUCTIONS]).toBe(expectedDescriptionInstruction);
    // The whole point of the hint: redirect agents to the writable field.
    expect(String(descriptionSchema[X_SCRATCH_AGENT_INSTRUCTIONS])).toContain('descriptionHtml');
  });

  it('preserves the existing readonly annotation on the description field', () => {
    const annotated = applyShopifyAgentFieldInstructions(buildProductsSchema(), 'products');
    expect(getProperties(annotated).description[X_SCRATCH_READONLY]).toBe(true);
  });

  it('does not annotate other product fields', () => {
    const annotated = applyShopifyAgentFieldInstructions(buildProductsSchema(), 'products');
    expect(getProperties(annotated).descriptionHtml[X_SCRATCH_AGENT_INSTRUCTIONS]).toBeUndefined();
    expect(getProperties(annotated).title[X_SCRATCH_AGENT_INSTRUCTIONS]).toBeUndefined();
  });

  it('does not mutate the input schema', () => {
    const schema = buildProductsSchema();
    applyShopifyAgentFieldInstructions(schema, 'products');
    expect(getProperties(schema).description[X_SCRATCH_AGENT_INSTRUCTIONS]).toBeUndefined();
  });

  it('returns the schema unchanged for an entity with no instructions', () => {
    const schema = buildProductsSchema();
    expect(applyShopifyAgentFieldInstructions(schema, 'orders')).toBe(schema);
  });

  it('returns the schema unchanged when none of the named fields are present', () => {
    const schema = Type.Object({ title: Type.Optional(Type.String()) });
    expect(applyShopifyAgentFieldInstructions(schema, 'products')).toBe(schema);
  });
});
