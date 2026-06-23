/* eslint-disable @typescript-eslint/unbound-method */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-call */
import { BadRequestException, NotFoundException } from '@nestjs/common';
import type { ConnectorAccount } from '@prisma/client';
import type { WorkbookId } from '@spinner/shared-types';
import { CredentialEncryptionService } from 'src/credential-encryption/credential-encryption.service';
import { DbService } from 'src/db/db.service';
import { OAuthService } from 'src/oauth/oauth.service';
import type { Actor } from 'src/users/types';
import { WorkbookService } from 'src/workbook/workbook.service';
import { OAuthInstallService } from '../oauth-install.service';

const ACTOR: Actor = { userId: 'usr_test', organizationId: 'org_test', authSource: 'user' } as Actor;

type PendingRow = {
  id: string;
  service: string;
  encryptedCredentials: unknown;
  workspaceId: string | null;
  displayName: string | null;
  claimedAt: Date | null;
  claimedByUserId: string | null;
  expiresAt: Date;
  createdAt: Date;
};

function makeRow(overrides: Partial<PendingRow> = {}): PendingRow {
  return {
    id: 'pin_abc',
    service: 'GOHIGHLEVEL',
    encryptedCredentials: { ciphertext: 'x' },
    workspaceId: 'loc_123',
    displayName: 'loc_123',
    claimedAt: null,
    claimedByUserId: null,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    createdAt: new Date(),
    ...overrides,
  };
}

