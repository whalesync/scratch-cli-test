import { DecryptedCredentials, isNonBlankCredentialValue } from '@spinner/shared-types';
import { AuthParser } from '../../connector';
import { ConnectorAuthError, ConnectorInstantiationError } from '../../error';
import { Service } from '../../service-constants';
import { WordPressHttpClient } from './wordpress-http-client';

/** Every key a WordPress connection stores. */
type WordPressCredentialKey = 'username' | 'password' | 'endpoint';

/** The connect form's labels (`WordPressConnector.metadata`), which imports this parser and so can't be imported here. */
const WORDPRESS_CREDENTIAL_FIELD_LABELS: Readonly<Record<WordPressCredentialKey, string>> = Object.freeze({
  username: 'Username',
  password: 'Application password',
  endpoint: 'WordPress URL',
});

export class WordPressAuthParser extends AuthParser {
  readonly service = Service.WORDPRESS;

  /**
   * An edit that sends the WordPress URL runs the same endpoint discovery as a create, so the stored endpoint is always
   * one discovery found and checked; storing the site URL as typed broke every later request (DEV-12747). An edit that
   * doesn't send it keeps the stored endpoint without a request. Before this runs, the service refuses an edit that
   * moves the URL to a new site without the Application password (DEV-12723), so discovery never sends the stored
   * password to a new host.
   */
  override readonly parsesCredentialEditsAgainstStoredCredentials = true;

  /**
   * This method is used to check a couple of alternatives for the wordpress endpoint
   * because users most of the time will not have the exact one we need so we do a couple transformations to get the correct one.
   * @param params The user provided parameters for the WordPress connection, and the stored credentials on an edit
   * @returns The working endpoint for the WordPress site
   */
  async parseUserProvidedParams(params: {
    userProvidedParams: Record<string, string | undefined>;
    existingCredentials?: DecryptedCredentials;
  }): Promise<{ credentials: Record<string, string>; extras: Record<string, string> }> {
    if (params.existingCredentials === undefined) {
      return this.parseCredentialsForNewConnection(params.userProvidedParams);
    }
    return this.parseCredentialEditOverStoredCredentials(params.userProvidedParams, params.existingCredentials);
  }

  private async parseCredentialsForNewConnection(
    userProvidedParams: Record<string, string | undefined>,
  ): Promise<{ credentials: Record<string, string>; extras: Record<string, string> }> {
    const { username, password, endpoint } = userProvidedParams;
    if (!username) {
      throw new ConnectorInstantiationError('Username is required for WordPress', this.service);
    }
    if (!password) {
      throw new ConnectorInstantiationError('Password is required for WordPress', this.service);
    }
    if (!endpoint) {
      throw new ConnectorInstantiationError('Endpoint is required for WordPress', this.service);
    }
    const client = new WordPressHttpClient(endpoint, username, password);
    const resultEndpoint = await client.discoverAndValidateEndpoint();
    return { credentials: { username, password, endpoint: resultEndpoint }, extras: {} };
  }

  /**
   * Merge an edit over the stored credentials and return the complete set. A blank value counts as not sent and keeps
   * the stored one: the edit forms start every field empty and send `''` for a field typed into and then cleared, and
   * every WordPress field is required, so there is nothing to clear.
   */
  private async parseCredentialEditOverStoredCredentials(
    userProvidedParamsFromEdit: Record<string, string | undefined>,
    storedCredentials: DecryptedCredentials,
  ): Promise<{ credentials: Record<string, string>; extras: Record<string, string> }> {
    const username = this.readEditedValueOrStoredValue('username', userProvidedParamsFromEdit, storedCredentials);
    const password = this.readEditedValueOrStoredValue('password', userProvidedParamsFromEdit, storedCredentials);
    const siteUrlFromEdit = userProvidedParamsFromEdit.endpoint;
    if (!isNonBlankCredentialValue(siteUrlFromEdit)) {
      const storedEndpoint = this.readEditedValueOrStoredValue(
        'endpoint',
        userProvidedParamsFromEdit,
        storedCredentials,
      );
      return { credentials: { username, password, endpoint: storedEndpoint }, extras: {} };
    }
    const discoveredEndpoint = await new WordPressHttpClient(
      siteUrlFromEdit,
      username,
      password,
    ).discoverAndValidateEndpoint();
    return { credentials: { username, password, endpoint: discoveredEndpoint }, extras: {} };
  }

  private readEditedValueOrStoredValue(
    credentialKey: WordPressCredentialKey,
    userProvidedParamsFromEdit: Record<string, string | undefined>,
    storedCredentials: DecryptedCredentials,
  ): string {
    const valueFromEdit = userProvidedParamsFromEdit[credentialKey];
    if (isNonBlankCredentialValue(valueFromEdit)) {
      return valueFromEdit;
    }
    const storedValue: unknown = storedCredentials[credentialKey];
    if (isNonBlankCredentialValue(storedValue)) {
      return storedValue;
    }
    const fieldLabel = WORDPRESS_CREDENTIAL_FIELD_LABELS[credentialKey];
    throw new ConnectorAuthError(
      `WordPress connection has no usable stored ${credentialKey} and the edit did not send one`,
      `This connection has no saved ${fieldLabel}. Enter the ${fieldLabel} and save again.`,
      this.service,
    );
  }
}
