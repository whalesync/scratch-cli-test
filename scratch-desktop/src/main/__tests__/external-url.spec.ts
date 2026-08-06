import { describe, expect, it } from 'vitest';
import { isSafeExternalUrl, type ExternalUrlPolicy } from '../external-url';

/** What a `yarn dev` build uses: `VITE_SCRATCH_WEB_URL` defaults to `http://localhost:3000`. */
const DEVELOPMENT_POLICY: ExternalUrlPolicy = { allowLoopbackHttp: true };

/** What every shipped build uses. */
const PACKAGED_POLICY: ExternalUrlPolicy = { allowLoopbackHttp: false };

describe('isSafeExternalUrl', () => {
  it('allows the https URLs the app actually opens', () => {
    // Every real caller: Stripe checkout, device-code login, status page, the web client, and
    // the connector "view in service" links (which connectors build as https by construction).
    expect(isSafeExternalUrl('https://checkout.stripe.com/c/pay/cs_test_123', PACKAGED_POLICY)).toBe(true);
    expect(isSafeExternalUrl('https://app.scratch.md/settings/billing', PACKAGED_POLICY)).toBe(true);
    expect(isSafeExternalUrl('https://status.scratch.md', PACKAGED_POLICY)).toBe(true);
    expect(isSafeExternalUrl('https://airtable.com/appABC/tblXYZ', PACKAGED_POLICY)).toBe(true);
    expect(isSafeExternalUrl('https://claude.ai/download', PACKAGED_POLICY)).toBe(true);
  });

  it('allows plain http on loopback in development only', () => {
    expect(isSafeExternalUrl('http://localhost:3000/settings/billing', DEVELOPMENT_POLICY)).toBe(true);
    expect(isSafeExternalUrl('http://127.0.0.1:3000/workbook/abc/review', DEVELOPMENT_POLICY)).toBe(true);
    expect(isSafeExternalUrl('http://[::1]:3000/', DEVELOPMENT_POLICY)).toBe(true);
  });

  it('rejects plain http entirely in a packaged build', () => {
    // Otherwise a compromised renderer gets a top-level GET against any local service on any
    // port — an admin panel, a dev server, a database UI.
    expect(isSafeExternalUrl('http://localhost:3000/settings/billing', PACKAGED_POLICY)).toBe(false);
    expect(isSafeExternalUrl('http://127.0.0.1:9200/_cluster/nodes', PACKAGED_POLICY)).toBe(false);
    expect(isSafeExternalUrl('http://localhost:8080/admin', PACKAGED_POLICY)).toBe(false);
  });

  it('rejects plain http on remote hosts even in development', () => {
    expect(isSafeExternalUrl('http://evil.com/', DEVELOPMENT_POLICY)).toBe(false);
    expect(isSafeExternalUrl('http://app.scratch.md/settings/billing', DEVELOPMENT_POLICY)).toBe(false);
  });

  it('does not treat loopback-prefixed hostnames as loopback', () => {
    // `startsWith`-style matching would let these through; the check is an exact hostname match.
    expect(isSafeExternalUrl('http://localhost.evil.com/', DEVELOPMENT_POLICY)).toBe(false);
    expect(isSafeExternalUrl('http://127.0.0.1.evil.com/', DEVELOPMENT_POLICY)).toBe(false);
    expect(isSafeExternalUrl('http://notlocalhost/', DEVELOPMENT_POLICY)).toBe(false);
  });

  it('is not fooled by userinfo that makes a remote host look like loopback', () => {
    // `new URL('http://localhost@evil.com/').hostname` is `evil.com` — the check must read the
    // hostname, never the raw string.
    expect(isSafeExternalUrl('http://localhost@evil.com/', DEVELOPMENT_POLICY)).toBe(false);
    expect(isSafeExternalUrl('http://127.0.0.1@evil.com/', DEVELOPMENT_POLICY)).toBe(false);
  });

  it('rejects the schemes Oneleet demonstrated (SCR-003)', () => {
    // The exact repro from the pentest report.
    expect(isSafeExternalUrl('file:///C:/Windows/System32/', DEVELOPMENT_POLICY)).toBe(false);
    expect(isSafeExternalUrl('file:///etc/passwd', DEVELOPMENT_POLICY)).toBe(false);
    // NTLM relay / credential leak on Windows.
    expect(isSafeExternalUrl('smb://attacker.example.com/share', DEVELOPMENT_POLICY)).toBe(false);
  });

  it('rejects script-ish and data schemes', () => {
    expect(isSafeExternalUrl('javascript:alert(1)', DEVELOPMENT_POLICY)).toBe(false);
    expect(isSafeExternalUrl('data:text/html,<script>alert(1)</script>', DEVELOPMENT_POLICY)).toBe(false);
    expect(isSafeExternalUrl('vbscript:msgbox(1)', DEVELOPMENT_POLICY)).toBe(false);
  });

  it('rejects custom application handlers, including the ones the app itself launches', () => {
    // These must go through `buildAgentDeepLinkUrl`, never through the general-purpose verb —
    // otherwise the renderer regains the ability to pick a target application.
    expect(isSafeExternalUrl('claude://code/new?q=hi&folder=/tmp', DEVELOPMENT_POLICY)).toBe(false);
    expect(isSafeExternalUrl('codex://new?prompt=hi&path=/tmp', DEVELOPMENT_POLICY)).toBe(false);
    expect(isSafeExternalUrl('slack://channel?id=C123', DEVELOPMENT_POLICY)).toBe(false);
    expect(isSafeExternalUrl('ms-msdt:/id', DEVELOPMENT_POLICY)).toBe(false);
  });

  it('rejects malformed input without throwing', () => {
    expect(isSafeExternalUrl('', DEVELOPMENT_POLICY)).toBe(false);
    expect(isSafeExternalUrl('   ', DEVELOPMENT_POLICY)).toBe(false);
    expect(isSafeExternalUrl('not a url', DEVELOPMENT_POLICY)).toBe(false);
    expect(isSafeExternalUrl('//example.com/protocol-relative', DEVELOPMENT_POLICY)).toBe(false);
    expect(isSafeExternalUrl('https://', DEVELOPMENT_POLICY)).toBe(false);
  });

  it('normalises scheme casing rather than being fooled by it', () => {
    expect(isSafeExternalUrl('HTTPS://app.scratch.md/', PACKAGED_POLICY)).toBe(true);
    expect(isSafeExternalUrl('FILE:///etc/passwd', PACKAGED_POLICY)).toBe(false);
    expect(isSafeExternalUrl('JaVaScRiPt:alert(1)', PACKAGED_POLICY)).toBe(false);
  });
});
