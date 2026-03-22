import { ColumnRefItem, Parser, Select } from 'node-sql-parser';

export class InvalidSqlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidSqlError';
  }
}

/**
 * Validates a SQL WHERE clause string against strict security and syntax rules.
 *
 * This utility was constructed by Gemini and revised by Cursor.
 *
 * [node-sql-parser](https://github.com/taozhi8833998/node-sql-parser) is the underlying library used to parse the SQL.
 *
 * The types in the node-sql-parser are a bit messy and cause all kind of linter challenges,
 * so there is a lot of extra type checking and casting going on
 *
 * @param whereClause - The string representing the WHERE condition (e.g., "id = 1 AND status = 'active'")
 * @throws InvalidSqlError if any validation rule is violated
 */
export function validateWhereClause(
  whereClause: string,
  databaseSyntax: 'postgresql' | 'mysql' | 'sqlite' = 'postgresql',
): void {
  // 1. Basic sanity check for empty strings
  if (!whereClause || whereClause.trim().length === 0) {
    throw new InvalidSqlError('WHERE clause cannot be empty.');
  }

  // 2. Wrap the clause in a dummy SELECT statement.
  // Most parsers require a full statement to validate syntax correctly.
  const dummyQuery = `SELECT * FROM validation_table WHERE ${whereClause}`;

  const parser = new Parser();
  let astResult;

  // 3. Syntax Validation
  try {
    astResult = parser.astify(dummyQuery, { database: databaseSyntax });
  } catch (error) {
    throw new InvalidSqlError(
      `Syntax Error: The provided WHERE clause is not valid SQL. ${error instanceof Error ? error.message : 'Unknown error'}`,
    );
  }

  // 4. SQL Injection Check: Stacked Queries
  // If the parser returns an array, it means multiple statements were found (e.g., "x=1; DROP TABLE y")
  if (Array.isArray(astResult)) {
    if (astResult.length > 1) {
      throw new InvalidSqlError('Security Violation: Multiple statements (Stacked Queries) detected.');
    }
    astResult = astResult[0];
  }

  if (!astResult) {
    throw new InvalidSqlError('Unable to parse a single statement from the WHERE clause');
  }

  // Try to cast the AST result to a Select statement as we are expecting a `type` property in the node
  const selectStmt = astResult as Select;

  // Type guard to ensure we are looking at a select statement (which we created)
  if (selectStmt.type !== 'select') {
    throw new InvalidSqlError('Unable to parse logic structure');
  }

  // 5. Recursive AST Inspection
  // We strictly inspect the 'where' portion of the AST
  if (!selectStmt.where) {
    // This happens if the input was just whitespace or comments that the parser stripped out
    throw new InvalidSqlError('Clause provided resulted in no executable logic');
  }

  traverseAst(selectStmt.where);
}

/**
 * Type guard to check if an object has a 'type' property that is a string.
 */
function hasStringType(obj: unknown): obj is { type: string } {
  return (
    typeof obj === 'object' && obj !== null && 'type' in obj && typeof (obj as { type: unknown }).type === 'string'
  );
}

/**
 * Recursively walks the Abstract Syntax Tree to enforce specific rules.
 */
function traverseAst(node: unknown): void {
  if (!node || typeof node !== 'object') {
    return;
  }

  // --- Rule: No Subqueries involving Modification (INSERT, UPDATE, DELETE) ---
  // The parser identifies statement types. If we find a nested statement that is not a SELECT, reject it.
  // Note: We allow nested SELECTs for read-only subqueries, unless they violate table rules below.
  const forbiddenTypes = ['insert', 'update', 'delete', 'truncate', 'create', 'drop', 'alter'];
  if (hasStringType(node) && forbiddenTypes.includes(node.type.toLowerCase())) {
    throw new InvalidSqlError(`Security Violation: Subquery contains a forbidden statement type '${node.type}'.`);
  }

  // --- Rule: No Referencing Other Tables or Schemas ---
  // In node-sql-parser, a column reference looks like:
  // { type: 'column_ref', table: 'tableName', column: 'colName' }
  // If 'table' is not null, it means a qualifier was used (e.g., 'users.id' or 'public.users.id').
  if (hasStringType(node) && node.type === 'column_ref') {
    const columnRef = node as ColumnRefItem;
    if (columnRef.table !== null) {
      const columnName = typeof columnRef.column === 'string' ? columnRef.column : '?';
      throw new InvalidSqlError(
        `Scope Violation: References to other tables or schemas are not allowed. Found: '${columnRef.table}.${columnName}'`,
      );
    }
  }

  // --- Recursive Traversal ---
  // Depending on the node type, children might be stored in different properties.
  // We iterate over all object keys to ensure we catch every nested expression.
  const record = node as Record<string, unknown>;
  for (const key in record) {
    if (!Object.prototype.hasOwnProperty.call(record, key)) {
      continue;
    }
    const child = record[key];

    if (Array.isArray(child)) {
      child.forEach((c: unknown) => traverseAst(c));
    } else if (child && typeof child === 'object') {
      traverseAst(child);
    }
  }
}
