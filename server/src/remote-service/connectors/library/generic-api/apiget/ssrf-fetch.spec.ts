/**
 * Tests for ssrf-fetch.ts — the chokepoint that protects the GENERIC_API
 * connector from server-side request forgery.
 *
 * Four groups of tests:
 *   1. blockReasonForIp — pure IP-classification logic, no DNS or fetch.
 *      Includes Codex-flagged bypasses (IPv4-mapped IPv6 in hex pair form).
 *   2. assertSafeUrl — protocol + DNS + IP checks, with `dns.lookup` mocked.
 *      Returns ValidatedTarget (URL + pinned IP) instead of bare URL.
 *   3. ssrfSafeFetch — full transport with `undici.fetch` mocked, covering
 *      the redirect re-validation flow and the body-size cap.
 *   4. SsrfError public-vs-internal message split — the message surfaced to
 *      end users must never reveal the resolved IP / hostname / block reason.
 */

// Mock undici BEFORE importing ssrf-fetch so the module under test picks up the
// mocked `fetch`. We keep the real `Agent` (and everything else) so the agent
// the SSRF transport creates still works as a real undici Dispatcher.
jest.mock('undici', () => {
  const actual = jest.requireActual<typeof import('undici')>('undici');
  return { ...actual, fetch: jest.fn() };
});

import { promises as dns } from 'dns';
import * as undici from 'undici';
import { assertSafeUrl, blockReasonForIp, SsrfError, ssrfSafeFetch } from './ssrf-fetch';

const undiciFetchMock = undici.fetch as unknown as jest.Mock;

// ─────────────────────────────────────────────────────────────────────────────
// blockReasonForIp — pure classification
// ─────────────────────────────────────────────────────────────────────────────

describe('blockReasonForIp — IPv4', () => {
  it.each([
    ['127.0.0.1', 'loopback'],
    ['127.255.255.255', 'loopback'],
    ['10.0.0.1', 'private RFC 1918'],
    ['10.255.255.255', 'private RFC 1918'],
    ['172.16.0.1', 'private RFC 1918'],
    ['172.31.255.255', 'private RFC 1918'],
    ['192.168.0.1', 'private RFC 1918'],
    ['192.168.1.100', 'private RFC 1918'],
    ['169.254.169.254', 'link-local'], // AWS metadata
    ['169.254.0.1', 'link-local'],
    ['0.0.0.0', 'unspecified'],
    ['100.64.0.1', 'shared address space'],
    ['224.0.0.1', 'multicast'],
    ['239.255.255.255', 'multicast'],
    ['240.0.0.1', 'reserved'],
    ['255.255.255.255', 'reserved Class E'],
  ])('blocks %s (%s)', (ip, label) => {
    const reason = blockReasonForIp(ip);
    expect(reason).not.toBeNull();
    expect(reason!.toLowerCase()).toContain(label.toLowerCase());
  });

  it.each([
    '8.8.8.8', // Google DNS
    '1.1.1.1', // Cloudflare DNS
    '172.15.0.1', // just outside 172.16-31 private range
    '172.32.0.1', // just outside 172.16-31 private range
    '192.169.1.1', // not 192.168
    '169.253.0.1', // not 169.254
    '100.63.0.1', // just outside 100.64-127 CGNAT range
    '100.128.0.1', // just outside 100.64-127 CGNAT range
  ])('allows %s', (ip) => {
    expect(blockReasonForIp(ip)).toBeNull();
  });
});

