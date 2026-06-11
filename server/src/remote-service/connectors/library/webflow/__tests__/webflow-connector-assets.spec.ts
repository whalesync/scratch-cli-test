import { WebflowConnector } from '../webflow-connector';

// Mock display-names to break circular import chain (it imports all connectors)
jest.mock('../../../display-names', () => ({
  getServiceDisplayName: jest.fn(() => 'Webflow'),
}));

// Mock the WebflowApiClient so the connector's internal `this.client` is the mock.
jest.mock('../webflow-api-client', () => ({
  WebflowApiClient: jest.fn().mockImplementation(() => ({})),
  WebflowError: class WebflowError extends Error {},
}));

const PENDING_ID = 'scratch_pending_publish_abc123';
const REAL_FILE_ID = '6620webflowfileid000';
const DEST_URL = 'https://cdn.example.com/dest/file.jpg';
const REHOSTED_URL = 'https://storage.googleapis.com/bucket/file.jpg';

// Webflow Image/File writes require an OBJECT with BOTH fileId and url to reference an
// existing asset — a bare { fileId } is rejected with "Expected value to have a 'url'
// field" (verified against the live API in webflow-connector-assets integration spec).
describe('WebflowConnector.resolveAssetReference', () => {
  let connector: WebflowConnector;

  beforeEach(() => {
    jest.clearAllMocks();
    connector = new WebflowConnector('test-token');
  });

  it('references a pre-uploaded destination asset by { fileId, url }', () => {
    // The asset-upload phase minted a real fileId and wrote the destination url back
    // onto the Asset row — reference it (idempotent: Webflow re-ingests nothing).
    expect(
      connector.resolveAssetReference({ remoteAssetId: REAL_FILE_ID, rehostedUrl: REHOSTED_URL, url: DEST_URL }),
    ).toEqual({ fileId: REAL_FILE_ID, url: DEST_URL });
  });

  it('falls back to the rehosted url when the destination url is absent', () => {
    expect(
      connector.resolveAssetReference({ remoteAssetId: REAL_FILE_ID, rehostedUrl: REHOSTED_URL, url: null }),
    ).toEqual({ fileId: REAL_FILE_ID, url: REHOSTED_URL });
  });

  it('re-hosts via { url } when the destination asset is still a pending placeholder', () => {
    // Not yet uploaded — hand Webflow a public URL. Prefer the permanent rehosted (GCS)
    // url over the possibly-expiring source url.
    expect(
      connector.resolveAssetReference({ remoteAssetId: PENDING_ID, rehostedUrl: REHOSTED_URL, url: DEST_URL }),
    ).toEqual({ url: REHOSTED_URL });
  });

  it('falls back to the source url when a pending asset has no rehosted url', () => {
    expect(connector.resolveAssetReference({ remoteAssetId: PENDING_ID, rehostedUrl: null, url: DEST_URL })).toEqual({
      url: DEST_URL,
    });
  });

  it('returns null for a pending asset with no usable url', () => {
    expect(connector.resolveAssetReference({ remoteAssetId: PENDING_ID, rehostedUrl: null, url: null })).toBeNull();
  });
});
