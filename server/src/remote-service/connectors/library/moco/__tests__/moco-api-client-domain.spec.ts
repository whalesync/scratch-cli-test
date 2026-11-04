import { ConnectorAuthError } from '../../../error';
import { MOCO_DOMAIN_NOT_A_SUBDOMAIN_MESSAGE, MocoApiClient } from '../moco-api-client';

describe('MocoApiClient domain (DEV-12723)', () => {
  it('accepts a plain subdomain', () => {
    expect(() => new MocoApiClient({ domain: 'yourcompany', apiKey: 'api-key' })).not.toThrow();
  });

  // Each of these would move the API host off mocoapp.com, taking the API key with it.
  it.each(['acme#', 'evil.example/x?', 'evil.example', 'acme@evil.example', 'acme:8080', ''])(
    'refuses %p before building the client',
    (domain) => {
      expect(() => new MocoApiClient({ domain, apiKey: 'api-key' })).toThrow(ConnectorAuthError);
    },
  );

  it('explains what to enter', () => {
    expect(() => new MocoApiClient({ domain: 'evil.example#', apiKey: 'api-key' })).toThrow(
      MOCO_DOMAIN_NOT_A_SUBDOMAIN_MESSAGE,
    );
  });

  it('refuses a stored domain that is not text', () => {
    expect(() => new MocoApiClient({ domain: ['evil.example'] as unknown as string, apiKey: 'api-key' })).toThrow(
      ConnectorAuthError,
    );
  });
});
