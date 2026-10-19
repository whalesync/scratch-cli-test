import { WSLogger } from 'src/logger';
import { ConnectorAuthError, isUserFriendlyError } from '../../../error';
import { Service } from '../../../service-constants';
import {
  MYSQL_UNEXPECTED_CREDENTIAL_PARSING_FAILURE_MESSAGE,
  MySqlCredentialProblem,
  MySqlCredentialsInvalidError,
  mySqlConnectionStringParameterNameLooksLikeAnOptionName,
  runMySqlCredentialParsingWithSafeErrors,
} from '../mysql-credential-errors';

describe('MySqlCredentialsInvalidError', () => {
  it('is a ConnectorAuthError (→ HTTP 400) whose message IS the user-facing message', () => {
    const credentialsInvalidError = new MySqlCredentialsInvalidError(
      MySqlCredentialProblem.PortInvalid,
      'Port must be a whole number from 1 to 65535.',
    );

    expect(credentialsInvalidError).toBeInstanceOf(ConnectorAuthError);
    expect(credentialsInvalidError).toBeInstanceOf(Error);
    expect(isUserFriendlyError(credentialsInvalidError)).toBe(true);
    expect(credentialsInvalidError.message).toBe('Port must be a whole number from 1 to 65535.');
    expect(credentialsInvalidError.userFriendlyMessage).toBe(credentialsInvalidError.message);
    expect(credentialsInvalidError.problem).toBe(MySqlCredentialProblem.PortInvalid);
    expect(credentialsInvalidError.service).toBe(Service.MYSQL);
    expect(credentialsInvalidError.name).toBe('MySqlCredentialsInvalidError');
    expect(credentialsInvalidError.cause).toBeUndefined();
  });
});

describe('runMySqlCredentialParsingWithSafeErrors', () => {
  let wsLoggerErrorSpy: jest.SpyInstance;

  beforeEach(() => {
    wsLoggerErrorSpy = jest.spyOn(WSLogger, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    wsLoggerErrorSpy.mockRestore();
  });

  it('returns the parse result', () => {
    expect(runMySqlCredentialParsingWithSafeErrors(() => 42)).toBe(42);
    expect(wsLoggerErrorSpy).not.toHaveBeenCalled();
  });

  it('rethrows a MySqlCredentialsInvalidError unchanged', () => {
    const credentialsInvalidError = new MySqlCredentialsInvalidError(MySqlCredentialProblem.HostInvalid, 'bad host');
    let caughtError: unknown;
    try {
      runMySqlCredentialParsingWithSafeErrors(() => {
        throw credentialsInvalidError;
      });
    } catch (error) {
      caughtError = error;
    }
    expect(caughtError).toBe(credentialsInvalidError);
    expect(wsLoggerErrorSpy).not.toHaveBeenCalled();
  });

  it.each<[string, unknown]>([
    ['a TypeError quoting the input', new TypeError('Cannot read S3cr3tSentinel of undefined')],
    ['a SyntaxError from JSON.parse', new SyntaxError('Unexpected token S3cr3tSentinel in JSON')],
    ['a thrown string', 'S3cr3tSentinel'],
    ['a foreign ConnectorAuthError', new ConnectorAuthError('S3cr3tSentinel', 'S3cr3tSentinel', 'OTHER')],
  ])('wraps %s as a safe Unexpected error and logs only its class', (_description, unexpectedThrownValue) => {
    let caughtError: unknown;
    try {
      runMySqlCredentialParsingWithSafeErrors(() => {
        throw unexpectedThrownValue;
      });
    } catch (error) {
      caughtError = error;
    }

    expect(caughtError).toBeInstanceOf(MySqlCredentialsInvalidError);
    const wrappedError = caughtError as MySqlCredentialsInvalidError;
    expect(wrappedError.problem).toBe(MySqlCredentialProblem.Unexpected);
    expect(wrappedError.message).toBe(MYSQL_UNEXPECTED_CREDENTIAL_PARSING_FAILURE_MESSAGE);
    expect(wrappedError.userFriendlyMessage).toBe(MYSQL_UNEXPECTED_CREDENTIAL_PARSING_FAILURE_MESSAGE);
    expect(wrappedError.cause).toBeUndefined();
    expect(wrappedError.stack ?? '').not.toContain('S3cr3tSentinel');

    expect(wsLoggerErrorSpy).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(wsLoggerErrorSpy.mock.calls)).not.toContain('S3cr3tSentinel');
  });
});

describe('mySqlConnectionStringParameterNameLooksLikeAnOptionName', () => {
  it.each([
    ['serverTimezone', true],
    ['ssl-mode', true],
    ['a.b_c-d', true],
    ['x'.repeat(40), true],
    ['', false],
    ['has space', false],
    ['p@ssw0rd!', false],
    ['x'.repeat(41), false],
  ])('reads %j as %s', (parameterName, expectedLooksLikeAnOptionName) => {
    expect(mySqlConnectionStringParameterNameLooksLikeAnOptionName(parameterName)).toBe(expectedLooksLikeAnOptionName);
  });
});
