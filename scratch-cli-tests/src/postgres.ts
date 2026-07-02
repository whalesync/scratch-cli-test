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
 * Set up `integration_products` for incremental-pull tests.
 *
 * Loads the schema (`test_table_products.sql`) and rows
 * (`test_data_products.sql`), then **backdates every row's `created_dt` /
 * `updated_dt` to a fixed point well in the past** (`2020-01-01`).
 *
 * The backdating is essential, not cosmetic. The Postgres connector's
 * incremental predicate is `WHERE updated_dt > (since - 60s)` (a 60s
 * clock-skew margin — `PG_INCREMENTAL_CLOCK_SKEW_MS`). `test_data_products.sql`
 * inserts rows with `updated_dt = CURRENT_TIMESTAMP`, so without backdating the
 * un-edited rows would fall inside the first incremental pull's skew window
 * (their `updated_dt` is only seconds older than the full-pull watermark) and
 * the "exactly one row changed" assertion would see all five. Pinning them to
 * 2020 puts them safely below `watermark - 60s` so only the row we explicitly
 * touch in the test is returned.
 */
export async function setupIncrementalProductsTable(): Promise<void> {
  const client = new Client({ connectionString: getConnectionString() });
  await client.connect();

  try {
    await client.query(`DROP TABLE IF EXISTS ${PRODUCTS_TABLE} CASCADE`);

    const schemaSql = fs.readFileSync(
      path.resolve(__dirname, "../test_table_products.sql"),
      "utf-8",
    );
    await client.query(schemaSql);

    const dataSql = fs.readFileSync(
      path.resolve(__dirname, "../test_data_products.sql"),
      "utf-8",
    );
    await client.query(dataSql);

    // Backdate so the seeded rows sit outside the incremental clock-skew window.
    await client.query(
      `UPDATE ${PRODUCTS_TABLE}
         SET created_dt = TIMESTAMP '2020-01-01 00:00:00',
             updated_dt = TIMESTAMP '2020-01-01 00:00:00'`,
    );

    const count = await client.query(
      `SELECT COUNT(*) AS cnt FROM ${PRODUCTS_TABLE}`,
    );
    const rowCount = parseInt(count.rows[0].cnt, 10);
    if (rowCount !== 5) {
      throw new Error(
        `Expected 5 rows in ${PRODUCTS_TABLE} but found ${rowCount}`,
      );
    }
    console.log(
      `[postgres] ${PRODUCTS_TABLE}: ${rowCount} rows loaded (backdated to 2020-01-01)`,
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

const AUTHORS_TABLE = "integration_authors";

/**
 * Fixed author IDs the publish-failure test references by hand so it can
 * target the same row across the edit / publish / verify steps without
 * having to discover the UUID from the worktree.
 */
export const AUTHOR_IDS = {
  alice: "11111111-1111-1111-1111-111111111111",
  bob: "22222222-2222-2222-2222-222222222222",
  carol: "33333333-3333-3333-3333-333333333333",
} as const;

/**
 * Drop and recreate `integration_authors` (a VARCHAR(20)-constrained table)
 * and seed three rows with deterministic UUIDs. Used by the publish-failure
 * test that pushes a >20-character name to provoke a connector-level error.
 */
export async function setupAuthorsTable(): Promise<void> {
  const client = new Client({ connectionString: getConnectionString() });
  await client.connect();

  try {
    await client.query(`DROP TABLE IF EXISTS ${AUTHORS_TABLE} CASCADE`);

    const sqlPath = path.resolve(__dirname, "../test_table_authors.sql");
    const createSql = fs.readFileSync(sqlPath, "utf-8");
    await client.query(createSql);

    const rows: Array<[string, string, string]> = [
      [AUTHOR_IDS.alice, "Alice", "Novelist from Seattle"],
      [AUTHOR_IDS.bob, "Bob", "Tech writer"],
      [AUTHOR_IDS.carol, "Carol", "Poet"],
    ];
    for (const [author_id, name, bio] of rows) {
      await client.query(
        `INSERT INTO ${AUTHORS_TABLE} (author_id, name, bio) VALUES ($1, $2, $3)`,
        [author_id, name, bio],
      );
    }

    const count = await client.query(
      `SELECT COUNT(*) AS cnt FROM ${AUTHORS_TABLE}`,
    );
    const rowCount = parseInt(count.rows[0].cnt, 10);
    if (rowCount !== rows.length) {
      throw new Error(
        `Expected ${rows.length} rows in ${AUTHORS_TABLE} but found ${rowCount}`,
      );
    }
    console.log(`[postgres] ${AUTHORS_TABLE}: ${rowCount} rows loaded`);
  } finally {
    await client.end();
  }
}

/** Drop the integration_authors table. */
export async function teardownAuthorsTable(): Promise<void> {
  const client = new Client({ connectionString: getConnectionString() });
  await client.connect();

  try {
    await client.query(`DROP TABLE IF EXISTS ${AUTHORS_TABLE} CASCADE`);
  } finally {
    await client.end();
  }
}

const REVIEWS_TABLE = "integration_reviews";

/**
 * Fixed review IDs the multi-folder connector-scoped publish test references by
 * hand, so it can target the same row across edit / publish / verify steps
 * without discovering the UUID from the worktree.
 */
export const REVIEW_IDS = {
  first: "44444444-4444-4444-4444-444444444444",
  second: "55555555-5555-5555-5555-555555555555",
} as const;

/**
 * Drop and recreate `integration_reviews` and seed two rows with deterministic
 * UUIDs. A second, unconstrained table so a connection can map MULTIPLE data
 * folders alongside `integration_authors` (DEV-10596 lifecycle suite).
 */
export async function setupReviewsTable(): Promise<void> {
  const client = new Client({ connectionString: getConnectionString() });
  await client.connect();

  try {
    await client.query(`DROP TABLE IF EXISTS ${REVIEWS_TABLE} CASCADE`);

    const sqlPath = path.resolve(__dirname, "../test_table_reviews.sql");
    const createSql = fs.readFileSync(sqlPath, "utf-8");
    await client.query(createSql);

    const rows: Array<[string, string, number, string]> = [
      [REVIEW_IDS.first, "Great product", 5, "Loved every bit of it"],
      [REVIEW_IDS.second, "It was fine", 3, "Decent value for money"],
    ];
    for (const [review_id, title, rating, body] of rows) {
      await client.query(
        `INSERT INTO ${REVIEWS_TABLE} (review_id, title, rating, body) VALUES ($1, $2, $3, $4)`,
        [review_id, title, rating, body],
      );
    }

    const count = await client.query(
      `SELECT COUNT(*) AS cnt FROM ${REVIEWS_TABLE}`,
    );
    const rowCount = parseInt(count.rows[0].cnt, 10);
    if (rowCount !== rows.length) {
      throw new Error(
        `Expected ${rows.length} rows in ${REVIEWS_TABLE} but found ${rowCount}`,
      );
    }
    console.log(`[postgres] ${REVIEWS_TABLE}: ${rowCount} rows loaded`);
  } finally {
    await client.end();
  }
}

/** Drop the integration_reviews table. */
export async function teardownReviewsTable(): Promise<void> {
  const client = new Client({ connectionString: getConnectionString() });
  await client.connect();

  try {
    await client.query(`DROP TABLE IF EXISTS ${REVIEWS_TABLE} CASCADE`);
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
