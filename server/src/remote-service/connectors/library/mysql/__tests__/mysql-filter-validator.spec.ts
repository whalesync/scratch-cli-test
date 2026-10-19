import { MySqlClientError, MySqlClientProblem } from '../mysql-client-error';
import { MYSQL_FILTER_MAX_LENGTH, validateMySqlWhereFilter } from '../mysql-filter-validator';

function captureFilterRejection(filter: string): MySqlClientError {
  try {
    validateMySqlWhereFilter(filter);
  } catch (error) {
    if (error instanceof MySqlClientError) return error;
    throw error;
  }
  throw new Error(`Expected the filter to be rejected: ${JSON.stringify(filter)}`);
}

describe('validateMySqlWhereFilter', () => {
  describe('accepts ordinary filters', () => {
    it.each([
      "status = 'active'",
      'a = 1 OR b = 2',
      "name = 'it''s'",
      '`weird col` = 1',
      "FIND_IN_SET('a', tags) > 0",
      "REPLACE(name,'a','b') = 'x'",
      'x IN (1,2)',
      'x IN (1.5, 2.5)',
      'price BETWEEN 1.5 AND 2.5',
      "name LIKE 'A%' AND deleted_at IS NULL",
      "created_at >= '2026-01-01' AND (stage = 'lead' OR stage = 'won')",
      "doc->>'$.status' = 'open'",
      "JSON_EXTRACT(doc, '$.a') = 1",
      "LOWER(user) = 'root'",
      "`db.col` = 1 AND `Certified AS Organic` = 'yes'",
      "stage = 'lead'\n\tAND amount > 10\r\n",
      '`created_at` > NOW() - INTERVAL 7 DAY',
    ])('%j', (filter) => {
      expect(() => validateMySqlWhereFilter(filter)).not.toThrow();
    });
  });

  describe('judges character and keyword rules on the unquoted skeleton only', () => {
    it.each([
      ["email = 'a@b.com'", '@ inside a literal'],
      ["sku = 'A#1'", '# inside a literal'],
      ["note = 'please update'", 'a keyword inside a literal'],
      ["note = 'a -- b /* c */ ; d'", 'comment and statement markers inside a literal'],
      ["note = 'call sleep(5) := now'", 'a denied function and := inside a literal'],
      ['`set` = 1', 'a keyword used as a backtick-quoted column name'],
      ['`we``ird` = 1', 'a doubled backtick inside an identifier'],
      ["`a@b` = 'x'", '@ inside a quoted identifier'],
      ["note = '(' AND `)` = 1", 'parentheses inside quotes do not count'],
    ])('%j (%s)', (filter) => {
      expect(() => validateMySqlWhereFilter(filter)).not.toThrow();
    });
  });

  it('treats a blank filter as no filter', () => {
    expect(() => validateMySqlWhereFilter('')).not.toThrow();
    expect(() => validateMySqlWhereFilter('   \n')).not.toThrow();
  });

  it('accepts a filter of exactly the maximum length', () => {
    const filterAtMaximumLength = `a = '${'x'.repeat(MYSQL_FILTER_MAX_LENGTH - 6)}'`;
    expect(filterAtMaximumLength).toHaveLength(MYSQL_FILTER_MAX_LENGTH);
    expect(() => validateMySqlWhereFilter(filterAtMaximumLength)).not.toThrow();
  });

  describe('rejects', () => {
    it.each<[string, string, RegExp]>([
      ['a filter over the length limit', `a = '${'x'.repeat(MYSQL_FILTER_MAX_LENGTH)}'`, /too long/],
      ['a NUL character', 'a = 1\u0000', /control character/],
      ['the identifier-encoding sentinel U+0001', "a = '\u0001'", /control character/],
      ['an escape character', 'a = 1\u001b', /control character/],
      ['DEL', 'a = 1\u007f', /control character/],
      ['a C1 control character', 'a = 1\u0085', /control character/],
      ['an unquoted ?', 'a = ?', /"\?"/],
      ['a ? inside a single-quoted literal', "name = 'a?b'", /"\?"/],
      ['a ? inside a backtick-quoted identifier', '`Featured?` = 1', /"\?"/],
      ['a ? inside a double-quoted string', 'name = "a?b"', /"\?"/],
      ['a double-quoted string', 'name = "it\'s"', /double quotes/],
      ['a backslash escape', "name = 'it\\'s'", /backslash/],
      ['an unterminated literal', "name = 'abc", /closing single quote/],
      ['a literal left open by a doubled quote', "name = 'it''s", /closing single quote/],
      ['an unterminated identifier', '`abc = 1', /closing backtick/],
      ['a statement separator', 'a = 1; DROP TABLE t', /";"/],
      ['a # comment', 'a = 1 # rest', /comments/],
      ['a -- comment', 'a = 1 -- rest', /comments/],
      ['a /* comment */', 'a = 1 /* rest */', /comments/],
      ['an executable comment', 'a = 1 /*!50000 OR 1=1 */', /comments/],
      ['a stray */', 'a = 1 */', /comments/],
      ['a user variable', 'a = @x', /variables/],
      ['a system variable', 'a = @@version', /variables/],
      ['an assignment', 'a := 1', /assignments/],
      ['a filter that closes the wrapping parenthesis', '1=1) OR (1=1', /unbalanced parentheses/],
      ['an unclosed parenthesis', '(a = 1', /unbalanced parentheses/],
      ['an extra closing parenthesis', 'a = 1)', /unbalanced parentheses/],
      ['parentheses closed before they are opened', ')(', /unbalanced parentheses/],
      ['a call through a backtick-quoted name', '`sleep`(1) = 0', /quoted name/],
      ['a call through a backtick-quoted name with a space', '`sleep` (1) = 0', /quoted name/],
      ['a call through a qualified backtick-quoted name', '`db`.`fn`(1) = 0', /quoted name/],
      ['a database-qualified stored function', 'other_db.fn(1) = 1', /stored in a database/],
      ['a partly quoted database-qualified function', '`db`.fn (1) = 1', /stored in a database/],
      ['NEXT VALUE FOR', 'id = NEXT VALUE FOR s', /sequence/],
      ['PREVIOUS VALUE FOR across lines', 'id = PREVIOUS  VALUE\nFOR s', /sequence/],
      ['a subquery', 'id IN (SELECT id FROM t)', /keyword SELECT/],
      ['a MySQL 8 TABLE subquery', 'id IN (TABLE secrets)', /keyword TABLE/],
      ['UNION', 'a = 1 UNION SELECT 1', /keyword UNION/],
      ['an unquoted keyword used as a column name', 'update = 1', /keyword UPDATE.*`update`/],
      ['INTO OUTFILE', "a = 1 INTO OUTFILE '/tmp/x'", /keyword INTO/],
      ['SHOW', 'SHOW = 1', /keyword SHOW/],
      ['CURRENT_USER without parentheses', "CURRENT_USER = 'root@%'", /keyword CURRENT_USER/],
      ['INSERT, even as the string function (Postgres list parity)', "INSERT(name, 1, 1, 'x') = 'y'", /keyword INSERT/],
      ['SLEEP', 'SLEEP(1) = 0', /SLEEP\(\)/],
      ['SLEEP with a space before the parenthesis', 'SLEEP (1) = 0', /SLEEP\(\)/],
      ['sleep with a newline before the parenthesis', 'sleep\n(1) = 0', /SLEEP\(\)/],
      ['BENCHMARK', "BENCHMARK(1000000, MD5('a')) = 0", /BENCHMARK\(\)/],
      ['LOAD_FILE', "LOAD_FILE('/etc/passwd') IS NOT NULL", /LOAD_FILE\(\)/],
      ['GET_LOCK', "GET_LOCK('x', 10) = 1", /GET_LOCK\(\)/],
      ['USER()', "user() = 'root'", /USER\(\)/],
      ['VERSION()', "version() LIKE '8%'", /VERSION\(\)/],
      ['DATABASE()', "database() = 'x'", /DATABASE\(\)/],
      ['EXTRACTVALUE (error-based exfiltration)', "EXTRACTVALUE(1, 'x') = 1", /EXTRACTVALUE\(\)/],
      ['MariaDB NEXTVAL', 'NEXTVAL(s) > 0', /NEXTVAL\(\)/],
      ['MariaDB SETVAL', 'SETVAL(s, 1) > 0', /SETVAL\(\)/],
      ['MariaDB LASTVAL', 'LASTVAL(s) > 0', /LASTVAL\(\)/],
      [
        'a group replication administration function',
        "group_replication_set_as_primary('x') = 1",
        /GROUP_REPLICATION_SET_AS_PRIMARY\(\)/,
      ],
      ['a keyring function', "keyring_key_fetch('k') IS NOT NULL", /KEYRING_KEY_FETCH\(\)/],
    ])('%s', (_description, filter, expectedMessagePattern) => {
      const rejection = captureFilterRejection(filter);
      expect(rejection.problem).toBe(MySqlClientProblem.InvalidFilter);
      expect(rejection.userFriendlyMessage).toMatch(expectedMessagePattern);
      expect(rejection.message).toBe(rejection.userFriendlyMessage);
    });
  });

  it('never lets a quoted span hide structure outside it', () => {
    expect(captureFilterRejection("note = 'x') OR (1=1").userFriendlyMessage).toMatch(/unbalanced parentheses/);
    expect(captureFilterRejection("note = 'x' -- trailing").userFriendlyMessage).toMatch(/comments/);
    // A comment marker split around a literal is still a comment marker in the skeleton (conservative).
    expect(captureFilterRejection("'a'--'b'").userFriendlyMessage).toMatch(/comments/);
  });

  it('never echoes more of the filter than the matched keyword or function name', () => {
    const rejection = captureFilterRejection("secret_column = 'hunter2' AND SLEEP(1) = 0");
    expect(rejection.userFriendlyMessage).not.toContain('hunter2');
    expect(rejection.userFriendlyMessage).not.toContain('secret_column');
  });
});
