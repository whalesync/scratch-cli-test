import { HttpException } from '@nestjs/common';
import type { CreateTableSpec, ValidateSchemaIssue } from '@spinner/shared-types';

/**
 * Helpers for attributing a rejected create-tables batch to the tables actually at fault (DEV-12414).
 *
 * `SchemaBuilderService.createTables` validates a whole batch up front and throws ONE
 * `BadRequestException({ issues })` when any table breaks a rule (e.g. a table over the destination's
 * `maxFieldsPerTable`). Each issue's `path` starts with the offending table's index in the request
 * (`tables[1].fields`), so the sync-draft materializer can fail just those tables — and any table linking
 * to them — and create the rest, instead of blaming every table in the batch.
 */

const TABLE_INDEX_AT_START_OF_ISSUE_PATH = /^tables\[(\d+)\]/;

/**
 * The structured create-schema issues on `error`, grouped by the index of the request table each names.
 * Null when `error` isn't a create-schema validation error carrying issues, or when any issue names no
 * table (e.g. a `fields[0].name` path) — then the batch can't be split safely and the caller fails every
 * table with the whole error, as before.
 */
export function groupCreateSchemaIssuesByTableIndex(error: unknown): Map<number, ValidateSchemaIssue[]> | null {
  if (!(error instanceof HttpException)) return null;
  const response = error.getResponse();
  if (typeof response !== 'object' || response === null) return null;
  const issues = (response as { issues?: unknown }).issues;
  if (!Array.isArray(issues) || issues.length === 0) return null;

  const issuesByTableIndex = new Map<number, ValidateSchemaIssue[]>();
  for (const issue of issues as ValidateSchemaIssue[]) {
    const tableIndexMatch = typeof issue.path === 'string' ? TABLE_INDEX_AT_START_OF_ISSUE_PATH.exec(issue.path) : null;
    if (!tableIndexMatch) return null;
    const tableIndex = Number(tableIndexMatch[1]);
    const issuesForTable = issuesByTableIndex.get(tableIndex);
    if (issuesForTable) issuesForTable.push(issue);
    else issuesByTableIndex.set(tableIndex, [issue]);
  }
  return issuesByTableIndex;
}

/**
 * Tables that can't be created because they link — by an in-batch `{ ref }` foreign key, directly or
 * through another such table — to a table that won't be created. Creating them anyway would leave that
 * foreign key pointing at nothing, so they fail too. Keyed by index in `tables`; the value is the name of
 * the uncreatable table each one links to. A table's link to itself doesn't count.
 */
export function findTablesLinkingToUncreatableTables(
  tables: CreateTableSpec[],
  uncreatableTableRefs: ReadonlySet<string>,
): Map<number, string> {
  const tableNameByRef = new Map(tables.map((table) => [table.ref, table.name]));
  const uncreatableTableNameByRef = new Map<string, string>();
  for (const ref of uncreatableTableRefs) uncreatableTableNameByRef.set(ref, tableNameByRef.get(ref) ?? ref);

  const linkedUncreatableTableNameByTableIndex = new Map<number, string>();
  let foundAnotherUncreatableTable = true;
  while (foundAnotherUncreatableTable) {
    foundAnotherUncreatableTable = false;
    tables.forEach((table, tableIndex) => {
      if (uncreatableTableNameByRef.has(table.ref)) return;
      const linkedUncreatableTableRef = table.fields
        .map((field) => inBatchForeignKeyTargetRef(field.fieldType))
        .find(
          (targetRef) => targetRef !== undefined && targetRef !== table.ref && uncreatableTableNameByRef.has(targetRef),
        );
      if (linkedUncreatableTableRef === undefined) return;
      const linkedUncreatableTableName =
        uncreatableTableNameByRef.get(linkedUncreatableTableRef) ?? linkedUncreatableTableRef;
      linkedUncreatableTableNameByTableIndex.set(tableIndex, linkedUncreatableTableName);
      uncreatableTableNameByRef.set(table.ref, table.name);
      foundAnotherUncreatableTable = true;
    });
  }
  return linkedUncreatableTableNameByTableIndex;
}

/** The sibling table ref a foreignKey field targets within the batch, if it targets one. */
function inBatchForeignKeyTargetRef(fieldType: CreateTableSpec['fields'][number]['fieldType']): string | undefined {
  if (fieldType.kind !== 'foreignKey') return undefined;
  return 'ref' in fieldType.target ? fieldType.target.ref : undefined;
}
