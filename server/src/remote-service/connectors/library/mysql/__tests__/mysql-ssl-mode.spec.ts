import { MySqlCredentialProblem, MySqlCredentialsInvalidError } from '../mysql-credential-errors';
import {
  isVerifyingMySqlSslMode,
  mapMySqlSslModeSpellingToSslMode,
  MYSQL_SSL_MODE_STRENGTH,
  parseMySqlSslModeFieldValue,
  resolveEffectiveMySqlSslMode,
  type ResolveEffectiveMySqlSslModeParams,
} from '../mysql-ssl-mode';
import { MYSQL_SSL_MODES, type MySqlSslMode } from '../mysql-types';

function captureMySqlCredentialsInvalidError(parse: () => unknown): MySqlCredentialsInvalidError {
  try {
    parse();
  } catch (error) {
    if (error instanceof MySqlCredentialsInvalidError) return error;
    throw error;
  }
  throw new Error('Expected a MySqlCredentialsInvalidError, but the call succeeded');
}

describe('parseMySqlSslModeFieldValue', () => {
  it.each<[string, MySqlSslMode]>([
    ['DISABLED', 'DISABLED'],
    ['disable', 'DISABLED'],
    ['PREFERRED', 'REQUIRED'],
    ['prefer', 'REQUIRED'],
    ['allow', 'REQUIRED'],
    ['REQUIRED', 'REQUIRED'],
    ['require', 'REQUIRED'],
    ['VERIFY_CA', 'VERIFY_CA'],
    ['verify-ca', 'VERIFY_CA'],
    ['VERIFY_IDENTITY', 'VERIFY_IDENTITY'],
    ['verify-full', 'VERIFY_IDENTITY'],
    ['verify_full', 'VERIFY_IDENTITY'],
    ['  Verify-Identity  ', 'VERIFY_IDENTITY'],
  ])('reads %j as %s', (rawSslMode, expectedSslMode) => {
    expect(parseMySqlSslModeFieldValue(rawSslMode)).toBe(expectedSslMode);
  });

  it.each(['FOO', '', 'verify-everything', 'true', 'ssl'])('rejects %j without echoing it', (rawSslMode) => {
    const credentialsInvalidError = captureMySqlCredentialsInvalidError(() => parseMySqlSslModeFieldValue(rawSslMode));
    expect(credentialsInvalidError.problem).toBe(MySqlCredentialProblem.SslModeInvalid);
    expect(credentialsInvalidError.message).toBe(
      'SSL Mode must be one of DISABLED, REQUIRED, VERIFY_CA or VERIFY_IDENTITY.',
    );
    if (rawSslMode !== '') expect(credentialsInvalidError.message).not.toContain(rawSslMode);
  });

  it('never maps a spelling to plaintext unless it says so (PREFERRED is tightened, not downgraded)', () => {
    expect(mapMySqlSslModeSpellingToSslMode('PREFERRED')).toBe('REQUIRED');
    expect(mapMySqlSslModeSpellingToSslMode('nonsense')).toBeUndefined();
  });
});

describe('MYSQL_SSL_MODE_STRENGTH', () => {
  it('orders the modes from least to most protective', () => {
    const modesByStrength = [...MYSQL_SSL_MODES].sort(
      (a, b) => MYSQL_SSL_MODE_STRENGTH[a] - MYSQL_SSL_MODE_STRENGTH[b],
    );
    expect(modesByStrength).toEqual(['DISABLED', 'REQUIRED', 'VERIFY_CA', 'VERIFY_IDENTITY']);
    expect(Object.isFrozen(MYSQL_SSL_MODE_STRENGTH)).toBe(true);
  });

  it('marks only the VERIFY_* modes as verifying', () => {
    expect(MYSQL_SSL_MODES.filter(isVerifyingMySqlSslMode)).toEqual(['VERIFY_CA', 'VERIFY_IDENTITY']);
  });
});

