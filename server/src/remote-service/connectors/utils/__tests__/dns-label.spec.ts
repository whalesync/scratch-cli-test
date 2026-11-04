import { isPlainDnsLabel } from '../dns-label';

describe('isPlainDnsLabel', () => {
  it.each(['acme', 'yourcompany', 'abc123de', 'my-company', 'A1', 'x', 'a'.repeat(63)])('accepts %p', (value) => {
    expect(isPlainDnsLabel(value)).toBe(true);
  });

  it.each([
    ['empty', ''],
    ['a dot', 'evil.example'],
    ['a fragment', 'acme#'],
    ['a path', 'evil.example/x'],
    ['a query', 'evil.example?'],
    ['userinfo', 'acme@evil.example'],
    ['a port', 'acme:8080'],
    ['a backslash', 'acme\\evil'],
    ['whitespace', ' acme'],
    ['a leading hyphen', '-acme'],
    ['a trailing hyphen', 'acme-'],
    ['a percent-encoded dot', 'evil%2eexample'],
    ['64 characters', 'a'.repeat(64)],
  ])('refuses a value with %s', (_description, value) => {
    expect(isPlainDnsLabel(value)).toBe(false);
  });

  it.each([[['acme']], [42], [null], [undefined], [{ toString: () => 'acme' }]])(
    'refuses %p, which is not text',
    (value) => {
      expect(isPlainDnsLabel(value)).toBe(false);
    },
  );
});
