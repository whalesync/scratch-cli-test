import { BaseJsonTableSpec, ConnectorFile } from '../../../types';
import { buildGongCallsJsonTableSpec, gongTableWsId } from '../gong-json-schema';
import { GongEntityType } from '../gong-types';

// Break the circular import chain that pulls in display-names → registry → DB.
jest.mock('../../../display-names', () => ({
  getServiceDisplayName: (service: string) => service,
}));

/**
 * Connector-level pagination contract: pullRecordFiles must checkpoint the
 * cursor via connectorProgress on EVERY page (so a stalled BullMQ job resumes
 * mid-stream instead of re-fetching from page 1), and must pass a resumed
 * cursor back to the client. Mocked because Gong ignores page-size params
 * (see gong-api-client.spec.ts) — live multi-page needs >100 records.
 */
const mockListCallsExtensive = jest.fn();
jest.mock('../gong-api-client', () => {
  const actual: object = jest.requireActual('../gong-api-client');
  return {
    ...actual,
    GongApiClient: jest.fn().mockImplementation(() => ({
      listCallsExtensive: mockListCallsExtensive,
    })),
  };
});

// jest.mock calls are hoisted above imports, so this import receives the mock.
import { GongConnector } from '../gong-connector';

const WORKSPACE_ID = '1299375510811165803';

function callsSpec(): BaseJsonTableSpec {
  return buildGongCallsJsonTableSpec(
    { wsId: gongTableWsId(GongEntityType.CALLS, WORKSPACE_ID), remoteId: ['calls', WORKSPACE_ID] },
    WORKSPACE_ID,
    'Initial workspace',
  );
}

describe('GongConnector pagination contract', () => {
  beforeEach(() => jest.clearAllMocks());

  it('checkpoints the cursor in connectorProgress on every page and clears it on the last', async () => {
    mockListCallsExtensive.mockImplementation(async function* () {
      await Promise.resolve();
      yield { items: [{ metaData: { id: 'c1' } }], nextCursor: 'PAGE-2' };
      yield { items: [{ metaData: { id: 'c2' } }], nextCursor: undefined };
    });

    const connector = new GongConnector('key', 'secret');
    const checkpoints: { fileIds: string[]; progress: unknown }[] = [];
    await connector.pullRecordFiles(
      callsSpec(),
      // eslint-disable-next-line @typescript-eslint/require-await
      async ({ files, connectorProgress }) => {
        checkpoints.push({
          fileIds: files.map((file) => (file as { metaData: { id: string } }).metaData.id),
          progress: connectorProgress,
        });
      },
      {},
      { pullMode: 'full' },
    );

    expect(checkpoints).toEqual([
      { fileIds: ['c1'], progress: { nextCursor: 'PAGE-2' } },
      { fileIds: ['c2'], progress: {} },
    ]);
    // Fresh pull starts with no cursor.
    expect(mockListCallsExtensive).toHaveBeenCalledWith(WORKSPACE_ID, undefined);
  });

  it('resumes from the checkpointed cursor after a stall/restart', async () => {
    mockListCallsExtensive.mockImplementation(async function* () {
      await Promise.resolve();
      yield { items: [{ metaData: { id: 'c3' } }], nextCursor: undefined };
    });

    const connector = new GongConnector('key', 'secret');
    const pulled: ConnectorFile[] = [];
    await connector.pullRecordFiles(
      callsSpec(),
      // eslint-disable-next-line @typescript-eslint/require-await
      async ({ files }) => {
        pulled.push(...files);
      },
      { nextCursor: 'RESUME-FROM-HERE' },
      { pullMode: 'full' },
    );

    expect(mockListCallsExtensive).toHaveBeenCalledWith(WORKSPACE_ID, 'RESUME-FROM-HERE');
    expect(pulled).toHaveLength(1);
  });
});