describe('blockReasonForIp — IPv6', () => {
  it.each([
    ['::1', 'loopback'],
    ['::', 'unspecified'],
    ['fe80::1', 'link-local'],
    ['febf:ffff:ffff:ffff:ffff:ffff:ffff:ffff', 'link-local'],
    ['fc00::1', 'unique-local'],
    ['fdff::1', 'unique-local'],
    ['ff00::1', 'multicast'],
    ['ff02::1', 'multicast'],
  ])('blocks %s (%s)', (ip, label) => {
    const reason = blockReasonForIp(ip);
    expect(reason).not.toBeNull();
    expect(reason!.toLowerCase()).toContain(label.toLowerCase());
  });

  it('blocks IPv4-mapped IPv6 in dotted form that wraps a private v4', () => {
    expect(blockReasonForIp('::ffff:127.0.0.1')).toMatch(/loopback/i);
    expect(blockReasonForIp('::ffff:169.254.169.254')).toMatch(/link-local/i);
  });

  // Codex-flagged bypass: Node canonicalizes ::ffff:127.0.0.1 to ::ffff:7f00:1
  // (hex pair form) AND the WHATWG URL parser keeps the expanded form
  // 0:0:0:0:0:ffff:7f00:1. The old "leading hextet" heuristic missed both.
  it('blocks IPv4-mapped IPv6 in hex-pair form (Codex bypass)', () => {
    expect(blockReasonForIp('::ffff:7f00:1')).toMatch(/loopback/i); // 127.0.0.1
    expect(blockReasonForIp('::ffff:a9fe:a9fe')).toMatch(/link-local/i); // 169.254.169.254 — AWS metadata
    expect(blockReasonForIp('::ffff:0a00:1')).toMatch(/RFC 1918/i); // 10.0.0.1
    expect(blockReasonForIp('::ffff:ac10:1')).toMatch(/RFC 1918/i); // 172.16.0.1
    expect(blockReasonForIp('::ffff:c0a8:1')).toMatch(/RFC 1918/i); // 192.168.0.1
  });

  it('blocks fully-expanded IPv4-mapped IPv6 (0:0:0:0:0:ffff:xxxx:yyyy)', () => {
    expect(blockReasonForIp('0:0:0:0:0:ffff:7f00:1')).toMatch(/loopback/i);
    expect(blockReasonForIp('0:0:0:0:0:ffff:a9fe:a9fe')).toMatch(/link-local/i);
  });

  it('blocks IPv4-compatible IPv6 (::a.b.c.d, deprecated) that wraps a private v4', () => {
    expect(blockReasonForIp('::127.0.0.1')).toMatch(/loopback/i);
    expect(blockReasonForIp('::169.254.169.254')).toMatch(/link-local/i);
  });

  it('allows public IPv6', () => {
    expect(blockReasonForIp('2606:4700:4700::1111')).toBeNull(); // Cloudflare
    expect(blockReasonForIp('2001:4860:4860::8888')).toBeNull(); // Google
  });

  it('allows public IPv4-mapped IPv6', () => {
    expect(blockReasonForIp('::ffff:8.8.8.8')).toBeNull();
    expect(blockReasonForIp('::ffff:0808:808')).toBeNull(); // 8.8.8.8 in hex pair
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// assertSafeUrl — protocol + DNS + IP, returns ValidatedTarget
// ─────────────────────────────────────────────────────────────────────────────

describe('assertSafeUrl — protocol + literal IPs', () => {
  it('rejects http://', async () => {
    await expect(assertSafeUrl('http://example.com/x')).rejects.toThrow(SsrfError);
    await expect(assertSafeUrl('http://example.com/x')).rejects.toThrow(/HTTPS/i);
  });

  it('rejects file:// and ftp://', async () => {
    await expect(assertSafeUrl('file:///etc/passwd')).rejects.toThrow(SsrfError);
    await expect(assertSafeUrl('ftp://example.com/x')).rejects.toThrow(SsrfError);
  });

  it('rejects unparseable URLs', async () => {
    await expect(assertSafeUrl('not a url')).rejects.toThrow(SsrfError);
  });

  it('rejects literal private IPv4 in URL (no DNS needed)', async () => {
    await expect(assertSafeUrl('https://127.0.0.1/x')).rejects.toThrow(SsrfError);
    await expect(assertSafeUrl('https://169.254.169.254/latest/meta-data/')).rejects.toThrow(SsrfError);
    await expect(assertSafeUrl('https://10.0.0.1/internal')).rejects.toThrow(SsrfError);
  });

  it('rejects literal private IPv6 in URL', async () => {
    await expect(assertSafeUrl('https://[::1]/x')).rejects.toThrow(SsrfError);
    await expect(assertSafeUrl('https://[fe80::1]/x')).rejects.toThrow(SsrfError);
  });

  it('rejects IPv4-mapped IPv6 literal in URL — hex-pair form (Codex bypass)', async () => {
    await expect(assertSafeUrl('https://[::ffff:7f00:1]/')).rejects.toThrow(SsrfError);
    await expect(assertSafeUrl('https://[::ffff:a9fe:a9fe]/latest/meta-data/')).rejects.toThrow(SsrfError);
    await expect(assertSafeUrl('https://[0:0:0:0:0:ffff:7f00:1]/')).rejects.toThrow(SsrfError);
  });

  it('returns the pinned IP and family for a literal IPv4', async () => {
    const target = await assertSafeUrl('https://8.8.8.8/x');
    expect(target.pinnedIp).toBe('8.8.8.8');
    expect(target.pinnedFamily).toBe(4);
    expect(target.url.toString()).toBe('https://8.8.8.8/x');
  });

  it('returns the pinned IP and family for a literal IPv6', async () => {
    const target = await assertSafeUrl('https://[2606:4700:4700::1111]/x');
    expect(target.pinnedIp).toBe('2606:4700:4700::1111');
    expect(target.pinnedFamily).toBe(6);
  });
});

describe('assertSafeUrl — DNS resolution', () => {
  let lookupSpy: jest.SpyInstance;

  beforeEach(() => {
    lookupSpy = jest.spyOn(dns, 'lookup');
  });

  afterEach(() => {
    lookupSpy.mockRestore();
  });

  it('allows a public IP returned by DNS and pins it for the connect', async () => {
    lookupSpy.mockResolvedValue([{ address: '8.8.8.8', family: 4 }]);
    const target = await assertSafeUrl('https://example.com/x');
    expect(target.pinnedIp).toBe('8.8.8.8');
    expect(target.pinnedFamily).toBe(4);
  });

  it('rejects when DNS returns a private IP', async () => {
    lookupSpy.mockResolvedValue([{ address: '10.0.0.5', family: 4 }]);
    await expect(assertSafeUrl('https://evil.example.com/x')).rejects.toThrow(SsrfError);
  });

  it('rejects when DNS returns a link-local IP (DNS-rebinding to AWS metadata)', async () => {
    lookupSpy.mockResolvedValue([{ address: '169.254.169.254', family: 4 }]);
    await expect(assertSafeUrl('https://evil.example.com/x')).rejects.toThrow(SsrfError);
  });

  it('rejects when ANY resolved IP is private (multi-A records)', async () => {
    lookupSpy.mockResolvedValue([
      { address: '8.8.8.8', family: 4 },
      { address: '127.0.0.1', family: 4 }, // attacker added this
    ]);
    await expect(assertSafeUrl('https://mixed.example.com/x')).rejects.toThrow(SsrfError);
  });

  it('rejects when DNS lookup fails', async () => {
    lookupSpy.mockRejectedValue(new Error('ENOTFOUND'));
    await expect(assertSafeUrl('https://nonexistent.invalid/x')).rejects.toThrow(SsrfError);
  });

  it('allows a public IPv6 from DNS and returns family=6', async () => {
    lookupSpy.mockResolvedValue([{ address: '2606:4700:4700::1111', family: 6 }]);
    const target = await assertSafeUrl('https://one.one.one.one/x');
    expect(target.pinnedFamily).toBe(6);
    expect(target.pinnedIp).toBe('2606:4700:4700::1111');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ssrfSafeFetch — redirect re-validation + body cap
// (stubs undici.fetch, the transport ssrfSafeFetch actually calls)
// ─────────────────────────────────────────────────────────────────────────────

describe('ssrfSafeFetch — redirects', () => {
  let lookupSpy: jest.SpyInstance;

  beforeEach(() => {
    undiciFetchMock.mockReset();
    lookupSpy = jest.spyOn(dns, 'lookup');
  });

  afterEach(() => {
    lookupSpy.mockRestore();
  });

  function mockResponse(opts: { status: number; headers?: Record<string, string>; body?: string }): Response {
    const headers = new Headers(opts.headers ?? {});
    return new Response(opts.body ?? '', { status: opts.status, headers });
  }

  it('blocks a 302 redirect to AWS metadata even when the initial URL is public', async () => {
    lookupSpy.mockResolvedValueOnce([{ address: '8.8.8.8', family: 4 }]);
    undiciFetchMock.mockResolvedValueOnce(
      mockResponse({ status: 302, headers: { location: 'https://169.254.169.254/latest/meta-data/' } }),
    );

    await expect(
      ssrfSafeFetch({
        url: 'https://api.example.com/start',
        method: 'GET',
        headers: {},
      }),
    ).rejects.toThrow(SsrfError);
  });

  it('blocks a 302 redirect to an IPv4-mapped IPv6 hex form (Codex bypass)', async () => {
    lookupSpy.mockResolvedValueOnce([{ address: '8.8.8.8', family: 4 }]);
    undiciFetchMock.mockResolvedValueOnce(
      mockResponse({ status: 302, headers: { location: 'https://[::ffff:a9fe:a9fe]/' } }),
    );

    await expect(
      ssrfSafeFetch({
        url: 'https://api.example.com/start',
        method: 'GET',
        headers: {},
      }),
    ).rejects.toThrow(SsrfError);
  });

  it('follows a redirect to another public host and validates that too', async () => {
    lookupSpy
      .mockResolvedValueOnce([{ address: '8.8.8.8', family: 4 }])
      .mockResolvedValueOnce([{ address: '1.1.1.1', family: 4 }]);
    undiciFetchMock
      .mockResolvedValueOnce(mockResponse({ status: 302, headers: { location: 'https://other.example.com/final' } }))
      .mockResolvedValueOnce(
        mockResponse({
          status: 200,
          headers: { 'content-type': 'application/json' },
          body: '{"ok":true}',
        }),
      );

    const response = await ssrfSafeFetch({
      url: 'https://api.example.com/start',
      method: 'GET',
      headers: {},
    });
    expect(response.status).toBe(200);
    expect(response.body).toBe('{"ok":true}');
  });

  it('rejects after too many redirect hops', async () => {
    lookupSpy.mockResolvedValue([{ address: '8.8.8.8', family: 4 }]);
    undiciFetchMock.mockResolvedValue(
      mockResponse({ status: 302, headers: { location: 'https://api.example.com/loop' } }),
    );

    await expect(
      ssrfSafeFetch({
        url: 'https://api.example.com/start',
        method: 'GET',
        headers: {},
      }),
    ).rejects.toThrow(/redirect/i);
  });
});

describe('ssrfSafeFetch — pinned connect (DNS-rebinding TOCTOU fix)', () => {
  let lookupSpy: jest.SpyInstance;

  beforeEach(() => {
    undiciFetchMock.mockReset();
    lookupSpy = jest.spyOn(dns, 'lookup');
    lookupSpy.mockResolvedValue([{ address: '8.8.8.8', family: 4 }]);
    undiciFetchMock.mockResolvedValue(
      new Response('{"ok":true}', {
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
      }),
    );
  });

  afterEach(() => {
    lookupSpy.mockRestore();
  });

  it('passes a dispatcher to undici.fetch (so the agent pins the TCP connect)', async () => {
    await ssrfSafeFetch({
      url: 'https://api.example.com/x',
      method: 'GET',
      headers: {},
    });

    expect(undiciFetchMock).toHaveBeenCalledTimes(1);
    const firstCall = undiciFetchMock.mock.calls[0] as unknown[];
    const opts = firstCall[1] as { dispatcher?: unknown; redirect?: string };
    expect(opts).toBeDefined();
    // The dispatcher is what makes the TCP connect go to the pre-vetted IP
    // rather than re-resolving via DNS (which is the TOCTOU bypass Codex found).
    expect(opts.dispatcher).toBeDefined();
    expect(opts.redirect).toBe('manual');
  });

  /**
   * Regression test for the "fetch failed ← Invalid IP address: undefined"
   * bug. undici's connect builder calls our lookup callback with
   * `options.all === true`, expecting the dns.lookup `all`-mode signature
   * `cb(err, [{address, family}, …])`. Our original code only handled the
   * `all: false` signature `cb(err, address, family)`, which made undici
   * treat the string address as an array, fail to index it, and surface
   * `Invalid IP address: undefined`.
   *
   * Tests pull the lookup function out of the dispatcher we set on
   * undici.fetch and exercise both signatures.
   */
  it('pinned-Agent lookup honors both all=true and all=false callback shapes', async () => {
    await ssrfSafeFetch({
      url: 'https://api.example.com/x',
      method: 'GET',
      headers: {},
    });

    const firstCall = undiciFetchMock.mock.calls[0] as unknown[];
    const opts = firstCall[1] as { dispatcher: unknown };
    // Reach into the Agent to find its connect.lookup function. Undici stores
    // the connect options on `[Symbol(options)]` — we walk the dispatcher
    // shape instead to avoid coupling to a private symbol.
    const dispatcher = opts.dispatcher as { [k: string]: unknown };
    let lookup: ((host: string, options: unknown, cb: unknown) => void) | undefined;
    for (const k of Reflect.ownKeys(dispatcher)) {
      const v = (dispatcher as Record<string | symbol, unknown>)[k as string];
      if (v && typeof v === 'object') {
        const maybeLookup = (v as { lookup?: unknown }).lookup;
        if (typeof maybeLookup === 'function') {
          lookup = maybeLookup as typeof lookup;
          break;
        }
        const connect = (v as { connect?: { lookup?: unknown } }).connect;
        if (connect && typeof connect.lookup === 'function') {
          lookup = connect.lookup as typeof lookup;
          break;
        }
      }
    }
    expect(lookup).toBeDefined();

    // all: true → cb gets a single addresses-array argument.
    await new Promise<void>((resolve, reject) => {
      lookup!('api.example.com', { all: true }, (err: unknown, addresses: unknown) => {
        try {
          expect(err).toBeNull();
          expect(addresses).toEqual([{ address: '8.8.8.8', family: 4 }]);
          resolve();
        } catch (e) {
          reject(e instanceof Error ? e : new Error(String(e)));
        }
      });
    });

    // all: false → cb gets (err, address, family) tuple.
    await new Promise<void>((resolve, reject) => {
      lookup!('api.example.com', { all: false }, (err: unknown, address: unknown, family: unknown) => {
        try {
          expect(err).toBeNull();
          expect(address).toBe('8.8.8.8');
          expect(family).toBe(4);
          resolve();
        } catch (e) {
          reject(e instanceof Error ? e : new Error(String(e)));
        }
      });
    });
  });
});

describe('ssrfSafeFetch — body cap', () => {
  let lookupSpy: jest.SpyInstance;

  beforeEach(() => {
    undiciFetchMock.mockReset();
    lookupSpy = jest.spyOn(dns, 'lookup');
    lookupSpy.mockResolvedValue([{ address: '8.8.8.8', family: 4 }]);
  });

  afterEach(() => {
    lookupSpy.mockRestore();
  });

  it('rejects when Content-Length declares > 10MB upfront', async () => {
    undiciFetchMock.mockResolvedValueOnce(
      new Response('', {
        status: 200,
        headers: new Headers({
          'content-length': String(20 * 1024 * 1024),
          'content-type': 'application/json',
        }),
      }),
    );

    await expect(
      ssrfSafeFetch({
        url: 'https://api.example.com/big',
        method: 'GET',
        headers: {},
      }),
    ).rejects.toThrow(SsrfError);
  });

  it('rejects when streamed body exceeds 10MB before EOF', async () => {
    const chunkSize = 1024 * 1024;
    const chunk = new Uint8Array(chunkSize).fill(0x41);

    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        for (let i = 0; i < 12; i++) {
          controller.enqueue(chunk);
        }
        controller.close();
      },
    });

    undiciFetchMock.mockResolvedValueOnce(
      new Response(stream, {
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
      }),
    );

    await expect(
      ssrfSafeFetch({
        url: 'https://api.example.com/streamed',
        method: 'GET',
        headers: {},
      }),
    ).rejects.toThrow(SsrfError);
  });

  it('returns small bodies normally', async () => {
    undiciFetchMock.mockResolvedValueOnce(
      new Response('{"hello":"world"}', {
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
      }),
    );
    const response = await ssrfSafeFetch({
      url: 'https://api.example.com/small',
      method: 'GET',
      headers: {},
    });
    expect(response.status).toBe(200);
    expect(response.body).toBe('{"hello":"world"}');
    expect(response.headers['content-type']).toBe('application/json');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SsrfError — public message must never leak internal DNS / IP / hostname
// ─────────────────────────────────────────────────────────────────────────────

describe('SsrfError — public vs internal messages', () => {
  let lookupSpy: jest.SpyInstance;

  beforeEach(() => {
    lookupSpy = jest.spyOn(dns, 'lookup');
  });

  afterEach(() => {
    lookupSpy.mockRestore();
  });

  /**
   * The user-facing `.message` is what `extractConnectorErrorDetails` surfaces
   * via `userFriendlyMessage`. It must NEVER contain the resolved IP, the
   * hostname, or the specific block reason — otherwise the connector becomes
   * an internal-DNS / IP oracle (probe `https://redis/` → response confirms
   * resolution + reveals the private IP).
   *
   * Verbose detail lives on `.internalDetails` for server-side logs only.
   */
  it('does not leak the resolved private IP into the public message', async () => {
    lookupSpy.mockResolvedValue([{ address: '10.42.99.123', family: 4 }]);
    let caught: unknown;
    try {
      await assertSafeUrl('https://internal-service.example/x');
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(SsrfError);
    const err = caught as SsrfError;
    expect(err.message).not.toContain('10.42.99.123');
    expect(err.message).not.toContain('internal-service.example');
    expect(err.message).not.toMatch(/RFC 1918/i);
    // Internal detail keeps the verbose info for server logs.
    expect(err.internalDetails).toContain('10.42.99.123');
    expect(err.internalDetails).toContain('internal-service.example');
  });

  it('does not leak DNS-failure details (resolver state) into the public message', async () => {
    lookupSpy.mockRejectedValue(new Error('ENOTFOUND some-internal-host'));
    let caught: unknown;
    try {
      await assertSafeUrl('https://some-internal-host/x');
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(SsrfError);
    const err = caught as SsrfError;
    expect(err.message).not.toContain('ENOTFOUND');
    expect(err.message).not.toContain('some-internal-host');
    expect(err.internalDetails).toContain('ENOTFOUND');
  });

  it('does not leak the literal private IP into the public message', async () => {
    let caught: unknown;
    try {
      await assertSafeUrl('https://169.254.169.254/latest/meta-data/');
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(SsrfError);
    const err = caught as SsrfError;
    expect(err.message).not.toContain('169.254.169.254');
    expect(err.message).not.toMatch(/link-local/i);
    expect(err.internalDetails).toContain('169.254.169.254');
  });

  it('still tells the user to use HTTPS (non-sensitive failure mode)', async () => {
    let caught: unknown;
    try {
      await assertSafeUrl('http://example.com/x');
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(SsrfError);
    expect((caught as SsrfError).message).toMatch(/HTTPS/i);
  });
});
