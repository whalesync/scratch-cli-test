#!/usr/bin/env node
/**
 * Regenerates `src/remote-service/connectors/library/stripe/stripe-object-schemas.generated.ts` from
 * Stripe's published OpenAPI spec, so the Stripe connector declares every field Stripe returns instead
 * of a hand-typed subset. Stripe has no endpoint that lists an account's fields, but it publishes the
 * full shape of every object for each API version, which is the closest thing to dynamic discovery.
 *
 * Usage (from server/), with the spec for the API version the connector pins
 * (STRIPE_CONNECTOR_API_VERSION in stripe-api-client.ts). github.com/stripe/openapi keeps only the latest
 * spec on master, so take it from the commit that published that version — `af5309cae5` is
 * 2026-07-29.dahlia:
 *   curl -sSL -o /tmp/stripe-spec3.json \
 *     https://raw.githubusercontent.com/stripe/openapi/af5309cae5/openapi/spec3.json
 *   node scripts/generate-stripe-object-schemas.mjs /tmp/stripe-spec3.json
 *   yarn prettier --write src/remote-service/connectors/library/stripe/stripe-object-schemas.generated.ts
 *
 * The script prints the spec's API version; it must equal STRIPE_CONNECTOR_API_VERSION (a unit test
 * checks), so the `Stripe-Version` header we send matches the shapes we declare.
 *
 * What the transform does, all of it mechanical:
 *  - keeps only the objects the connector has tables for, minus the fields Stripe leaves out of a
 *    response unless the request asks for them (FIELDS_RETURNED_ONLY_WHEN_REQUESTED), plus the fields
 *    Stripe still returns but no longer declares (FIELDS_RETURNED_BUT_NOT_DECLARED);
 *  - inlines `$ref`s so each object is one self-contained JSON Schema, down to MAX_INLINED_OBJECT_DEPTH
 *    levels of nested objects — deeper objects (and reference cycles) collapse to an opaque
 *    `{ type: 'object' }`, which keeps a charge's `payment_method_details` (one branch per payment
 *    method) from expanding into megabytes per table spec;
 *  - turns an expandable field (`anyOf [string id, <object>, …]`) into the string id Stripe returns
 *    when the field isn't expanded — the connector expands nothing — and records the objects it can
 *    point at as `x-stripe-expandable-resources`, which the connector turns into foreign keys;
 *  - keeps Stripe's `format: 'unix-time'` on epoch-second integers (the connector turns it into its
 *    own timestamp annotation) and drops every other format;
 *  - turns OpenAPI 3.0 `nullable: true` into a JSON Schema `anyOf [<shape>, null]`;
 *  - drops `enum` lists, listing the values in the description instead (Stripe adds values within an
 *    API version, so a closed enum would flag valid records), `required` (Stripe marks fields required
 *    that a record may omit), length validation keywords, and Stripe's other `x-*` keys;
 *  - shortens each description to its first sentence, with Markdown links reduced to their text.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Stripe's own object names, one per connector table, in table order. */
const ROOT_OBJECT_SCHEMA_NAMES = [
  'customer',
  'product',
  'price',
  'subscription',
  'invoice',
  'payment_intent',
  'charge',
  'refund',
  'dispute',
  'credit_note',
  'coupon',
  'promotion_code',
  'balance_transaction',
  'subscription_schedule',
  'event',
];

/**
 * Fields Stripe's docs mark "includable": declared on the object, but returned only when the request
 * expands them, which the connector doesn't. Declaring them would offer always-empty columns. The spec
 * doesn't flag these, so they are listed by hand from the API reference.
 */
const FIELDS_RETURNED_ONLY_WHEN_REQUESTED = {
  customer: ['cash_balance', 'invoice_credit_balance', 'sources', 'subscriptions', 'tax', 'tax_ids'],
  price: ['currency_options', 'tiers'],
  coupon: ['applies_to', 'currency_options'],
  charge: ['refunds'],
  invoice: ['payments'],
};

/**
 * Fields Stripe still returns at this API version but its spec no longer declares, as JSON Schema. A
 * field missing from the schema has no column, so it could never be exported. Found by comparing the
 * hand-written schemas this generator replaced, and live records, against the spec.
 */
