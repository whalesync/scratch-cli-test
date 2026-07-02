/**
 * DEV-10596 — single-connection (connector-scoped) publish target resolution
 * (pure-logic tests).
 *
 * The load-bearing bit is the `connectorAccountId` null-guard: a connector node
 * whose folders carry no account id must resolve to `ok:false` so the
 * "Publish <connector>" menu item is withheld rather than publishing nothing.
 */

import { DataFolder } from '@spinner/shared-types';
import { describe, expect, it } from 'vitest';
import { resolveSingleConnectionPublishTarget } from '../single-connection-publish-target';

// Only `connectorAccountId` is read; cast minimal fixtures to the folder shape.
const folder = (connectorAccountId: string | null): Pick<DataFolder, 'connectorAccountId'> => ({ connectorAccountId });

describe('resolveSingleConnectionPublishTarget', () => {
  it('resolves a connector node into a publish target', () => {
    const result = resolveSingleConnectionPublishTarget('Webflow Site', [folder('ca_webflow'), folder('ca_webflow')]);
    expect(result).toEqual({
      ok: true,
      target: { connectionId: 'ca_webflow', connectionName: 'Webflow Site' },
    });
  });

  it('falls back to the first folder that carries a connector account id', () => {
    const result = resolveSingleConnectionPublishTarget('My Airtable', [folder(null), folder('ca_airtable')]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.target.connectionId).toBe('ca_airtable');
  });

  it('errors when no folder has a connector account id (null)', () => {
    const result = resolveSingleConnectionPublishTarget('Local Only', [folder(null)]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('No connector account id');
  });

  it('errors when the connector account id is an empty string', () => {
    const result = resolveSingleConnectionPublishTarget('Empty Id', [folder('')]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('No connector account id');
  });

  it('errors on an empty folder list', () => {
    const result = resolveSingleConnectionPublishTarget('No Tables', []);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('No tables found');
  });

  it('errors on an empty connection name', () => {
    const result = resolveSingleConnectionPublishTarget('', [folder('ca_webflow')]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('no name');
  });
});
