import knex from 'knex';
import {
  isKnexQueryCompilationError,
  knexQueryCompilationErrorDetails,
  KnexQueryCompilationErrorWithSqlText,
  runKnexRawStatementTaggingCompilationErrorWithSqlText,
} from '../pg-knex-query-compilation-error';

const connectionlessPgKnex = knex({ client: 'pg' });

/** The UPDATE shape that failed in production: a `?` column name inlined into `knex.raw` unescaped. */
const UPDATE_SQL_TEXT_WITH_UNESCAPED_QUESTION_MARK_COLUMN = `
  UPDATE "public"."contacts" AS t
  SET "Decisionmaker?" = v."Decisionmaker?"
  FROM json_populate_recordset(null::"public"."contacts", ?::json) AS v
  WHERE t."id" = v."id"
  RETURNING t.*
`;

function errorThrownBy(compileQuery: () => unknown): unknown {
  try {
    compileQuery();
  } catch (error) {
    return error;
  }
  throw new Error('expected the query to fail to compile');
}

describe('isKnexQueryCompilationError', () => {
  it('recognizes the binding-count mismatch knex.raw throws for a bare `?` in an inlined identifier', () => {
    const bindingCountMismatchError = errorThrownBy(() =>
      connectionlessPgKnex.raw(UPDATE_SQL_TEXT_WITH_UNESCAPED_QUESTION_MARK_COLUMN, ['[]']).toSQL(),
    );
    expect(bindingCountMismatchError).toBeInstanceOf(Error);
    expect((bindingCountMismatchError as Error).message).toBe('Expected 1 bindings, saw 3');
    expect(isKnexQueryCompilationError(bindingCountMismatchError)).toBe(true);
  });

  it('recognizes the undefined-binding error knex throws for an undefined where value', () => {
    const undefinedBindingError = errorThrownBy(() =>
      connectionlessPgKnex('records')
        .where('id', undefined as unknown as string)
        .toSQL(),
    );
    expect(isKnexQueryCompilationError(undefinedBindingError)).toBe(true);
  });

  it('does not match Postgres or connection errors', () => {
    expect(isKnexQueryCompilationError(new Error('relation "records" does not exist'))).toBe(false);
    expect(isKnexQueryCompilationError(new Error('Knex: Timeout acquiring a connection.'))).toBe(false);
    expect(isKnexQueryCompilationError('Expected 1 bindings, saw 3')).toBe(false);
  });
});

describe('runKnexRawStatementTaggingCompilationErrorWithSqlText', () => {
  it('re-throws a compilation failure tagged with the SQL text it was compiling', async () => {
    const statementRun = runKnexRawStatementTaggingCompilationErrorWithSqlText(
      UPDATE_SQL_TEXT_WITH_UNESCAPED_QUESTION_MARK_COLUMN,
      () =>
        Promise.resolve(connectionlessPgKnex.raw(UPDATE_SQL_TEXT_WITH_UNESCAPED_QUESTION_MARK_COLUMN, ['[]']).toSQL()),
    );

    await expect(statementRun).rejects.toBeInstanceOf(KnexQueryCompilationErrorWithSqlText);
    await expect(statementRun).rejects.toMatchObject({
      message: 'Expected 1 bindings, saw 3',
      sqlText: UPDATE_SQL_TEXT_WITH_UNESCAPED_QUESTION_MARK_COLUMN,
    });
  });

  it('passes every other error through untouched', async () => {
    const postgresError = Object.assign(new Error('column "Lead Source " does not exist'), { code: '42703' });

    await expect(
      runKnexRawStatementTaggingCompilationErrorWithSqlText('UPDATE …', () => Promise.reject(postgresError)),
    ).rejects.toBe(postgresError);
  });

  it('returns the statement result when it succeeds', async () => {
    await expect(
      runKnexRawStatementTaggingCompilationErrorWithSqlText('SELECT 1', () => Promise.resolve({ rows: [1] })),
    ).resolves.toEqual({ rows: [1] });
  });
});

describe('knexQueryCompilationErrorDetails', () => {
  it('says the SQL query could not be compiled and keeps the knex message for debugging', () => {
    const bindingCountMismatchError = new Error('Expected 1 bindings, saw 3');

    const errorDetails = knexQueryCompilationErrorDetails(bindingCountMismatchError);

    expect(errorDetails.userFriendlyMessage).toBe('The SQL query for this change could not be compiled.');
    expect(errorDetails.description).toBe('Expected 1 bindings, saw 3');
    expect(errorDetails.additionalContext).toEqual({ errorName: 'Error', stack: bindingCountMismatchError.stack });
  });

  it('shows the tagged SQL text on one line, and keeps the knex stack', () => {
    const bindingCountMismatchError = new Error('Expected 1 bindings, saw 3');
    const taggedError = new KnexQueryCompilationErrorWithSqlText(
      bindingCountMismatchError,
      UPDATE_SQL_TEXT_WITH_UNESCAPED_QUESTION_MARK_COLUMN,
    );

    const errorDetails = knexQueryCompilationErrorDetails(taggedError);

    const singleLineSqlText =
      'UPDATE "public"."contacts" AS t SET "Decisionmaker?" = v."Decisionmaker?" FROM json_populate_recordset(null::"public"."contacts", ?::json) AS v WHERE t."id" = v."id" RETURNING t.*';
    expect(errorDetails.userFriendlyMessage).toBe(
      `The SQL query for this change could not be compiled: ${singleLineSqlText}`,
    );
    expect(errorDetails.description).toBe('Expected 1 bindings, saw 3');
    expect(errorDetails.additionalContext).toEqual({
      errorName: 'Error',
      stack: bindingCountMismatchError.stack,
      sqlText: singleLineSqlText,
    });
  });

  it('reads the SQL text knex appends to an undefined-binding error', () => {
    const undefinedBindingError = errorThrownBy(() =>
      connectionlessPgKnex('records')
        .where('id', undefined as unknown as string)
        .toSQL(),
    ) as Error;

    const errorDetails = knexQueryCompilationErrorDetails(undefinedBindingError);

    expect(errorDetails.userFriendlyMessage).toBe(
      'The SQL query for this change could not be compiled: select * from "records" where "id" = ?',
    );
  });

  it('middle-elides a long SQL text in the user-facing message but keeps all of it in the context', () => {
    const manyColumnSetClause = Array.from({ length: 200 }, (_, index) => `"col ${index}" = v."col ${index}"`).join(
      ', ',
    );
    const longSqlText = `UPDATE "public"."contacts" AS t SET ${manyColumnSetClause} WHERE t."id" = v."id"`;

    const errorDetails = knexQueryCompilationErrorDetails(
      new KnexQueryCompilationErrorWithSqlText(new Error('Expected 1 bindings, saw 3'), longSqlText),
    );

    const shownSqlText = errorDetails.userFriendlyMessage.replace(
      'The SQL query for this change could not be compiled: ',
      '',
    );
    expect(shownSqlText).toHaveLength(500);
    expect(shownSqlText.startsWith('UPDATE "public"."contacts" AS t SET "col 0"')).toBe(true);
    expect(shownSqlText.endsWith('WHERE t."id" = v."id"')).toBe(true);
    expect(shownSqlText).toContain('…');
    expect(errorDetails.additionalContext?.sqlText).toBe(longSqlText);
  });
});
