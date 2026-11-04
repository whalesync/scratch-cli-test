import { updateConnectorAccountSchema } from '@spinner/shared-types';

describe('updateConnectorAccountSchema', () => {
  it('accepts text credential values', () => {
    expect(
      updateConnectorAccountSchema.safeParse({
        userProvidedParams: { endpoint: 'https://site.example', password: 'x' },
      }).success,
    ).toBe(true);
  });

  // A non-string value could pass a string check as "not sent", yet a connector that builds a URL from it would still
  // stringify it and connect there (DEV-12723).
  it.each([
    ['an array', ['https://evil.example']],
    ['an object', { host: 'evil.example' }],
    ['a number', 42],
    ['null', null],
  ])('refuses %s as a credential value', (_description, nonTextValue) => {
    expect(updateConnectorAccountSchema.safeParse({ userProvidedParams: { endpoint: nonTextValue } }).success).toBe(
      false,
    );
  });
});
