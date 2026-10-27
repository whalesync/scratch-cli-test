#!/usr/bin/env node
/**
 * Regenerates `src/remote-service/connectors/library/square/square-entity-schemas.generated.ts` from
 * Square's published OpenAPI spec, so the Square connector's record schemas come from Square's own
 * declaration of each object rather than being hand-typed (Square has no runtime schema-introspection
 * endpoint, so its vendored spec is the closest thing to dynamic discovery).
 *
 * Usage (from server/):
 *   curl -sSL -o /tmp/square-api.json \
 *     https://raw.githubusercontent.com/square/connect-api-specification/master/api.json
 *   node scripts/generate-square-entity-schemas.mjs /tmp/square-api.json
 *   yarn prettier --write src/remote-service/connectors/library/square/square-entity-schemas.generated.ts
 *
 * Then bump SQUARE_CONNECTOR_API_VERSION in square-api-client.ts to the `squareVersion` printed below,
 * so the `Square-Version` header we send matches the shapes we declare.
 *
 * What the transform does, all of it mechanical:
 *  - keeps only the root objects the connector exposes, plus what they reference;
 *  - inlines `$ref`s so each root is one self-contained JSON Schema, down to MAX_INLINED_OBJECT_DEPTH
 *    levels of nested objects — deeper objects (and reference cycles) collapse to an opaque
 *    `{ type: 'object' }`, which is all the view layer can use at that depth anyway, and which keeps
 *    an Order (84 referenced schemas) from expanding into hundreds of KB per table spec;
 *  - turns OpenAPI 3.0 `nullable: true` into a JSON Schema `anyOf [<shape>, null]`;
 *  - drops `enum` lists (Square adds values without a version bump, and nothing downstream needs
 *    them), `required` (it describes REQUESTS; responses omit absent fields), length/format
 *    validation keywords, and `x-*` vendor keys;
 *  - shortens each description to its first sentence with Square's `[Name](entity:Name)` links
 *    reduced to their text.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT_OBJECT_SCHEMA_NAMES = [
  'Location',
  'Customer',
  'CatalogObject',
  'Order',
  'Payment',
  'PaymentRefund',
  'Invoice',
  'TeamMember',
  'Payout',
];

/** Root properties are depth 1; objects nested deeper than this become opaque `{ type: 'object' }`. */
const MAX_INLINED_OBJECT_DEPTH = 3;

const MAX_DESCRIPTION_LENGTH = 200;

const specPath = process.argv[2];
if (!specPath) {
  console.error('Usage: node scripts/generate-square-entity-schemas.mjs <path to Square api.json>');
  process.exit(1);
}

const spec = JSON.parse(fs.readFileSync(specPath, 'utf8'));
const componentSchemasByName = spec.components.schemas;
const squareVersion = (spec['x-fern-global-headers'] ?? [])
  .find((header) => header.header === 'Square-Version')
  ?.type?.match(/"([^"]+)"/)?.[1];
if (!squareVersion) {
  console.error('Could not find the Square-Version literal in x-fern-global-headers');
  process.exit(1);
}

