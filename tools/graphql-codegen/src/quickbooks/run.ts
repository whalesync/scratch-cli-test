#!/usr/bin/env ts-node
/**
 * QuickBooks Online Schema Codegen Script
 *
 * Fetches entity schemas from the Airbyte QuickBooks connector manifest
 * and generates TypeBox schema definitions for the Scratch QBO connector.
 *
 * Usage:
 *   cd tools/graphql-codegen && yarn codegen:quickbooks
 *
 * The generated file is committed to the repo and used at runtime.
 * Re-run this script when you want to pick up schema changes from upstream.
 *
 * Source: https://github.com/airbytehq/airbyte (MIT license)
 */

import axios from "axios";
import * as fs from "fs";
import * as yaml from "js-yaml";
import * as path from "path";

// ============= Configuration =============

const MANIFEST_URL =
  "https://raw.githubusercontent.com/airbytehq/airbyte/master/airbyte-integrations/connectors/source-quickbooks/manifest.yaml";

const OUTPUT_FILE = path.resolve(
  __dirname,
  "../../../../server/src/remote-service/connectors/library/quickbooks/quickbooks-schemas.ts",
);

/**
 * Entity types we support in our connector, mapped to their Airbyte stream names.
 * Airbyte uses snake_case stream names; QBO API uses PascalCase entity names.
 */
const ENTITY_MAP: Record<string, string> = {
  accounts: "Account",
  bills: "Bill",
  bill_payments: "BillPayment",
  credit_memos: "CreditMemo",
  customers: "Customer",
  // departments: 'Department', — excluded: rarely used, typically empty
  deposits: "Deposit",
  employees: "Employee",
  estimates: "Estimate",
  invoices: "Invoice",
  items: "Item",
  journal_entries: "JournalEntry",
  payments: "Payment",
  payment_methods: "PaymentMethod",
  purchases: "Purchase",
  purchase_orders: "PurchaseOrder",
  refund_receipts: "RefundReceipt",
  sales_receipts: "SalesReceipt",
  tax_codes: "TaxCode",
  tax_rates: "TaxRate",
  terms: "Term",
  time_activities: "TimeActivity",
  vendors: "Vendor",
  // CompanyInfo is handled separately — Airbyte doesn't include it as a standard stream
};

/**
 * Fields that exist in actual QBO API responses but are missing from Airbyte's schema.
 * Discovered by comparing static schemas against live sandbox data.
 * These get merged into the Airbyte-sourced schema during codegen.
 */
const SUPPLEMENTARY_FIELDS: Record<
  string,
  Record<string, JsonSchemaProperty>
> = {
  Bill: {
    VendorAddr: { type: ["null", "object"], properties: {} },
  },
  CompanyInfo: {
    CustomerCommunicationEmailAddr: {
      type: ["null", "object"],
      properties: {},
    },
    DefaultTimeZone: { type: ["null", "string"] },
  },
  CreditMemo: {
    FreeFormAddress: { type: ["null", "boolean"] },
  },
  Customer: {
    IsProject: { type: ["null", "boolean"] },
    ClientEntityId: { type: ["null", "string"] },
    V4IDPseudonym: { type: ["null", "string"] },
  },
  Deposit: {
    TxnTaxDetail: { type: ["null", "object"], properties: {} },
  },
  Employee: {
    V4IDPseudonym: { type: ["null", "string"] },
  },
  Estimate: {
    FreeFormAddress: { type: ["null", "boolean"] },
  },
  Invoice: {
    FreeFormAddress: { type: ["null", "boolean"] },
    ShipFromAddr: { type: ["null", "object"], properties: {} },
  },
  JournalEntry: {
    TotalAmt: { type: ["null", "number"] },
  },
  RefundReceipt: {
    FreeFormAddress: { type: ["null", "boolean"] },
  },
  SalesReceipt: {
    FreeFormAddress: { type: ["null", "boolean"] },
    ShipFromAddr: { type: ["null", "object"], properties: {} },
  },
  TaxCode: {
    TaxCodeConfigType: { type: ["null", "string"] },
  },
  TimeActivity: {
    CostRate: { type: ["null", "number"] },
    Seconds: { type: ["null", "number"] },
    TimeChargeId: { type: ["null", "number"] },
  },
  Vendor: {
    V4IDPseudonym: { type: ["null", "string"] },
    BillRate: { type: ["null", "number"] },
  },
};

// ============= Foreign Key Resolution =============

/**
 * Maps QuickBooks *Ref field names to their target table slugs.
 * Only includes Refs that point to entities we support in our connector.
 * Fields referencing unsupported entities (Currency, Department, Class) are omitted.
 */
