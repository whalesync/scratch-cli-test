import { AuthParser } from '../../connector';
import { ConnectorAuthError } from '../../error';
import { Service } from '../../service-constants';

const PLACEHOLDER_PATTERN = /\[YOUR[_-]PASSWORD\]/i;

export class SupabaseAuthParser extends AuthParser {
  readonly service = Service.SUPABASE;

  // eslint-disable-next-line @typescript-eslint/require-await
  async parseUserProvidedParams(params: {
    userProvidedParams: Record<string, string | undefined>;
  }): Promise<{ credentials: Record<string, string>; extras: Record<string, string> }> {
    const { connectionString } = params.userProvidedParams;
    if (!connectionString) {
      throw new ConnectorAuthError(
        'Connection string is required for Supabase',
        'Connection string is required for Supabase.',
        this.service,
      );
    }

    // Check for placeholder passwords
    if (PLACEHOLDER_PATTERN.test(connectionString)) {
      throw new ConnectorAuthError(
        'Connection string contains placeholder password',
        'Your connection string contains the placeholder [YOUR-PASSWORD]. Replace it with your actual database password.',
        this.service,
      );
    }

    // Check for valid protocol
    if (!connectionString.startsWith('postgresql://') && !connectionString.startsWith('postgres://')) {
      throw new ConnectorAuthError(
        'Connection string has invalid protocol',
        'Connection string must start with postgresql:// or postgres://',
        this.service,
      );
    }

    // Try to parse the URL
    let parsed: URL;
    try {
      parsed = new URL(connectionString);
    } catch {
      throw new ConnectorAuthError(
        'Connection string is not a valid URL',
        'Invalid connection string format. Copy it from Supabase Dashboard > Settings > Database > Connection string.',
        this.service,
      );
    }

    // Check for empty password
    if (!parsed.password) {
      throw new ConnectorAuthError(
        'Connection string has no password',
        'Connection string has no password. Include your database password.',
        this.service,
      );
    }

    // Warn about potentially unencoded special characters.
    // If the hostname looks wrong (e.g. too short, or doesn't contain a dot), the password
    // likely contained an unencoded '@' which split the authority portion incorrectly.
    const hostname = parsed.hostname;
    if (hostname && !hostname.includes('.')) {
      throw new ConnectorAuthError(
        `Hostname "${hostname}" looks malformed — possible unencoded special chars in password`,
        'If your password contains special characters (@, #, %), they must be URL-encoded.',
        this.service,
      );
    }

    // Reject direct connection strings (db.PROJECT_REF.supabase.co) — only pooler strings are supported
    if (hostname.startsWith('db.') && hostname.endsWith('.supabase.co')) {
      throw new ConnectorAuthError(
        'Direct connection string not supported',
        'Direct connection strings are not supported. Please use the Transaction pooler connection string from your Supabase.',
        this.service,
      );
    }

    return { credentials: { connectionString }, extras: {} };
  }
}
