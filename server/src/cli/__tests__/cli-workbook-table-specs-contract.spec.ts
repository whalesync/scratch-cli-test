import type { CliWorkbookTableSpecsResponse } from '@spinner/shared-types';
import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import { ScratchConfigService } from 'src/config/scratch-config.service';
import { DbService } from 'src/db/db.service';
import { CustomMetricsService } from 'src/metrics/custom-metrics-service';
import { ScratchGitService } from 'src/scratch-git/scratch-git.service';
import { DataFolderTableSpecStoreService } from 'src/workbook/table-spec-store/data-folder-table-spec-store.service';
import { CliWorkbookTableSpecsEntity } from '../entities/cli-workbook-table-specs.entity';

/**
 * Cross-language contract for `GET /cli/v1/workbooks/:id/table-specs` (DEV-13025). `scratchmd` deserializes this same
 * fixture in its own tests and checks that the SHA-256 it computes over the UTF-8 bytes of each `content` (the bytes
 * it writes to disk, and the DEV-10518 schema hash) equals the `sha256` the server sent. Pinning the server's wire
 * output to the fixture here means a change to the hashing, the byte handling (multibyte text, lone-surrogate escape
 * text, the trailing newline), or the response shape fails one suite or the other.
 */
const CLI_WORKBOOK_TABLE_SPECS_RESPONSE_FIXTURE = JSON.parse(
  readFileSync(
    join(__dirname, '../../../../scratch-git-2/tests/fixtures/cli-workbook-table-specs-response.json'),
    'utf8',
  ),
) as CliWorkbookTableSpecsResponse;

function sha256OfUtf8(text: string): string {
  return createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
}

describe('GET /cli/v1/workbooks/:id/table-specs wire contract (DEV-13025)', () => {
  it("hashes every present file's content as UTF-8 bytes", () => {
    for (const { dataFolders } of CLI_WORKBOOK_TABLE_SPECS_RESPONSE_FIXTURE.connectorAccounts) {
      for (const { tableSpec, defaultView } of dataFolders) {
        for (const listedFile of [tableSpec, defaultView]) {
          if (listedFile.status !== 'present') continue;
          expect(listedFile.content).toBeDefined();
          expect(sha256OfUtf8(listedFile.content ?? '')).toBe(listedFile.sha256);
        }
      }
    }
  });

  it('serves exactly the fixture for the stored rows behind it', async () => {
    // Rebuild the stored rows from the fixture: a present file's content IS the stored text; `unreadable` needs a
    // stored text that isn't a JSON object.
    const storedRowsByConnection = CLI_WORKBOOK_TABLE_SPECS_RESPONSE_FIXTURE.connectorAccounts.map(
      ({ connectorAccountId, dataFolders }) => ({
        id: connectorAccountId,
        dataFolders: dataFolders.map(({ dataFolderId, path, storedRowUpdatedAt, tableSpec, defaultView }) => ({
          id: dataFolderId,
          path,
          storedTableSpecRow:
            storedRowUpdatedAt === null
              ? null
              : {
                  tableSpecContent: tableSpec.status === 'present' ? (tableSpec.content ?? '') : 'not a json object',
                  defaultViewContent: defaultView.status === 'present' ? (defaultView.content ?? '') : null,
                  updatedAt: new Date(storedRowUpdatedAt),
                },
        })),
      }),
    );
    const store = new DataFolderTableSpecStoreService(
      {
        client: { connectorAccount: { findMany: jest.fn().mockResolvedValue(storedRowsByConnection) } },
      } as unknown as DbService,
      {} as ScratchGitService,
      { isTableSpecPostgresReadsEnabled: () => true } as unknown as ScratchConfigService,
      { logValue: jest.fn() } as unknown as CustomMetricsService,
    );

    const connectionsForCliCacheRefresh = await store.readTableSpecsAndDefaultViewsForCliCacheRefresh(
      CLI_WORKBOOK_TABLE_SPECS_RESPONSE_FIXTURE.workbookId,
      { includeContent: true },
    );
    const servedWireBody: unknown = JSON.parse(
      JSON.stringify(
        CliWorkbookTableSpecsEntity.from(
          CLI_WORKBOOK_TABLE_SPECS_RESPONSE_FIXTURE.workbookId,
          connectionsForCliCacheRefresh,
        ),
      ),
    );

    expect(servedWireBody).toEqual(CLI_WORKBOOK_TABLE_SPECS_RESPONSE_FIXTURE);
  });
});