const REF_FIELD_TO_TABLE: Record<string, string> = {
  // Direct entity refs
  VendorRef: "vendor",
  CustomerRef: "customer",
  ItemRef: "item",
  PaymentMethodRef: "paymentmethod",
  TaxCodeRef: "taxcode",
  TaxRateRef: "taxrate",
  EmployeeRef: "employee",
  // Account-type refs (all point to Account entity)
  AccountRef: "account",
  APAccountRef: "account",
  BankAccountRef: "account",
  CCAccountRef: "account",
  AssetAccountRef: "account",
  ExpenseAccountRef: "account",
  IncomeAccountRef: "account",
  DiscountAccountRef: "account",
  DepositToAccountRef: "account",
  // Term refs
  SalesTermRef: "term",
  // Tax code variants
  DefaultTaxCodeRef: "taxcode",
  TxnTaxCodeRef: "taxcode",
};

/**
 * Entities where ParentRef is a self-reference to the same table.
 */
const SELF_REF_ENTITIES = new Set(["Account", "Customer", "Item"]);

/**
 * Resolve the FK target table slug for a Ref field, or null if not a known FK.
 */
function resolveRefTarget(
  fieldName: string,
  entityName: string,
): string | null {
  if (fieldName === "ParentRef" && SELF_REF_ENTITIES.has(entityName)) {
    return entityName.toLowerCase();
  }
  return REF_FIELD_TO_TABLE[fieldName] ?? null;
}

/**
 * Inject FOREIGN_KEY_OPTIONS into a nullable TypeBox expression.
 * Expects the expression to end with `])` from a Type.Union([..., Type.Null()]) wrapper.
 */
function addForeignKeyAnnotation(
  typeExpr: string,
  linkedTableId: string,
): string {
  const fkOpts = `{ [FOREIGN_KEY_OPTIONS]: { linkedTableId: '${linkedTableId}' } }`;
  const closingIdx = typeExpr.lastIndexOf("])");
  if (closingIdx !== -1) {
    return `${typeExpr.slice(0, closingIdx + 1)}, ${fkOpts})`;
  }
  return typeExpr;
}

// ============= Types =============

interface JsonSchemaProperty {
  type?: string | string[];
  format?: string;
  properties?: Record<string, JsonSchemaProperty>;
  items?: JsonSchemaProperty;
  additionalProperties?: boolean;
}

interface JsonSchema {
  type: string;
  properties: Record<string, JsonSchemaProperty>;
  additionalProperties?: boolean;
}

interface AirbyteStream {
  name: string;
  schema_loader?: {
    type?: string;
    schema?: JsonSchema;
  };
}

// ============= Manifest Fetching =============

async function fetchManifest(): Promise<string> {
  console.log(`Fetching Airbyte manifest from:\n  ${MANIFEST_URL}\n`);
  const response = await axios.get<string>(MANIFEST_URL, {
    responseType: "text",
  });
  return response.data;
}

function extractStreams(manifest: unknown): AirbyteStream[] {
  const doc = manifest as Record<string, unknown>;

  // Airbyte manifests define streams under definitions.streams as an object keyed by stream name
  const definitions = doc["definitions"] as Record<string, unknown> | undefined;
  const streamsObj = definitions?.["streams"] as
    | Record<string, Record<string, unknown>>
    | undefined;

  if (!streamsObj || typeof streamsObj !== "object") {
    throw new Error("Could not find definitions.streams in manifest");
  }

  return Object.entries(streamsObj).map(([name, stream]) => ({
    ...stream,
    name,
  })) as unknown as AirbyteStream[];
}

function extractSchemaForStream(stream: AirbyteStream): JsonSchema | null {
  const schema = stream.schema_loader?.schema;
  if (!schema || !schema.properties) return null;
  return schema;
}

// ============= TypeBox Code Generation =============

/**
 * Convert a JSON Schema property into a TypeBox expression string.
 */