const FIELDS_RETURNED_BUT_NOT_DECLARED = {
  product: {
    type: { type: 'string', description: 'Whether the product is a good or a service. One of: good, service.' },
  },
};

/** Root properties are depth 1; objects nested deeper than this become opaque `{ type: 'object' }`. */
const MAX_INLINED_OBJECT_DEPTH = 3;

const MAX_DESCRIPTION_LENGTH = 200;

/** Enum lists longer than this are left out of the description rather than listed. */
const MAX_ENUM_VALUES_LISTED_IN_DESCRIPTION = 15;

const specPath = process.argv[2];
if (!specPath) {
  console.error('Usage: node scripts/generate-stripe-object-schemas.mjs <path to Stripe spec3.json>');
  process.exit(1);
}

const spec = JSON.parse(fs.readFileSync(specPath, 'utf8'));
const componentSchemasByName = spec.components.schemas;
const stripeApiVersion = spec.info?.version;
if (typeof stripeApiVersion !== 'string') {
  console.error('The spec has no info.version');
  process.exit(1);
}

function shortenDescription(description) {
  if (typeof description !== 'string') return undefined;
  const withoutLinks = description
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  if (withoutLinks === '') return undefined;
  const firstSentence = withoutLinks.match(/^.*?[.!?](?=\s|$)/)?.[0] ?? withoutLinks;
  return firstSentence.length > MAX_DESCRIPTION_LENGTH
    ? `${firstSentence.slice(0, MAX_DESCRIPTION_LENGTH - 1)}…`
    : firstSentence;
}

/** The description with the enum's values appended, when it has a short enough list of them. */
function describeWithEnumValues(description, enumValues) {
  if (!Array.isArray(enumValues) || enumValues.length === 0) return description;
  if (enumValues.length > MAX_ENUM_VALUES_LISTED_IN_DESCRIPTION) return description;
  const valuesSentence = `One of: ${enumValues.join(', ')}.`;
  return description ? `${description} ${valuesSentence}` : valuesSentence;
}

function referencedSchemaName(ref) {
  return ref.split('/').pop();
}

/**
 * The objects an expandable field can point at, when `anyOf` is Stripe's expandable pattern — a string
 * id arm plus one arm per object it expands into (`anyOf [string, customer, deleted_customer]`) — or
 * undefined when it isn't.
 */
function expandableResourceNamesOf(anyOfArms) {
  const stringArms = anyOfArms.filter((arm) => arm.type === 'string');
  const referenceArms = anyOfArms.filter((arm) => arm.$ref);
  if (stringArms.length !== 1 || referenceArms.length === 0) return undefined;
  if (stringArms.length + referenceArms.length !== anyOfArms.length) return undefined;
  return referenceArms.map((arm) => referencedSchemaName(arm.$ref));
}

/** Wrap a shape in `anyOf [<shape>, null]`, keeping the description on the wrapper. */
function asNullable(inlinedShape) {
  const { description, ...nonNullShape } = inlinedShape;
  return { anyOf: [nonNullShape, { type: 'null' }], ...(description ? { description } : {}) };
}

/**
 * Inline one OpenAPI schema node. `objectDepth` counts how many object levels we are below the root
 * object; `ancestorSchemaNames` guards against reference cycles (an invoice's `from_invoice` points at
 * another invoice).
 */
