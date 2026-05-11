#!/usr/bin/env ts-node
/**
 * Shopify Codegen Script
 *
 * Introspects the Shopify GraphQL Admin API and generates:
 * - TypeBox schemas per entity
 * - Mutation strings and read-only field sets
 * - Query field selections
 * - Entity configuration metadata
 *
 * Usage:
 *   SHOPIFY_CODEGEN_SHOP=mystore SHOPIFY_CODEGEN_TOKEN=xxx yarn codegen:shopify
 *
 * Environment variables:
 *   SHOPIFY_CODEGEN_SHOP  - Shop domain (e.g., "mystore" or "mystore.myshopify.com")
 *   SHOPIFY_CODEGEN_TOKEN - Admin API access token
 */

import axios from "axios";
import { execSync } from "child_process";
import * as fs from "fs";
import {
  buildClientSchema,
  getIntrospectionQuery,
  GraphQLSchema,
  IntrospectionQuery,
} from "graphql";
import * as path from "path";
import {
  generateMutationFile,
  generateMutationIndexFile,
  generateMutations,
} from "../plugins/mutations-plugin";
import {
  generateEntityRegistryFile,
  generateSchemaFile,
  generateSchemaIndexFile,
  generateTypeBoxSchemas,
} from "../plugins/typebox-plugin";
import { MutationOutput, TypeBoxSchemaOutput } from "../types";
import { createShopifyPluginConfig, SHOPIFY_ENTITIES } from "./config";

// ============= Configuration =============

const API_VERSION = "2025-01";
const OUTPUT_DIR = path.resolve(
  __dirname,
  "../../../../server/src/remote-service/connectors/library/shopify/graphql",
);

// ============= Introspection =============

async function fetchIntrospection(
  shopDomain: string,
  accessToken: string,
): Promise<IntrospectionQuery> {
  let domain = shopDomain.trim().toLowerCase();
  domain = domain.replace(/^https?:\/\//, "");
  domain = domain.replace(/\/$/, "");
  if (!domain.includes(".myshopify.com")) {
    domain = `${domain}.myshopify.com`;
  }

  const url = `https://${domain}/admin/api/${API_VERSION}/graphql.json`;

  console.log(`Fetching introspection from ${url}...`);

  const response = await axios.post<{
    data: IntrospectionQuery;
    errors?: Array<{ message: string }>;
  }>(
    url,
    { query: getIntrospectionQuery() },
    {
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": accessToken,
      },
    },
  );

  if (response.data.errors?.length) {
    throw new Error(
      `GraphQL introspection error: ${response.data.errors[0].message}`,
    );
  }

  return response.data.data;
}

// ============= Directory Setup =============

function cleanAndCreateDirectories(): void {
  const schemasDir = path.join(OUTPUT_DIR, "schemas");
  const mutationsDir = path.join(OUTPUT_DIR, "mutations");

  // Clean both directories for fresh generation
  for (const dir of [schemasDir, mutationsDir]) {
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true });
    }
  }

  // Ensure all directories exist
  const dirs = [OUTPUT_DIR, schemasDir, mutationsDir];
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }
}

// ============= File Writing =============

function writeSchemaFiles(
  outputs: TypeBoxSchemaOutput[],
  serviceName: string,
  readOnlyFieldsMap: Map<string, string[]>,
): void {
  const schemasDir = path.join(OUTPUT_DIR, "schemas");

  for (const output of outputs) {
    const entity = SHOPIFY_ENTITIES.find(
      (e) => e.entityType === output.entityType,
    );
    if (!entity) continue;

    const fileName = `${output.entityType.replace(/_/g, "-")}.schema.ts`;
    const filePath = path.join(schemasDir, fileName);
    const readOnlyFields = readOnlyFieldsMap.get(output.entityType);
    const content = generateSchemaFile(output, entity, serviceName, readOnlyFields);
    fs.writeFileSync(filePath, content, "utf8");
    console.log(`  Written: ${fileName}`);
  }

  // Write index file
  const entityTypes = outputs.map((o) => o.entityType);
  const indexContent = generateSchemaIndexFile(entityTypes, serviceName);
  fs.writeFileSync(path.join(schemasDir, "index.ts"), indexContent, "utf8");
  console.log("  Written: schemas/index.ts");
}

function writeMutationFiles(
  outputs: MutationOutput[],
  serviceName: string,
): void {
  const mutationsDir = path.join(OUTPUT_DIR, "mutations");
  const entityTypes: string[] = [];

  for (const output of outputs) {
    const entity = SHOPIFY_ENTITIES.find(
      (e) => e.entityType === output.entityType,
    );
    if (!entity) continue;

    // Get the query fields constant name for import
    const constantName = output.entityType.toUpperCase().replace(/-/g, "_");
    const queryFieldsConstName = `${constantName}_QUERY_FIELDS`;

    const fileName = `${output.entityType.replace(/_/g, "-")}.mutations.ts`;
    const filePath = path.join(mutationsDir, fileName);
    const content = generateMutationFile(
      output,
      queryFieldsConstName,
      serviceName,
    );
    fs.writeFileSync(filePath, content, "utf8");
    console.log(`  Written: ${fileName}`);
    entityTypes.push(output.entityType);
  }

  // Write index file
  const indexContent = generateMutationIndexFile(entityTypes, serviceName);
  fs.writeFileSync(path.join(mutationsDir, "index.ts"), indexContent, "utf8");
  console.log("  Written: mutations/index.ts");
}