describe('resolveEffectiveMySqlSslMode', () => {
  const resolve = (overrides: Partial<ResolveEffectiveMySqlSslModeParams>): MySqlSslMode =>
    resolveEffectiveMySqlSslMode({
      sslModeFromField: undefined,
      sslModeFromConnectionString: undefined,
      inheritedSslMode: undefined,
      hasCaCertificate: false,
      ...overrides,
    });

  describe('without a CA certificate', () => {
    it.each<[string, Partial<ResolveEffectiveMySqlSslModeParams>, MySqlSslMode]>([
      ['defaults to REQUIRED', {}, 'REQUIRED'],
      ['keeps an inherited DISABLED', { inheritedSslMode: 'DISABLED' }, 'DISABLED'],
      ['keeps an inherited VERIFY_IDENTITY', { inheritedSslMode: 'VERIFY_IDENTITY' }, 'VERIFY_IDENTITY'],
      [
        'lets the connection string override the inherited mode',
        { sslModeFromConnectionString: 'VERIFY_CA', inheritedSslMode: 'DISABLED' },
        'VERIFY_CA',
      ],
      [
        'lets a connection string REQUIRED replace an inherited VERIFY_IDENTITY',
        { sslModeFromConnectionString: 'REQUIRED', inheritedSslMode: 'VERIFY_IDENTITY' },
        'REQUIRED',
      ],
      [
        'accepts a field equal to the connection string',
        { sslModeFromField: 'REQUIRED', sslModeFromConnectionString: 'REQUIRED' },
        'REQUIRED',
      ],
      [
        'lets a stricter field win over the connection string',
        { sslModeFromField: 'VERIFY_IDENTITY', sslModeFromConnectionString: 'REQUIRED' },
        'VERIFY_IDENTITY',
      ],
      [
        'lets the field replace the inherited mode, even weaker',
        { sslModeFromField: 'DISABLED', inheritedSslMode: 'VERIFY_CA' },
        'DISABLED',
      ],
      ['uses the field alone', { sslModeFromField: 'VERIFY_CA' }, 'VERIFY_CA'],
    ])('%s', (_description, overrides, expectedSslMode) => {
      expect(resolve(overrides)).toBe(expectedSslMode);
    });

    it.each<[MySqlSslMode, MySqlSslMode]>([
      ['REQUIRED', 'VERIFY_CA'],
      ['DISABLED', 'REQUIRED'],
      ['VERIFY_CA', 'VERIFY_IDENTITY'],
    ])('rejects field %s weaker than the connection string %s', (sslModeFromField, sslModeFromConnectionString) => {
      const credentialsInvalidError = captureMySqlCredentialsInvalidError(() =>
        resolve({ sslModeFromField, sslModeFromConnectionString }),
      );
      expect(credentialsInvalidError.problem).toBe(MySqlCredentialProblem.SslModeWeakerThanConnectionString);
      expect(credentialsInvalidError.message).toContain(sslModeFromConnectionString);
    });
  });

  describe('with a CA certificate', () => {
    it.each<[string, Partial<ResolveEffectiveMySqlSslModeParams>, MySqlSslMode]>([
      ['upgrades the default to VERIFY_CA', {}, 'VERIFY_CA'],
      ['upgrades an inherited REQUIRED', { inheritedSslMode: 'REQUIRED' }, 'VERIFY_CA'],
      ['upgrades an inherited DISABLED', { inheritedSslMode: 'DISABLED' }, 'VERIFY_CA'],
      ['keeps an inherited VERIFY_IDENTITY', { inheritedSslMode: 'VERIFY_IDENTITY' }, 'VERIFY_IDENTITY'],
      ["upgrades a connection string's REQUIRED", { sslModeFromConnectionString: 'REQUIRED' }, 'VERIFY_CA'],
      [
        "keeps a connection string's VERIFY_IDENTITY",
        { sslModeFromConnectionString: 'VERIFY_IDENTITY' },
        'VERIFY_IDENTITY',
      ],
      ['keeps a field VERIFY_CA', { sslModeFromField: 'VERIFY_CA' }, 'VERIFY_CA'],
      ['keeps a field VERIFY_IDENTITY', { sslModeFromField: 'VERIFY_IDENTITY' }, 'VERIFY_IDENTITY'],
      [
        'accepts a field VERIFY_CA above a connection string REQUIRED (DigitalOcean URL + downloaded CA)',
        { sslModeFromField: 'VERIFY_CA', sslModeFromConnectionString: 'REQUIRED' },
        'VERIFY_CA',
      ],
    ])('%s', (_description, overrides, expectedSslMode) => {
      expect(resolve({ ...overrides, hasCaCertificate: true })).toBe(expectedSslMode);
    });

    it.each<[string, Partial<ResolveEffectiveMySqlSslModeParams>]>([
      ['a field REQUIRED', { sslModeFromField: 'REQUIRED' }],
      ['a field DISABLED', { sslModeFromField: 'DISABLED' }],
      ['a field DISABLED over an inherited VERIFY_CA', { sslModeFromField: 'DISABLED', inheritedSslMode: 'VERIFY_CA' }],
      ['a connection string turning SSL off', { sslModeFromConnectionString: 'DISABLED' }],
    ])('rejects %s instead of silently changing it', (_description, overrides) => {
      const credentialsInvalidError = captureMySqlCredentialsInvalidError(() =>
        resolve({ ...overrides, hasCaCertificate: true }),
      );
      expect(credentialsInvalidError.problem).toBe(MySqlCredentialProblem.CaCertificateRequiresVerifyingSslMode);
    });
  });

  it('upholds its invariants over every combination of inputs', () => {
    const optionalSslModes: (MySqlSslMode | undefined)[] = [undefined, ...MYSQL_SSL_MODES];
    for (const sslModeFromField of optionalSslModes) {
      for (const sslModeFromConnectionString of optionalSslModes) {
        for (const inheritedSslMode of optionalSslModes) {
          for (const hasCaCertificate of [false, true]) {
            let effectiveSslMode: MySqlSslMode;
            try {
              effectiveSslMode = resolve({
                sslModeFromField,
                sslModeFromConnectionString,
                inheritedSslMode,
                hasCaCertificate,
              });
            } catch (error) {
              expect(error).toBeInstanceOf(MySqlCredentialsInvalidError);
              continue;
            }
            // Never weaker than what the connection string asked for.
            if (sslModeFromConnectionString !== undefined) {
              expect(MYSQL_SSL_MODE_STRENGTH[effectiveSslMode]).toBeGreaterThanOrEqual(
                MYSQL_SSL_MODE_STRENGTH[sslModeFromConnectionString],
              );
            }
            // An explicit field choice is never silently changed.
            if (sslModeFromField !== undefined) expect(effectiveSslMode).toBe(sslModeFromField);
            // A CA certificate is always used for verification.
            if (hasCaCertificate) expect(isVerifyingMySqlSslMode(effectiveSslMode)).toBe(true);
          }
        }
      }
    }
  });
});
