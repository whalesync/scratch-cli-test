import { BadRequestException } from '@nestjs/common';
import { AuthType } from '@prisma/client';
import {
  AuthMethod,
  ConnectorSettingDefinition,
  describeSecretsToReenterForConnectionTargetChange,
  resolveSecretFieldsToReenterForConnectionTargetEdit,
} from '@spinner/shared-types';
import {
  assertEditResendsSecretsWhenItAddsAConnectionTarget,
  ConnectionCredentialsAndExtras,
  connectionTargetIdentity,
} from '../connection-target-edit-guard';

// WordPress-shaped: a site URL the password is sent to, a username that isn't a secret, and an optional stored secret.
const SITE_URL_FIELD: ConnectorSettingDefinition = {
  key: 'endpoint',
  type: 'string',
  label: 'WordPress URL',
  required: true,
  connectionTarget: true,
};
const USERNAME_FIELD: ConnectorSettingDefinition = {
  key: 'username',
  type: 'string',
  label: 'Username',
  required: true,
};
const PASSWORD_FIELD: ConnectorSettingDefinition = {
  key: 'password',
  type: 'password',
  label: 'Application password',
  required: true,
};
const OPTIONAL_CLIENT_KEY_FIELD: ConnectorSettingDefinition = {
  key: 'clientKey',
  type: 'password',
  label: 'Client Key',
  required: false,
};
const SITE_CREDENTIAL_FIELDS: Partial<Record<AuthMethod, ConnectorSettingDefinition[]>> = {
  user_provided_params: [USERNAME_FIELD, PASSWORD_FIELD, SITE_URL_FIELD, OPTIONAL_CLIENT_KEY_FIELD],
};

// Shopify-shaped: the shop domain is entered as a credential but stored in extras.
const SHOP_DOMAIN_FIELD: ConnectorSettingDefinition = {
  key: 'shopDomain',
  type: 'string',
  label: 'Shop Domain',
  required: true,
  connectionTarget: true,
};
const ACCESS_TOKEN_FIELD: ConnectorSettingDefinition = {
  key: 'apiKey',
  type: 'password',
  label: 'Admin API Access Token',
  required: true,
};
const SHOP_CREDENTIAL_FIELDS: Partial<Record<AuthMethod, ConnectorSettingDefinition[]>> = {
  user_provided_params: [SHOP_DOMAIN_FIELD, ACCESS_TOKEN_FIELD],
};

const STORED_SITE_CREDENTIALS = {
  username: 'editor',
  password: 'stored-secret',
  endpoint: 'https://site.example/wp-json/',
};

function checkSiteEdit(params: {
  credentialsAfterEdit: object;
  userProvidedParamsFromEdit?: object;
  storedCredentials?: object;
  authType?: AuthType;
}): string[] {
  const storedCredentials = params.storedCredentials ?? STORED_SITE_CREDENTIALS;
  return assertEditResendsSecretsWhenItAddsAConnectionTarget({
    credentialFieldsByAuthMethod: SITE_CREDENTIAL_FIELDS,
    authType: params.authType ?? AuthType.USER_PROVIDED_PARAMS,
    connectionStateBeforeEdit: { credentials: storedCredentials, extras: null },
    connectionStateAfterEdit: { credentials: params.credentialsAfterEdit, extras: null },
    userProvidedParamsFromEdit: params.userProvidedParamsFromEdit,
  });
}

function checkShopEdit(
  connectionStateAfterEdit: ConnectionCredentialsAndExtras,
  userProvidedParamsFromEdit?: object,
): string[] {
  return assertEditResendsSecretsWhenItAddsAConnectionTarget({
    credentialFieldsByAuthMethod: SHOP_CREDENTIAL_FIELDS,
    authType: AuthType.USER_PROVIDED_PARAMS,
    connectionStateBeforeEdit: {
      credentials: { apiKey: 'stored-token' },
      extras: { shopDomain: 'acme.myshopify.com' },
    },
    connectionStateAfterEdit,
    userProvidedParamsFromEdit,
  });
}

const PASSWORD_REQUIRED_FOR_SITE_URL_CHANGE_MESSAGE =
  'Enter the Application password again when you change the WordPress URL. ' +
  'Scratch only sends a saved secret to the address it was entered for.';