function writeMetadataFile(outputs: TypeBoxSchemaOutput[]): void {
  const generatedAt = new Date().toISOString();
  const entities = outputs.map((o) => o.entityType);

  const content = `/**
 * Generated Metadata
 *
 * DO NOT EDIT - This file is auto-generated by the codegen script.
 * To regenerate, run: yarn codegen:shopify
 */

export const GENERATED_METADATA = {
  apiVersion: '${API_VERSION}',
  generatedAt: '${generatedAt}',
  entities: ${JSON.stringify(entities, null, 2)},
} as const;

export const API_VERSION = '${API_VERSION}';
export const GENERATED_AT = '${generatedAt}';
export const GENERATED_ENTITIES = [
${entities.map((e) => `  '${e}',`).join("\n")}
] as const;

export type GeneratedEntityType = typeof GENERATED_ENTITIES[number];
`;

  fs.writeFileSync(path.join(OUTPUT_DIR, "metadata.ts"), content, "utf8");
  console.log("  Written: metadata.ts");
}

function writeEntityRegistryFile(serviceName: string): void {
  const content = generateEntityRegistryFile(SHOPIFY_ENTITIES, serviceName);
  fs.writeFileSync(path.join(OUTPUT_DIR, "registry.ts"), content, "utf8");
  console.log("  Written: registry.ts");
}

function writeMainIndexFile(): void {
  const content = `/**
 * Generated Shopify Schemas and Mutations
 *
 * DO NOT EDIT - This file is auto-generated by the codegen script.
 * To regenerate, run: yarn codegen:shopify
 */

// Schemas (includes query fields and entity configs)
export * from './schemas';

// Mutations
export * from './mutations';

// Metadata
export * from './metadata';

// Entity Registry (unified config access)
export * from './registry';
`;

  fs.writeFileSync(path.join(OUTPUT_DIR, "index.ts"), content, "utf8");
  console.log("  Written: index.ts");
}

function writeClaudeMd(): void {
  const content = `# Generated Code - Do Not Edit

This directory contains **auto-generated code** from the Shopify GraphQL codegen system.

## Important

- **DO NOT** edit files in this directory directly
- **DO NOT** add new files to this directory manually
- All changes will be **overwritten** when codegen is run

## How to Regenerate

To regenerate these files, run from the tools/graphql-codegen directory:

\`\`\`bash
SHOPIFY_CODEGEN_SHOP=mystore SHOPIFY_CODEGEN_TOKEN=xxx yarn codegen:shopify
\`\`\`

## How to Make Changes

### To modify schemas or mutations:

1. Edit the entity configuration in \`tools/graphql-codegen/src/shopify/config.ts\`
2. Re-run the codegen command above

### To add new entities:

1. Add entity config to \`SHOPIFY_ENTITIES\` in \`tools/graphql-codegen/src/shopify/config.ts\`
2. Re-run the codegen command

### To change field filtering or mappings:

1. Edit \`SHOPIFY_FIELD_FILTERS\` or \`SHOPIFY_SCALAR_MAPPINGS\` in \`tools/graphql-codegen/src/shopify/config.ts\`
2. Re-run the codegen command

## Source Files

- Codegen script: \`tools/graphql-codegen/src/shopify/run.ts\`
- Entity configuration: \`tools/graphql-codegen/src/shopify/config.ts\`
- TypeBox plugin: \`tools/graphql-codegen/src/plugins/typebox-plugin.ts\`
- Mutations plugin: \`tools/graphql-codegen/src/plugins/mutations-plugin.ts\`

## Directory Structure

- \`schemas/\` - TypeBox schemas and query field selections per entity
- \`mutations/\` - GraphQL mutation strings and read-only field sets
- \`metadata.ts\` - API version and generation timestamp
- \`index.ts\` - Re-exports all generated code
`;

  fs.writeFileSync(path.join(OUTPUT_DIR, "CLAUDE.md"), content, "utf8");
  console.log("  Written: CLAUDE.md");
}

// ============= Helpers =============

/**
 * Extract top-level field names from a generated TypeBox schema code string.
 * Matches the property names at the first indent level of the Type.Object({...}).
 */