describe('OAuthInstallService', () => {
  let service: OAuthInstallService;

  // Per-test mocks
  let pendingModel: {
    create: jest.Mock;
    findUnique: jest.Mock;
    findUniqueOrThrow: jest.Mock;
    updateMany: jest.Mock;
    delete: jest.Mock;
  };
  let db: jest.Mocked<DbService>;
  let oauthService: jest.Mocked<OAuthService>;
  let workbookService: jest.Mocked<WorkbookService>;
  let encryption: jest.Mocked<CredentialEncryptionService>;

  beforeEach(() => {
    pendingModel = {
      create: jest.fn().mockResolvedValue({}),
      findUnique: jest.fn(),
      findUniqueOrThrow: jest.fn(),
      updateMany: jest.fn(),
      delete: jest.fn().mockResolvedValue({}),
    };
    db = { client: { pendingOAuthInstall: pendingModel } } as unknown as jest.Mocked<DbService>;
    oauthService = {
      exchangeInboundCodeForTokens: jest.fn(),
      createConnectorAccountFromOAuthTokens: jest.fn(),
    } as unknown as jest.Mocked<OAuthService>;
    workbookService = {
      create: jest.fn(),
      delete: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<WorkbookService>;
    encryption = {
      encryptCredentials: jest.fn().mockResolvedValue({ ciphertext: 'enc' }),
      decryptCredentials: jest.fn(),
    } as unknown as jest.Mocked<CredentialEncryptionService>;

    service = new OAuthInstallService(db, oauthService, workbookService, encryption);
  });

  describe('redeemAndStashInstall', () => {
    it('exchanges the code, encrypts the tokens, and stashes a single-use install row', async () => {
      oauthService.exchangeInboundCodeForTokens.mockResolvedValue({
        access_token: 'at',
        refresh_token: 'rt',
        expires_in: 3600,
        workspace_id: 'loc_123',
      });

      const redirectUri = 'https://app.scratch.md/oauth/install/gohighlevel';
      const { installId, service: returnedService } = await service.redeemAndStashInstall(
        'gohighlevel',
        'code123',
        redirectUri,
      );

      // The install redirect URI is forwarded so the token exchange's redirect_uri matches.
      expect(oauthService.exchangeInboundCodeForTokens).toHaveBeenCalledWith('GOHIGHLEVEL', 'code123', redirectUri);
      expect(returnedService).toBe('GOHIGHLEVEL');
      expect(installId).toMatch(/^pin_/);

      expect(pendingModel.create).toHaveBeenCalledTimes(1);
      const createArg = pendingModel.create.mock.calls[0][0].data;
      expect(createArg.id).toBe(installId);
      expect(createArg.service).toBe('GOHIGHLEVEL');
      expect(createArg.workspaceId).toBe('loc_123');
      expect(createArg.encryptedCredentials).toEqual({ ciphertext: 'enc' });
      // Stashes the location id the connector reads back as oauthWorkspaceId.
      const encryptedArg = encryption.encryptCredentials.mock.calls[0][0];
      expect(encryptedArg.oauthWorkspaceId).toBe('loc_123');
      expect(encryptedArg.oauthAccessToken).toBe('at');
      // TTL is in the future (~1h).
      expect(createArg.expiresAt.getTime()).toBeGreaterThan(Date.now());
      expect(createArg.expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + 60 * 60 * 1000 + 1000);
    });

    it('propagates a provider failure (bad/expired code) from the exchange', async () => {
      oauthService.exchangeInboundCodeForTokens.mockRejectedValue(
        new BadRequestException('HighLevel authorization failed'),
      );
      await expect(service.redeemAndStashInstall('gohighlevel', 'bad')).rejects.toThrow(
        'HighLevel authorization failed',
      );
      expect(pendingModel.create).not.toHaveBeenCalled();
    });

    it('resolves the brand-free install slug "hl" to the GOHIGHLEVEL service (GHL bans its brand in redirect URLs)', async () => {
      oauthService.exchangeInboundCodeForTokens.mockResolvedValue({ access_token: 'at', workspace_id: 'loc_1' });

      await service.redeemAndStashInstall('hl', 'code', 'https://app.scratch.md/oauth/install/hl');

      // The slug maps to the canonical provider key for the exchange and the stashed row.
      expect(oauthService.exchangeInboundCodeForTokens).toHaveBeenCalledWith(
        'GOHIGHLEVEL',
        'code',
        'https://app.scratch.md/oauth/install/hl',
      );
      expect(pendingModel.create.mock.calls[0][0].data.service).toBe('GOHIGHLEVEL');
    });
  });

  describe('getPendingInstall', () => {
    it('returns metadata (never tokens) for a valid, unclaimed, unexpired install', async () => {
      pendingModel.findUnique.mockResolvedValue(makeRow());
      const info = await service.getPendingInstall('pin_abc');
      expect(info).toEqual({
        service: 'GOHIGHLEVEL',
        serviceDisplayName: expect.any(String),
        workspaceId: 'loc_123',
        displayName: 'loc_123',
        expiresAt: expect.any(String),
      });
      // No token field leaks into the metadata.
      expect(JSON.stringify(info)).not.toContain('access');
    });

    it('throws NotFound when the install is missing', async () => {
      pendingModel.findUnique.mockResolvedValue(null);
      await expect(service.getPendingInstall('pin_missing')).rejects.toBeInstanceOf(NotFoundException);
    });

    it('throws NotFound when the install was already claimed', async () => {
      pendingModel.findUnique.mockResolvedValue(makeRow({ claimedAt: new Date() }));
      await expect(service.getPendingInstall('pin_abc')).rejects.toBeInstanceOf(NotFoundException);
    });

    it('throws NotFound when the install has expired', async () => {
      pendingModel.findUnique.mockResolvedValue(makeRow({ expiresAt: new Date(Date.now() - 1000) }));
      await expect(service.getPendingInstall('pin_abc')).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('claimInstall', () => {
    function arrangeHappyPath() {
      pendingModel.updateMany.mockResolvedValue({ count: 1 });
      pendingModel.findUniqueOrThrow.mockResolvedValue(makeRow());
      encryption.decryptCredentials.mockResolvedValue({
        oauthAccessToken: 'at',
        oauthRefreshToken: 'rt',
        oauthExpiresAt: new Date(Date.now() + 3600 * 1000).toISOString(),
        oauthWorkspaceId: 'loc_123',
      });
      workbookService.create.mockResolvedValue({ id: 'wkb_new' as WorkbookId } as never);
      oauthService.createConnectorAccountFromOAuthTokens.mockResolvedValue({ id: 'ca_new' } as ConnectorAccount);
    }

    it('reserves, auto-creates a workbook, persists the connection, and consumes the row', async () => {
      arrangeHappyPath();

      const result = await service.claimInstall('pin_abc', ACTOR);

      expect(result).toEqual({ connectorAccountId: 'ca_new', workbookId: 'wkb_new' });
      // Atomic reserve ran first, scoped to unclaimed + unexpired.
      expect(pendingModel.updateMany).toHaveBeenCalledWith({
        where: { id: 'pin_abc', claimedAt: null, expiresAt: { gt: expect.any(Date) } },
        data: { claimedAt: expect.any(Date), claimedByUserId: 'usr_test' },
      });
      expect(workbookService.create).toHaveBeenCalledTimes(1);
      expect(oauthService.createConnectorAccountFromOAuthTokens).toHaveBeenCalledWith(
        'GOHIGHLEVEL',
        'wkb_new',
        ACTOR,
        expect.objectContaining({ access_token: 'at', workspace_id: 'loc_123' }),
      );
      // Single-use: the pending row is deleted on success.
      expect(pendingModel.delete).toHaveBeenCalledWith({ where: { id: 'pin_abc' } });
    });

    it('rejects a double-claim (reservation already taken) without creating anything', async () => {
      pendingModel.updateMany.mockResolvedValue({ count: 0 });

      await expect(service.claimInstall('pin_abc', ACTOR)).rejects.toBeInstanceOf(BadRequestException);
      expect(workbookService.create).not.toHaveBeenCalled();
      expect(oauthService.createConnectorAccountFromOAuthTokens).not.toHaveBeenCalled();
      expect(pendingModel.delete).not.toHaveBeenCalled();
    });

    it('rejects an expired/invalid claim (reservation matches nothing)', async () => {
      pendingModel.updateMany.mockResolvedValue({ count: 0 });
      await expect(service.claimInstall('pin_expired', ACTOR)).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rolls back the workbook and releases the reservation if persisting the connection fails', async () => {
      arrangeHappyPath();
      oauthService.createConnectorAccountFromOAuthTokens.mockRejectedValue(new Error('repo init failed'));

      await expect(service.claimInstall('pin_abc', ACTOR)).rejects.toThrow('repo init failed');

      // The half-created workbook is deleted...
      expect(workbookService.delete).toHaveBeenCalledWith('wkb_new', ACTOR);
      // ...and the reservation is released so the user can retry within the TTL.
      expect(pendingModel.updateMany).toHaveBeenLastCalledWith({
        where: { id: 'pin_abc' },
        data: { claimedAt: null, claimedByUserId: null },
      });
      // The row is NOT consumed on failure.
      expect(pendingModel.delete).not.toHaveBeenCalled();
    });
  });
});
