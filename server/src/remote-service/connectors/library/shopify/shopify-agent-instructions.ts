import { TSchema, Type } from '@sinclair/typebox';
import { X_SCRATCH_AGENT_INSTRUCTIONS } from '@spinner/shared-types';

/**
 * Per-entity, per-field agent instructions for Shopify.
 *
 * These are plain-text hints for AI agents that read `schema.json` before editing records (see the
 * Connector Development Guide → `x-scratch-agent-instructions`). They are NOT surfaced in any
 * human-facing UI. They live here — applied at runtime in `ShopifyConnector.fetchJsonTableSpec` —
 * rather than in the generated TypeBox schemas (`graphql/schemas/*.schema.ts`), because those are
 * overwritten by `yarn codegen:shopify`. Keep this map sparse: only non-obvious connector quirks an
 * agent would otherwise get wrong.
 */
export const SHOPIFY_AGENT_FIELD_INSTRUCTIONS: Record<string, Record<string, string>> = {
  products: {
    // `description` is read-only — Shopify's computed plain-text rendering. The writable field is `descriptionHtml`.
    description:
      "Shopify computes from descriptionHtml. To change the product's body copy, edit descriptionHtml (HTML)",
  },
};

/**
 * Return a copy of `schema` with the entity's agent-instruction hints attached to the relevant field
 * schemas via `X_SCRATCH_AGENT_INSTRUCTIONS`. Never mutates the input (the generated schemas are
 * shared module singletons). Returns the schema unchanged when the entity has no instructions, the
 * schema has no `properties`, or none of the named fields exist.
 */
export function applyShopifyAgentFieldInstructions(schema: TSchema, entityType: string): TSchema {
  const fieldInstructionsForEntity = SHOPIFY_AGENT_FIELD_INSTRUCTIONS[entityType];
  const properties = (schema as TSchema & { properties?: Record<string, TSchema> }).properties;
  if (!fieldInstructionsForEntity || !properties) {
    return schema;
  }

  const annotatedProperties: Record<string, TSchema> = { ...properties };
  let didAnnotateAnyField = false;
  for (const [fieldName, instruction] of Object.entries(fieldInstructionsForEntity)) {
    const fieldSchema = annotatedProperties[fieldName];
    if (fieldSchema) {
      // Object spread preserves TypeBox's symbol-keyed internals (e.g. [Kind]) and the field's
      // existing string annotations (e.g. x-scratch-readonly), while adding the agent hint.
      annotatedProperties[fieldName] = { ...fieldSchema, [X_SCRATCH_AGENT_INSTRUCTIONS]: instruction };
      didAnnotateAnyField = true;
    }
  }
  if (!didAnnotateAnyField) {
    return schema;
  }

  return Type.Object(annotatedProperties, schema.$id || schema.title ? { $id: schema.$id, title: schema.title } : {});
}