function shortenDescription(description) {
  if (typeof description !== 'string') return undefined;
  const withoutEntityLinks = description
    .replace(/\[([^\]]+)\]\((?:entity|api-endpoint|#)[^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\(https?:[^)]*\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  const firstSentence = withoutEntityLinks.match(/^.*?[.!?](?=\s|$)/)?.[0] ?? withoutEntityLinks;
  return firstSentence.length > MAX_DESCRIPTION_LENGTH
    ? `${firstSentence.slice(0, MAX_DESCRIPTION_LENGTH - 1)}…`
    : firstSentence;
}

const unresolvableSchemaNames = new Set();

function referencedSchemaName(ref) {
  return ref.split('/').pop();
}

/**
 * Inline one OpenAPI schema node. `objectDepth` counts how many object levels we are below the root
 * object; `ancestorSchemaNames` guards against reference cycles (e.g. CatalogObject ↔ CatalogItem).
 */
function inlineSchema(node, objectDepth, ancestorSchemaNames) {
  let shape = node;
  let referencedName;
  if (node.$ref) {
    referencedName = referencedSchemaName(node.$ref);
    shape = componentSchemasByName[referencedName];
    if (!shape) {
      // Square's spec occasionally references a schema it never defines (e.g. AppFeeAllocation).
      // Leave that value untyped rather than guessing a shape for it.
      unresolvableSchemaNames.add(referencedName);
      shape = {};
    }
  }

  const description = shortenDescription(node.description ?? shape.description);
  const isNullable = node.nullable === true || shape.nullable === true;
  let inlined;

  if (shape.type === 'object' || shape.properties) {
    const isCycle = referencedName !== undefined && ancestorSchemaNames.includes(referencedName);
    if (isCycle || objectDepth >= MAX_INLINED_OBJECT_DEPTH) {
      inlined = { type: 'object' };
    } else {
      const nextAncestors = referencedName ? [...ancestorSchemaNames, referencedName] : ancestorSchemaNames;
      inlined = { type: 'object' };
      if (shape.properties) {
        inlined.properties = {};
        for (const [propertyName, propertySchema] of Object.entries(shape.properties)) {
          inlined.properties[propertyName] = inlineSchema(propertySchema, objectDepth + 1, nextAncestors);
        }
      }
      if (shape.additionalProperties && typeof shape.additionalProperties === 'object') {
        inlined.additionalProperties = inlineSchema(shape.additionalProperties, objectDepth + 1, nextAncestors);
      }
    }
  } else if (shape.type === 'array') {
    inlined = { type: 'array' };
    if (shape.items) {
      // An array element sits at the same object depth as the array itself.
      const nextAncestors = referencedName ? [...ancestorSchemaNames, referencedName] : ancestorSchemaNames;
      inlined.items = inlineSchema(shape.items, objectDepth, nextAncestors);
    }
  } else if (shape.type) {
    inlined = { type: shape.type };
  } else {
    inlined = {};
  }

  if (description) inlined.description = description;
  if (!isNullable) return inlined;

  const { description: nullableDescription, ...nonNullShape } = inlined;
  return {
    anyOf: [nonNullShape, { type: 'null' }],
    ...(nullableDescription ? { description: nullableDescription } : {}),
  };
}

const entitySchemasByRootName = {};
for (const rootSchemaName of ROOT_OBJECT_SCHEMA_NAMES) {
  const rootSchema = componentSchemasByName[rootSchemaName];
  if (!rootSchema) throw new Error(`Square spec has no component schema named ${rootSchemaName}`);
  entitySchemasByRootName[rootSchemaName] = inlineSchema({ $ref: `#/components/schemas/${rootSchemaName}` }, 0, []);
}

const outputPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../src/remote-service/connectors/library/square/square-entity-schemas.generated.ts',
);

const fileContents = `// GENERATED FILE — do not edit by hand. Regenerate with server/scripts/generate-square-entity-schemas.mjs
// from https://github.com/square/connect-api-specification (api.json).

/** The Square-Version these shapes were generated from. Must equal SQUARE_CONNECTOR_API_VERSION. */
export const SQUARE_ENTITY_SCHEMAS_SQUARE_VERSION = ${JSON.stringify(squareVersion)};

/** The Square objects whose schemas this file carries — Square's own object names. */
export type SquareObjectName = ${ROOT_OBJECT_SCHEMA_NAMES.map((name) => `'${name}'`).join(' | ')};

/**
 * One self-contained JSON Schema per Square object, keyed by Square's own object name. Deliberately
 * typed loosely (not \`as const\`): literal-typing this much JSON only slows the compiler down, and
 * consumers walk it as plain JSON Schema anyway.
 */
export const SQUARE_ENTITY_SCHEMAS_BY_SQUARE_OBJECT_NAME: Record<SquareObjectName, Record<string, unknown>> = ${JSON.stringify(entitySchemasByRootName, null, 2)};
`;

fs.writeFileSync(outputPath, fileContents);
console.log(`squareVersion: ${squareVersion}`);
if (unresolvableSchemaNames.size > 0) {
  console.warn(`left untyped (referenced but not defined by the spec): ${[...unresolvableSchemaNames].join(', ')}`);
}
console.log(`wrote ${outputPath} (${Buffer.byteLength(fileContents)} bytes)`);
