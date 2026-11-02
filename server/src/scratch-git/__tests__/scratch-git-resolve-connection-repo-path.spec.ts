import { BadRequestException, NotFoundException } from '@nestjs/common';
import { DbService } from '../../db/db.service';
import { ScratchGitClient } from '../scratch-git.client';
import { ScratchGitService } from '../scratch-git.service';

const WORKBOOK_ID = 'wkb_requested_by_caller';
const CONNECTOR_ACCOUNT_ID = 'coa_1';

function buildScratchGitService(connectorAccountFindUnique: jest.Mock): ScratchGitService {
  const db = { client: { connectorAccount: { findUnique: connectorAccountFindUnique } } } as unknown as DbService;
  return new ScratchGitService({} as ScratchGitClient, db);
}

describe('ScratchGitService.resolveConnectionRepoPathScopedToWorkbook (DEV-12337)', () => {
  it("returns the connection's repoPath when it belongs to the workbook", async () => {
    const connectorAccountFindUnique = jest.fn().mockResolvedValue({ repoPath: 'org/wkb/coa_1' });
    const scratchGitService = buildScratchGitService(connectorAccountFindUnique);

    await expect(
      scratchGitService.resolveConnectionRepoPathScopedToWorkbook(WORKBOOK_ID, CONNECTOR_ACCOUNT_ID),
    ).resolves.toBe('org/wkb/coa_1');

    expect(connectorAccountFindUnique).toHaveBeenCalledWith({
      where: { id: CONNECTOR_ACCOUNT_ID, workbookId: WORKBOOK_ID },
      select: { repoPath: true },
    });
  });

  it('throws NotFoundException for a connection in another workbook', async () => {
    // Prisma returns null when the id exists but the non-unique `workbookId` filter doesn't match.
    const connectorAccountFindUnique = jest.fn().mockResolvedValue(null);
    const scratchGitService = buildScratchGitService(connectorAccountFindUnique);

    await expect(
      scratchGitService.resolveConnectionRepoPathScopedToWorkbook(WORKBOOK_ID, 'coa_in_another_workbook'),
    ).rejects.toThrow(NotFoundException);
  });

  it('throws BadRequestException when no connection id is given', async () => {
    const connectorAccountFindUnique = jest.fn();
    const scratchGitService = buildScratchGitService(connectorAccountFindUnique);

    await expect(scratchGitService.resolveConnectionRepoPathScopedToWorkbook(WORKBOOK_ID, undefined)).rejects.toThrow(
      BadRequestException,
    );
    expect(connectorAccountFindUnique).not.toHaveBeenCalled();
  });

  it('throws BadRequestException when the connection has no repoPath', async () => {
    const connectorAccountFindUnique = jest.fn().mockResolvedValue({ repoPath: null });
    const scratchGitService = buildScratchGitService(connectorAccountFindUnique);

    await expect(
      scratchGitService.resolveConnectionRepoPathScopedToWorkbook(WORKBOOK_ID, CONNECTOR_ACCOUNT_ID),
    ).rejects.toThrow(BadRequestException);
  });
});