describe('connectionTargetIdentity', () => {
  it.each([
    ['a path-only change', 'https://site.example/wp-json/', 'https://site.example/other/path?x=1'],
    ['a case-only change', 'https://Site.Example/wp-json/', 'HTTPS://SITE.EXAMPLE/wp-json/'],
    ['a percent-encoded dot in the host', 'https://site.example/', 'https://site%2eexample/'],
    ['the default port spelled out', 'https://site.example/', 'https://site.example:443/'],
    ['surrounding whitespace on a subdomain', 'acme', '  ACME '],
  ])('treats %s as the same target', (_description, storedValue, editedValue) => {
    expect(connectionTargetIdentity(editedValue)).toBe(connectionTargetIdentity(storedValue));
  });

  it.each([
    ['a different host', 'https://evil.example/wp-json/'],
    ['a different port', 'https://site.example:8443/wp-json/'],
    ['http instead of https', 'http://site.example/wp-json/'],
    ['userinfo that moves the host', 'https://site.example@evil.example/wp-json/'],
    ['a backslash that ends the host', 'https://evil.example\\@site.example/'],
    ['a trailing dot', 'https://site.example./wp-json/'],
  ])('treats %s as a new target', (_description, editedValue) => {
    expect(connectionTargetIdentity(editedValue)).not.toBe(connectionTargetIdentity('https://site.example/wp-json/'));
  });

  it('compares a URL by the host it resolves to, as the HTTP client does', () => {
    expect(connectionTargetIdentity('https://site.example@evil.example/')).toBe('https://evil.example');
    expect(connectionTargetIdentity('https://evil.example\\@site.example/')).toBe('https://evil.example');
  });

  it('compares a value that is not an absolute URL as trimmed, lowercased text', () => {
    expect(connectionTargetIdentity(' Acme.MyShopify.com ')).toBe('acme.myshopify.com');
    expect(connectionTargetIdentity('evil.example#')).toBe('evil.example#');
  });
});

