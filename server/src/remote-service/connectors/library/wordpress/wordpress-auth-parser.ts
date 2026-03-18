import { AuthParser } from '../../connector';
import { ConnectorInstantiationError } from '../../error';
import { Service } from '../../service-constants';
import { WordPressHttpClient } from './wordpress-http-client';

export class WordPressAuthParser extends AuthParser {
  readonly service = Service.WORDPRESS;

  /**
   * This method is used to check a couple of alternatives for the wordpress endpoint
   * because users most of the time will not have the exact one we need so we do a couple transformations to get the correct one.
   * @param params The user provided parameters for the WordPress connection
   * @returns The working endpoint for the WordPress site
   */
  async parseUserProvidedParams(params: {
    userProvidedParams: Record<string, string | undefined>;
  }): Promise<{ credentials: Record<string, string>; extras: Record<string, string> }> {
    const { username, password, endpoint } = params.userProvidedParams;
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
}