function jsonSchemaToTypebox(
  prop: JsonSchemaProperty,
  depth: number = 0,
  entityName: string = "",
): string {
  // Handle nullable type arrays like ["null", "string"]
  const types = Array.isArray(prop.type)
    ? prop.type.filter((t) => t !== "null")
    : prop.type
      ? [prop.type]
      : [];
  const isNullable = Array.isArray(prop.type) && prop.type.includes("null");

  // Nested object
  if (
    types.includes("object") &&
    prop.properties &&
    Object.keys(prop.properties).length > 0
  ) {
    const inner = objectPropertiesToTypebox(
      prop.properties,
      depth + 1,
      entityName,
    );
    return wrapNullable(`Type.Object({${inner}})`, isNullable);
  }

  // Array
  if (types.includes("array") && prop.items) {
    const itemExpr = jsonSchemaToTypebox(prop.items, depth + 1, entityName);
    return wrapNullable(`Type.Array(${itemExpr})`, isNullable);
  }

  // Empty object (no properties defined)
  if (types.includes("object")) {
    return wrapNullable("Type.Object({})", isNullable);
  }

  // Scalar types
  const scalarType = types[0] || "string";
  let expr: string;

  switch (scalarType) {
    case "string":
      if (prop.format === "date-time") {
        expr = `Type.String({ format: 'date-time', [CONNECTOR_DATA_TYPE]: 'datetime' })`;
      } else if (prop.format === "date") {
        expr = `Type.String({ format: 'date', [CONNECTOR_DATA_TYPE]: 'date' })`;
      } else {
        expr = "Type.String()";
      }
      break;
    case "number":
      expr = "Type.Number()";
      break;
    case "integer":
      expr = "Type.Integer()";
      break;
    case "boolean":
      expr = "Type.Boolean()";
      break;
    default:
      expr = "Type.Unknown()";
  }

  return wrapNullable(expr, isNullable);
}

function wrapNullable(expr: string, nullable: boolean): string {
  if (nullable) {
    return `Type.Union([${expr}, Type.Null()])`;
  }
  return expr;
}

function objectPropertiesToTypebox(
  properties: Record<string, JsonSchemaProperty>,
  depth: number,
  entityName: string = "",
): string {
  const entries = Object.entries(properties)
    // Skip Airbyte-internal fields
    .filter(([key]) => key !== "airbyte_cursor")
    .map(([key, prop]) => {
      let typeExpr = jsonSchemaToTypebox(prop, depth, entityName);

      // Add FK metadata for known Ref fields
      const fkTarget = resolveRefTarget(key, entityName);
      if (fkTarget) {
        typeExpr = addForeignKeyAnnotation(typeExpr, fkTarget);
      }

      // All fields except Id are Optional + readonly
      if (key === "Id") {
        return `\n${"  ".repeat(depth + 2)}${key}: Type.String({ [READONLY_FLAG]: true }),`;
      }
      return `\n${"  ".repeat(depth + 2)}${key}: Type.Optional(${typeExpr}),`;
    });
  return entries.join("");
}

/**
 * Generate the full TypeBox schema variable for an entity.
 */
function generateEntitySchema(entityName: string, schema: JsonSchema): string {
  const props = objectPropertiesToTypebox(schema.properties, 0, entityName);
  return `const ${entityName}Schema = Type.Object(\n  {${props}\n  },\n  { $id: 'quickbooks/${entityName}', additionalProperties: true },\n);`;
}

// ============= CompanyInfo (not in Airbyte) =============

function generateCompanyInfoSchema(): string {
  return `const CompanyInfoSchema = Type.Object(
  {
    Id: Type.String({ [READONLY_FLAG]: true }),
    SyncToken: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    MetaData: Type.Optional(Type.Union([Type.Object({
      CreateTime: Type.Optional(Type.Union([Type.String({ format: 'date-time', [CONNECTOR_DATA_TYPE]: 'datetime' }), Type.Null()])),
      LastUpdatedTime: Type.Optional(Type.Union([Type.String({ format: 'date-time', [CONNECTOR_DATA_TYPE]: 'datetime' }), Type.Null()])),
    }), Type.Null()])),
    CompanyName: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    LegalName: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    CompanyAddr: Type.Optional(Type.Object({})),
    CustomerCommunicationAddr: Type.Optional(Type.Object({})),
    LegalAddr: Type.Optional(Type.Object({})),
    PrimaryPhone: Type.Optional(Type.Object({})),
    CompanyStartDate: Type.Optional(Type.Union([Type.String({ format: 'date', [CONNECTOR_DATA_TYPE]: 'date' }), Type.Null()])),
    FiscalYearStartMonth: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    Country: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    Email: Type.Optional(Type.Object({})),
    WebAddr: Type.Optional(Type.Object({})),
    SupportedLanguages: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    NameValue: Type.Optional(Type.Array(Type.Object({}))),
    CustomerCommunicationEmailAddr: Type.Optional(Type.Object({})),
    DefaultTimeZone: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  },
  { $id: 'quickbooks/CompanyInfo', additionalProperties: true },
);`;
}

// ============= Output File Generation =============

