import fs from "node:fs";
import path from "node:path";
import { Client } from "pg";

const TEST_TABLE = "integration_blog_posts";

function getConnectionString(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  return url;
}

/**
 * Drop and recreate the integration_blog_posts table, then load test data from CSV.
 * Call this in beforeAll/beforeEach to ensure a clean state.
 */
export async function setupTestTable(): Promise<void> {
  const client = new Client({ connectionString: getConnectionString() });
  await client.connect();

  try {
    // Drop existing table
    await client.query(`DROP TABLE IF EXISTS ${TEST_TABLE} CASCADE`);

    // Create table from SQL file
    const sqlPath = path.resolve(__dirname, "../test_table_blog_posts.sql");
    const createSql = fs.readFileSync(sqlPath, "utf-8");
    await client.query(createSql);

    // Load test data from CSV
    const csvPath = path.resolve(__dirname, "../test_data_blog_posts.csv");
    const csvContent = fs.readFileSync(csvPath, "utf-8");
    const rows = parseCSV(csvContent);

    for (const row of rows) {
      await client.query(
        `INSERT INTO ${TEST_TABLE} (post_id, title, content, created_dt, updated_dt, author, publish_status)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          row.post_id,
          row.title,
          row.content,
          row.created_dt,
          row.updated_dt,
          row.author,
          row.publish_status,
        ],
      );
    }

    // Verify data was loaded
    const count = await client.query(
      `SELECT COUNT(*) AS cnt FROM ${TEST_TABLE}`,
    );
    const rowCount = parseInt(count.rows[0].cnt, 10);
    if (rowCount !== rows.length) {
      throw new Error(
        `Expected ${rows.length} rows in ${TEST_TABLE} but found ${rowCount}`,
      );
    }
    console.log(`[postgres] ${TEST_TABLE}: ${rowCount} rows loaded`);
  } finally {
    await client.end();
  }
}

/**
 * Drop the integration_blog_posts table. Call this in afterAll for cleanup.
 */
export async function teardownTestTable(): Promise<void> {
  const client = new Client({ connectionString: getConnectionString() });
  await client.connect();

  try {
    await client.query(`DROP TABLE IF EXISTS ${TEST_TABLE} CASCADE`);
  } finally {
    await client.end();
  }
}

const PRODUCTS_TABLE = "integration_products";

/**
 * Drop and recreate the integration_products table, then load test data.
 */
export async function setupProductsTable(): Promise<void> {
  const client = new Client({ connectionString: getConnectionString() });
  await client.connect();

  try {
    await client.query(`DROP TABLE IF EXISTS ${PRODUCTS_TABLE} CASCADE`);

    const sqlPath = path.resolve(__dirname, "../test_table_products.sql");
    const createSql = fs.readFileSync(sqlPath, "utf-8");
    await client.query(createSql);

    // Insert test data directly
    const rows = [
      ["Widget A", 19.99, "widgets"],
      ["Widget B", 29.99, "widgets"],
      ["Gadget X", 49.99, "gadgets"],
    ];
    for (const [name, price, category] of rows) {
      await client.query(
        `INSERT INTO ${PRODUCTS_TABLE} (name, price, category) VALUES ($1, $2, $3)`,
        [name, price, category],
      );
    }

    const count = await client.query(
      `SELECT COUNT(*) AS cnt FROM ${PRODUCTS_TABLE}`,
    );
    console.log(
      `[postgres] ${PRODUCTS_TABLE}: ${count.rows[0].cnt} rows loaded`,
    );
  } finally {
    await client.end();
  }
}

/**
 * Drop the integration_products table.
 */
export async function teardownProductsTable(): Promise<void> {
  const client = new Client({ connectionString: getConnectionString() });
  await client.connect();

  try {
    await client.query(`DROP TABLE IF EXISTS ${PRODUCTS_TABLE} CASCADE`);
  } finally {
    await client.end();
  }
}

interface BlogPostRow {
  post_id: string;
  title: string;
  content: string;
  created_dt: string;
  updated_dt: string;
  author: string;
  publish_status: string;
}

/**
 * Simple CSV parser that handles quoted fields with embedded newlines.
 */
function parseCSV(content: string): BlogPostRow[] {
  const rows: BlogPostRow[] = [];
  const lines = content.split("\n");

  // Skip header
  let i = 1;
  while (i < lines.length) {
    const fields: string[] = [];
    let remaining = lines[i];

    while (fields.length < 7) {
      if (remaining.startsWith('"')) {
        // Quoted field — may span multiple lines
        let value = remaining.slice(1);
        remaining = "";

        while (!value.includes('"')) {
          i++;
          if (i >= lines.length) break;
          value += "\n" + lines[i];
        }

        const endQuote = value.indexOf('"');
        fields.push(value.slice(0, endQuote));
        remaining = value.slice(endQuote + 1);

        // Skip comma separator
        if (remaining.startsWith(",")) {
          remaining = remaining.slice(1);
        }
      } else {
        // Unquoted field
        const comma = remaining.indexOf(",");
        if (comma === -1) {
          fields.push(remaining);
          remaining = "";
        } else {
          fields.push(remaining.slice(0, comma));
          remaining = remaining.slice(comma + 1);
        }
      }
    }

    if (fields.length === 7 && fields[0]) {
      rows.push({
        post_id: fields[0],
        title: fields[1],
        content: fields[2],
        created_dt: fields[3],
        updated_dt: fields[4],
        author: fields[5],
        publish_status: fields[6],
      });
    }

    i++;
  }

  return rows;
}