function inlineSchema(node, objectDepth, ancestorSchemaNames) {
  let shape = node;
  let referencedName;
  if (node.$ref) {
    referencedName = referencedSchemaName(node.$ref);
    shape = componentSchemasByName[referencedName];
    if (!shape) throw new Error(`The spec references ${referencedName} but never defines it`);
  }

  const isNullable = node.nullable === true || shape.nullable === true;
  const description = describeWithEnumValues(shortenDescription(node.description ?? shape.description), shape.enum);
  let inlined;

  if (shape.anyOf) {
    const expandableResourceNames = expandableResourceNamesOf(shape.anyOf);
    const nonNullArms = shape.anyOf.filter((arm) => arm.type !== 'null');
    if (expandableResourceNames) {
      inlined = { type: 'string', 'x-stripe-expandable-resources': expandableResourceNames };
    } else if (nonNullArms.length === 1) {
      // OpenAPI 3.0 writes a nullable reference as `anyOf [{ $ref }]` + `nullable: true`.
      inlined = inlineSchema(nonNullArms[0], objectDepth, ancestorSchemaNames);
      delete inlined.description;
    } else {
      inlined = { anyOf: nonNullArms.map((arm) => inlineSchema(arm, objectDepth, ancestorSchemaNames)) };
    }
  } else if (shape.type === 'object' || shape.properties) {
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
      } else if (shape.additionalProperties === true) {
        // An open object (an event's `data.object` holds whichever object changed). Kept open, with an
        // empty `properties`, so a path below it (`data.object.id`) still resolves against the schema.
        inlined.properties ??= {};
        inlined.additionalProperties = true;
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
    if (shape.format === 'unix-time') inlined.format = 'unix-time';
  } else {
    inlined = {};
  }

  if (description) inlined.description = description;
  return isNullable ? asNullable(inlined) : inlined;
}

const objectSchemasByStripeObjectName = {};
for (const rootSchemaName of ROOT_OBJECT_SCHEMA_NAMES) {
  const rootSchema = componentSchemasByName[rootSchemaName];
  if (!rootSchema) throw new Error(`The spec has no component schema named ${rootSchemaName}`);
  const inlinedRoot = inlineSchema({ $ref: `#/components/schemas/${rootSchemaName}` }, 0, []);
  for (const fieldName of FIELDS_RETURNED_ONLY_WHEN_REQUESTED[rootSchemaName] ?? []) {
    if (!inlinedRoot.properties?.[fieldName]) {
      throw new Error(`${rootSchemaName}.${fieldName} is listed as returned only when requested, but isn't declared`);
    }
    delete inlinedRoot.properties[fieldName];
  }
  for (const [fieldName, fieldSchema] of Object.entries(FIELDS_RETURNED_BUT_NOT_DECLARED[rootSchemaName] ?? {})) {
    if (inlinedRoot.properties?.[fieldName]) {
      throw new Error(`${rootSchemaName}.${fieldName} is listed as undeclared, but the spec now declares it`);
    }
    inlinedRoot.properties[fieldName] = fieldSchema;
  }
  objectSchemasByStripeObjectName[rootSchemaName] = inlinedRoot;
}

const outputPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../src/remote-service/connectors/library/stripe/stripe-object-schemas.generated.ts',
);

const fileContents = `// GENERATED FILE — do not edit by hand. Regenerate with server/scripts/generate-stripe-object-schemas.mjs
// from https://github.com/stripe/openapi (openapi/spec3.json).

/** The Stripe API version these shapes were generated from. Must equal STRIPE_CONNECTOR_API_VERSION. */
export const STRIPE_OBJECT_SCHEMAS_API_VERSION = ${JSON.stringify(stripeApiVersion)};

/** The Stripe objects whose schemas this file carries — Stripe's own object names. */
export type StripeObjectName = ${ROOT_OBJECT_SCHEMA_NAMES.map((name) => `'${name}'`).join(' | ')};

/**
 * One self-contained JSON Schema per Stripe object, keyed by Stripe's own object name. Deliberately
 * typed loosely (not \`as const\`): literal-typing this much JSON only slows the compiler down, and
 * consumers walk it as plain JSON Schema anyway.
 */
export const STRIPE_OBJECT_SCHEMAS_BY_STRIPE_OBJECT_NAME: Record<StripeObjectName, Record<string, unknown>> = ${JSON.stringify(objectSchemasByStripeObjectName, null, 2)};
`;

fs.writeFileSync(outputPath, fileContents);
console.log(`Stripe API version: ${stripeApiVersion}`);
for (const rootSchemaName of ROOT_OBJECT_SCHEMA_NAMES) {
  const rootSchema = objectSchemasByStripeObjectName[rootSchemaName];
  console.log(
    `  ${rootSchemaName}: ${Object.keys(rootSchema.properties ?? {}).length} fields, ${Buffer.byteLength(JSON.stringify(rootSchema))} bytes`,
  );
}
console.log(`wrote ${outputPath} (${Buffer.byteLength(fileContents)} bytes)`);