describe('assertEditResendsSecretsWhenItAddsAConnectionTarget', () => {
  it('allows any edit to a connector that declares no connection target', () => {
    expect(
      assertEditResendsSecretsWhenItAddsAConnectionTarget({
        credentialFieldsByAuthMethod: { user_provided_params: [USERNAME_FIELD, PASSWORD_FIELD] },
        authType: AuthType.USER_PROVIDED_PARAMS,
        connectionStateBeforeEdit: { credentials: { username: 'a' }, extras: null },
        connectionStateAfterEdit: { credentials: { username: 'b', endpoint: 'https://evil.example' }, extras: null },
        userProvidedParamsFromEdit: { username: 'b', endpoint: 'https://evil.example' },
      }),
    ).toEqual([]);
  });

  it.each([
    ['re-sends the stored target', 'https://site.example/wp-json/'],
    ['changes only the path', 'https://site.example/?rest_route=/'],
  ])('needs no secret when the edit %s', (_description, editedSiteUrl) => {
    const editedCredentials = { ...STORED_SITE_CREDENTIALS, endpoint: editedSiteUrl };
    expect(
      checkSiteEdit({
        credentialsAfterEdit: editedCredentials,
        userProvidedParamsFromEdit: { endpoint: editedSiteUrl },
      }),
    ).toEqual([]);
  });

  it('needs no secret to clear a target or to leave it as it is', () => {
    expect(
      checkSiteEdit({
        credentialsAfterEdit: { ...STORED_SITE_CREDENTIALS, endpoint: '' },
        userProvidedParamsFromEdit: { endpoint: '' },
      }),
    ).toEqual([]);
    expect(
      checkSiteEdit({
        credentialsAfterEdit: { ...STORED_SITE_CREDENTIALS, username: 'someone-else' },
        userProvidedParamsFromEdit: { username: 'someone-else' },
      }),
    ).toEqual([]);
  });

  it('refuses a new target without the secret, naming the secret and the target', () => {
    expect(() =>
      checkSiteEdit({
        credentialsAfterEdit: { ...STORED_SITE_CREDENTIALS, endpoint: 'https://evil.example/' },
        userProvidedParamsFromEdit: { endpoint: 'https://evil.example/' },
      }),
    ).toThrow(new BadRequestException(PASSWORD_REQUIRED_FOR_SITE_URL_CHANGE_MESSAGE));
  });

  it.each([
    ['blank', ''],
    ['only whitespace', '   '],
  ])('does not count a %s secret as sent again', (_description, blankPassword) => {
    expect(() =>
      checkSiteEdit({
        credentialsAfterEdit: {
          ...STORED_SITE_CREDENTIALS,
          endpoint: 'https://evil.example/',
          password: blankPassword,
        },
        userProvidedParamsFromEdit: { endpoint: 'https://evil.example/', password: blankPassword },
      }),
    ).toThrow(BadRequestException);
  });

  it('accepts a new target with the secret, and returns the target it adds', () => {
    expect(
      checkSiteEdit({
        credentialsAfterEdit: {
          ...STORED_SITE_CREDENTIALS,
          endpoint: 'https://new-site.example/wp-json/',
          password: 'x',
        },
        userProvidedParamsFromEdit: { endpoint: 'https://new-site.example/wp-json/', password: 'x' },
      }),
    ).toEqual(['https://new-site.example']);
  });

  it('also requires an optional secret that is stored, but not one that is not', () => {
    const storedCredentialsWithClientKey = { ...STORED_SITE_CREDENTIALS, clientKey: 'stored-client-key' };
    expect(() =>
      checkSiteEdit({
        storedCredentials: storedCredentialsWithClientKey,
        credentialsAfterEdit: { ...storedCredentialsWithClientKey, endpoint: 'https://evil.example/', password: 'x' },
        userProvidedParamsFromEdit: { endpoint: 'https://evil.example/', password: 'x' },
      }),
    ).toThrow(
      new BadRequestException(
        'Enter the Client Key again when you change the WordPress URL. ' +
          'Scratch only sends a saved secret to the address it was entered for.',
      ),
    );
    expect(
      checkSiteEdit({
        credentialsAfterEdit: { ...STORED_SITE_CREDENTIALS, endpoint: 'https://new-site.example/', password: 'x' },
        userProvidedParamsFromEdit: { endpoint: 'https://new-site.example/', password: 'x' },
      }),
    ).toEqual(['https://new-site.example']);
  });

  describe('a target that is not text', () => {
    it('counts an unreadable stored target as changed when the edit sets a readable one', () => {
      expect(() =>
        checkSiteEdit({
          storedCredentials: { ...STORED_SITE_CREDENTIALS, endpoint: ['https://site.example/wp-json/'] },
          credentialsAfterEdit: { ...STORED_SITE_CREDENTIALS, endpoint: 'https://site.example/wp-json/' },
          userProvidedParamsFromEdit: { endpoint: 'https://site.example/wp-json/' },
        }),
      ).toThrow(BadRequestException);
    });

    it('counts replacing a readable target with an unreadable one as a new target', () => {
      expect(() =>
        checkSiteEdit({
          credentialsAfterEdit: { ...STORED_SITE_CREDENTIALS, endpoint: ['https://evil.example'] },
          userProvidedParamsFromEdit: {},
        }),
      ).toThrow(BadRequestException);
    });

    it('lets an edit that leaves an unreadable stored target as it is through', () => {
      const storedCredentialsWithUnreadableTarget = { ...STORED_SITE_CREDENTIALS, endpoint: 42 };
      expect(
        checkSiteEdit({
          storedCredentials: storedCredentialsWithUnreadableTarget,
          credentialsAfterEdit: { ...storedCredentialsWithUnreadableTarget, username: 'renamed' },
          userProvidedParamsFromEdit: { username: 'renamed' },
        }),
      ).toEqual([]);
    });
  });

  describe('a target stored in extras (Shopify)', () => {
    it('refuses an extras-only shop domain change, which cannot carry the token', () => {
      expect(() => checkShopEdit({ credentials: {}, extras: { shopDomain: 'evil.myshopify.com' } }, undefined)).toThrow(
        new BadRequestException(
          'Enter the Admin API Access Token again when you change the Shop Domain. ' +
            'Scratch only sends a saved secret to the address it was entered for.',
        ),
      );
    });

    it('accepts a shop domain change that sends the token again', () => {
      expect(
        checkShopEdit(
          { credentials: { apiKey: 'new-token' }, extras: { shopDomain: 'new-shop.myshopify.com' } },
          { shopDomain: 'new-shop.myshopify.com', apiKey: 'new-token' },
        ),
      ).toEqual(['new-shop.myshopify.com']);
    });

    it('needs no token when the shop domain is re-sent as stored', () => {
      expect(
        checkShopEdit(
          { credentials: { apiKey: 'stored-token' }, extras: { shopDomain: 'acme.myshopify.com' } },
          { shopDomain: 'acme.myshopify.com' },
        ),
      ).toEqual([]);
    });

    it('ignores extras that are not a plain object', () => {
      expect(checkShopEdit({ credentials: { apiKey: 'stored-token' }, extras: ['evil.myshopify.com'] })).toEqual([]);
    });
  });

  it('refuses a target change on an OAuth connection, whose tokens no edit can send', () => {
    expect(() =>
      checkSiteEdit({
        authType: AuthType.OAUTH,
        credentialsAfterEdit: { ...STORED_SITE_CREDENTIALS, endpoint: 'https://evil.example/', password: 'x' },
        userProvidedParamsFromEdit: { endpoint: 'https://evil.example/', password: 'x' },
      }),
    ).toThrow(new BadRequestException("This connection's WordPress URL can't be changed here. Reconnect it instead."));
  });

  it('treats a deprecated API_KEY connection like a USER_PROVIDED_PARAMS one', () => {
    expect(() =>
      checkSiteEdit({
        authType: AuthType.API_KEY,
        credentialsAfterEdit: { ...STORED_SITE_CREDENTIALS, endpoint: 'https://evil.example/' },
        userProvidedParamsFromEdit: { endpoint: 'https://evil.example/' },
      }),
    ).toThrow(new BadRequestException(PASSWORD_REQUIRED_FOR_SITE_URL_CHANGE_MESSAGE));
    expect(
      checkSiteEdit({
        authType: AuthType.API_KEY,
        credentialsAfterEdit: { ...STORED_SITE_CREDENTIALS, endpoint: 'https://new-site.example/', password: 'x' },
        userProvidedParamsFromEdit: { endpoint: 'https://new-site.example/', password: 'x' },
      }),
    ).toEqual(['https://new-site.example']);
  });
});