function generateOutputFile(
  schemas: { entityName: string; code: string }[],
  entityNames: string[],
  sourceUrl: string,
  generatedAt: string,
): string {
  const header = `/**
 * Static TypeBox schemas for QuickBooks Online entity types.
 *
 * AUTO-GENERATED — DO NOT EDIT MANUALLY.
 * To regenerate: cd tools/graphql-codegen && yarn codegen:quickbooks
 *
 * Source: Airbyte QuickBooks connector (MIT license)
 * ${sourceUrl}
 *
 * Generated at: ${generatedAt}
 *
 * Only \`Id\` is marked readonly here; the connector applies the remaining
 * read-only annotations (computed + system fields) at build time in
 * \`quickbooks-json-schema.ts\`.
 * All schemas have additionalProperties: true to handle undocumented fields.
 */
import { type TSchema, Type } from '@sinclair/typebox';
import { CONNECTOR_DATA_TYPE, FOREIGN_KEY_OPTIONS, READONLY_FLAG } from '@spinner/shared-types';
import { QuickBooksEntityType } from './quickbooks-types';
`;

  const schemaCode = schemas.map((s) => s.code).join("\n\n");

  const registryEntries = entityNames
    .map((name) => `  ${name}: ${name}Schema,`)
    .join("\n");
  const registry = `
/**
 * Map from QuickBooks entity type to its static TypeBox schema.
 */
export const QBO_SCHEMA_MAP: Record<QuickBooksEntityType, TSchema> = {
${registryEntries}
};
`;

  return `${header}\n${schemaCode}\n${registry}\n`;
}

// ============= Main =============

async function main(): Promise<void> {
  const manifestText = await fetchManifest();
  const manifest = yaml.load(manifestText);
  const streams = extractStreams(manifest);

  console.log(`Found ${streams.length} streams in manifest.\n`);

  const schemas: { entityName: string; code: string }[] = [];
  const entityNames: string[] = [];
  const missing: string[] = [];

  // Process streams that match our entity map
  for (const [streamName, entityName] of Object.entries(ENTITY_MAP)) {
    const stream = streams.find((s) => s.name === streamName);
    if (!stream) {
      missing.push(`${streamName} (${entityName})`);
      continue;
    }

    const jsonSchema = extractSchemaForStream(stream);
    if (!jsonSchema) {
      missing.push(`${streamName} (${entityName}) — no schema`);
      continue;
    }

    // Merge supplementary fields not in Airbyte's schema
    const extras = SUPPLEMENTARY_FIELDS[entityName];
    if (extras) {
      for (const [fieldName, fieldSchema] of Object.entries(extras)) {
        if (!jsonSchema.properties[fieldName]) {
          jsonSchema.properties[fieldName] = fieldSchema;
        }
      }
    }

    const code = generateEntitySchema(entityName, jsonSchema);
    schemas.push({ entityName, code });
    entityNames.push(entityName);

    const fieldCount = Object.keys(jsonSchema.properties).filter(
      (k) => k !== "airbyte_cursor",
    ).length;
    console.log(
      `  ${entityName.padEnd(20)} ${String(fieldCount).padStart(3)} fields`,
    );
  }

  // Add CompanyInfo (not in Airbyte manifest)
  schemas.push({
    entityName: "CompanyInfo",
    code: generateCompanyInfoSchema(),
  });
  entityNames.push("CompanyInfo");
  console.log(`  ${"CompanyInfo".padEnd(20)}  16 fields (hardcoded)`);

  // Sort by entity name for stable output
  schemas.sort((a, b) => a.entityName.localeCompare(b.entityName));
  entityNames.sort();

  if (missing.length > 0) {
    console.log(`\nWarning: ${missing.length} streams not found in manifest:`);
    for (const m of missing) {
      console.log(`  - ${m}`);
    }
  }

  const generatedAt = new Date().toISOString();
  const output = generateOutputFile(
    schemas,
    entityNames,
    MANIFEST_URL,
    generatedAt,
  );

  fs.writeFileSync(OUTPUT_FILE, output, "utf8");
  console.log(`\nWritten ${schemas.length} entity schemas to:`);
  console.log(`  ${OUTPUT_FILE}`);

  // Format with prettier (uses repo root config)
  console.log("\nFormatting with prettier...");
  const { execSync } = require("child_process");
  const repoRoot = path.resolve(__dirname, "../../../..");
  const prettierBin = path.join(repoRoot, "node_modules", ".bin", "prettier");
  execSync(`"${prettierBin}" --write "${OUTPUT_FILE}"`, {
    cwd: repoRoot,
    stdio: "inherit",
  });

  console.log(`\nDone! Run 'yarn build' from the repo root to verify.`);
}

main().catch((error) => {
  console.error(
    "Codegen failed:",
    error instanceof Error ? error.message : error,
  );
  process.exit(1);
});
