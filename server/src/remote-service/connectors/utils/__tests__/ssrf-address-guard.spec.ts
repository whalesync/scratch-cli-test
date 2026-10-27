/**
 * The address checks shared by the Generic API transport and the database host guard. The bulk of the IPv4 / IPv6
 * classification cases live in `library/generic-api/apiget/ssrf-fetch.spec.ts` (which imports the same
 * `blockReasonForIp`); these cover the ranges added for parity with Whalesync's copy, and `assertSafeHost`.
 */
import { promises as dns } from 'dns';
import { assertSafeHost, blockReasonForIp, SsrfError } from '../ssrf-address-guard';

describe('blockReasonForIp — IPv6 ranges that embed or route to IPv4', () => {
  it.each([
    ['64:ff9b::a9fe:a9fe', 'NAT64 IPv6 of 169.254.169.254'], // cloud metadata through a NAT64 gateway
    ['64:ff9b::7f00:1', 'NAT64 IPv6 of 127.0.0.1'],
    ['64:ff9b::10.0.0.1', 'NAT64 IPv6 of 10.0.0.1'],
    ['64:ff9b:1::1', 'local-use NAT64'],
    ['2002:7f00:1::', '6to4 IPv6 of 127.0.0.1'],
    ['2002:a9fe:a9fe::1', '6to4 IPv6 of 169.254.169.254'],
    ['fec0::1', 'site-local'],
  ])('blocks %s (%s)', (ip, expectedReasonFragment) => {
    expect(blockReasonForIp(ip)).toContain(expectedReasonFragment);
  });

  it.each(['64:ff9b::808:808', '2002:808:808::1', '2001:4860:4860::8888'])('allows %s', (ip) => {
    expect(blockReasonForIp(ip)).toBeNull();
  });
});

describe('assertSafeHost', () => {
  let lookupSpy: jest.SpyInstance;

  beforeEach(() => {
    lookupSpy = jest.spyOn(dns, 'lookup');
  });

  afterEach(() => {
    lookupSpy.mockRestore();
  });

  it('returns every vetted address of a public name', async () => {
    lookupSpy.mockResolvedValue([
      { address: '192.0.2.10', family: 4 },
      { address: '2001:db8::1', family: 6 },
    ]);

    await expect(assertSafeHost('db.example.com', 'refused')).resolves.toEqual([
      { address: '192.0.2.10', family: 4 },
      { address: '2001:db8::1', family: 6 },
    ]);
  });

  it('checks a literal IP without a lookup', async () => {
    await expect(assertSafeHost('192.0.2.10', 'refused')).resolves.toEqual([{ address: '192.0.2.10', family: 4 }]);
    await expect(assertSafeHost('169.254.169.254', 'refused')).rejects.toMatchObject({ code: 'private_address' });
    expect(lookupSpy).not.toHaveBeenCalled();
  });

  it('refuses with the caller-supplied public message, keeping the address out of it', async () => {
    lookupSpy.mockResolvedValue([{ address: '10.0.0.7', family: 4 }]);

    const refusal: unknown = await assertSafeHost('internal.example.com', 'Could not connect.').catch(
      (error: unknown) => error,
    );

    expect(refusal).toBeInstanceOf(SsrfError);
    expect((refusal as SsrfError).message).toBe('Could not connect.');
    expect((refusal as SsrfError).code).toBe('private_address');
    expect((refusal as SsrfError).internalDetails).toContain('10.0.0.7');
  });

  it('refuses a name that resolves to nothing', async () => {
    lookupSpy.mockResolvedValue([]);
    await expect(assertSafeHost('empty.example.com', 'refused')).rejects.toMatchObject({ code: 'unresolvable' });
  });

  it('keeps the DNS error code of a failed lookup', async () => {
    lookupSpy.mockRejectedValue(
      Object.assign(new Error('getaddrinfo EAI_AGAIN db.example.com'), { code: 'EAI_AGAIN' }),
    );
    await expect(assertSafeHost('db.example.com', 'refused')).rejects.toMatchObject({
      code: 'unresolvable',
      dnsErrorCode: 'EAI_AGAIN',
    });
  });
});