function extractTopLevelFieldNames(schemaCode: string): string[] {
  const fields: string[] = [];
  // Only look at lines before the closing "}, {" that separates properties from schema options.
  // This avoids picking up option keys like "title" or "$id" from the Type.Object options.
  const propertiesSection = schemaCode.split(/^},\s*\{/m)[0];
  // Match lines like "  fieldName: Type.Optional(...)" or "  fieldName: Type.String()"
  // at exactly 2-space indent (top-level properties inside the Type.Object)
  const regex = /^  (\w+):/gm;
  let match;
  while ((match = regex.exec(propertiesSection)) !== null) {
    fields.push(match[1]);
  }
  return fields;
}

// ============= Formatting =============

function formatGeneratedFiles(): void {
  const serverDir = path.resolve(OUTPUT_DIR, "../../../../..");
  console.log("\nFormatting generated files with Prettier...");
  try {
    execSync(`npx prettier --write "${OUTPUT_DIR}/**/*.ts"`, {
      cwd: serverDir,
      stdio: "inherit",
    });
    console.log("Formatting complete.");
  } catch (error) {
    console.warn("Warning: Prettier formatting failed. Generated files may have inconsistent style.", error);
  }
}

// ============= Main =============

async function main(): Promise<void> {
  console.log("Shopify Codegen");
  console.log("===============\n");

  // Check environment variables
  const shopDomain = process.env.SHOPIFY_CODEGEN_SHOP;
  const accessToken = process.env.SHOPIFY_CODEGEN_TOKEN;

  if (!shopDomain || !accessToken) {
    console.error("Error: Missing required environment variables.");
    console.error("");
    console.error("Usage:");
    console.error(
      "  SHOPIFY_CODEGEN_SHOP=mystore SHOPIFY_CODEGEN_TOKEN=xxx yarn codegen:shopify",
    );
    console.error("");
    console.error("Environment variables:");
    console.error('  SHOPIFY_CODEGEN_SHOP  - Shop domain (e.g., "mystore")');
    console.error("  SHOPIFY_CODEGEN_TOKEN - Admin API access token");
    process.exit(1);
  }

  console.log(`Shop: ${shopDomain}`);
  console.log(`API Version: ${API_VERSION}`);
  console.log(`Output: ${OUTPUT_DIR}`);
  console.log("");

  // Fetch introspection and build schema
  const introspectionResult = await fetchIntrospection(shopDomain, accessToken);
  const schema: GraphQLSchema = buildClientSchema(introspectionResult);
  console.log("Schema built successfully.\n");

  // Setup directories
  cleanAndCreateDirectories();

  // Get plugin configuration
  const config = createShopifyPluginConfig();

  // Generate schemas
  console.log("Generating TypeBox schemas...\n");
  const schemaOutputs = generateTypeBoxSchemas(
    schema,
    config.entities,
    config.scalarMappings,
    config.fieldFilters,
    config.interfaceImplementations,
    config.maxFieldDepth,
    config.serviceName,
  );
  console.log(`Generated ${schemaOutputs.length} schemas.\n`);

  // Generate mutations
  console.log("Generating mutations...\n");
  const mutationOutputs = generateMutations(schema, config.entities);
  console.log(`Generated mutations for ${mutationOutputs.length} entities.\n`);

  // Build read-only fields map from mutation outputs and entity configs
  const readOnlyFieldsMap = new Map<string, string[]>();
  for (const schemaOutput of schemaOutputs) {
    const entity = config.entities.find((e) => e.entityType === schemaOutput.entityType);
    if (!entity) continue;

    if (entity.readOnly) {
      // For read-only entities, all top-level fields are readonly
      const topLevelFields = extractTopLevelFieldNames(schemaOutput.schemaCode);
      if (topLevelFields.length > 0) {
        readOnlyFieldsMap.set(entity.entityType, topLevelFields);
      }
    } else {
      // For writable entities, use the mutation plugin's read-only field list
      const mutationOutput = mutationOutputs.find((m) => m.entityType === entity.entityType);
      if (mutationOutput && mutationOutput.readOnlyFields.length > 0) {
        // Only include fields that exist in the schema output
        const topLevelFields = new Set(extractTopLevelFieldNames(schemaOutput.schemaCode));
        const filteredFields = mutationOutput.readOnlyFields.filter((f) => topLevelFields.has(f));
        if (filteredFields.length > 0) {
          readOnlyFieldsMap.set(entity.entityType, filteredFields);
        }
      }
    }
  }

  // Write files
  console.log("Writing files...\n");
  writeSchemaFiles(schemaOutputs, config.serviceName, readOnlyFieldsMap);
  writeMutationFiles(mutationOutputs, config.serviceName);
  writeMetadataFile(schemaOutputs);
  writeEntityRegistryFile(config.serviceName);
  writeMainIndexFile();
  writeClaudeMd();

  // Format generated files with Prettier using the server's config
  formatGeneratedFiles();

  console.log("\nDone!");
  console.log(
    `Generated ${schemaOutputs.length} schemas and ${mutationOutputs.length} mutation sets.`,
  );
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