describe('describeSecretsToReenterForConnectionTargetChange', () => {
  it('lists labels with the Oxford comma', () => {
    expect(describeSecretsToReenterForConnectionTargetChange(['API Key', 'Client Secret', 'Token'], ['Domain'])).toBe(
      'Enter the API Key, Client Secret, and Token again when you change the Domain. ' +
        'Scratch only sends a saved secret to the address it was entered for.',
    );
    expect(describeSecretsToReenterForConnectionTargetChange(['API Key', 'Token'], ['Domain', 'Region'])).toBe(
      'Enter the API Key and Token again when you change the Domain and Region. ' +
        'Scratch only sends a saved secret to the address it was entered for.',
    );
  });
});

describe('resolveSecretFieldsToReenterForConnectionTargetEdit', () => {
  const siteFormFields = SITE_CREDENTIAL_FIELDS.user_provided_params ?? [];

  it('asks for nothing while no target field has a value', () => {
    expect(resolveSecretFieldsToReenterForConnectionTargetEdit(siteFormFields, { username: 'someone' })).toEqual({
      connectionTargetFieldsBeingEdited: [],
      secretFieldsToReenter: [],
    });
    expect(resolveSecretFieldsToReenterForConnectionTargetEdit(siteFormFields, { endpoint: '   ' })).toEqual({
      connectionTargetFieldsBeingEdited: [],
      secretFieldsToReenter: [],
    });
  });

  it('asks for the required secrets once a target field has a value', () => {
    expect(
      resolveSecretFieldsToReenterForConnectionTargetEdit(siteFormFields, { endpoint: 'https://new-site.example' }),
    ).toEqual({
      connectionTargetFieldsBeingEdited: [SITE_URL_FIELD],
      secretFieldsToReenter: [PASSWORD_FIELD],
    });
  });
});
