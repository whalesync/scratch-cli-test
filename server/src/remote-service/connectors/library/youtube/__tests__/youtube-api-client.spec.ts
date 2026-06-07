import axios from 'axios';
import { YoutubeApiClient } from '../youtube-api-client';

// Mock create-api-client to return a mock axios instance whose verbs we can
// inspect. This pins the exact path / query / body each method sends — the whole
// point of an api-client test (the connector-level spec mocks the entire client
// and so can't catch a wrong URL, a dropped query param, or a mis-shaped body).
const mockGet = jest.fn();
const mockPut = jest.fn();
const mockRequest = jest.fn();

jest.mock('../../../create-api-client', () => ({
  createApiClient: jest.fn(() => ({
    get: mockGet,
    put: mockPut,
    request: mockRequest,
  })),
}));

import { createApiClient } from '../../../create-api-client';

/** Build an axios error carrying a given HTTP status (and optional response body). */
function makeAxiosError(status: number, data: unknown = {}): axios.AxiosError {
  return new axios.AxiosError(`Request failed with status code ${status}`, String(status), undefined, undefined, {
    status,
    statusText: '',
    headers: {},
    config: {} as never,
    data,
  });
}

/** The shape of the axios request config our multipart caption uploads pass. */
interface CapturedRequest {
  method: string;
  url: string;
  params: Record<string, unknown>;
  headers: Record<string, string>;
  data: string;
}

/** Typed accessor for the Nth `http.request(...)` config, dodging mock `any`. */
function capturedRequest(callIndex = 0): CapturedRequest {
  const calls = mockRequest.mock.calls as [CapturedRequest][];
  return calls[callIndex][0];
}

describe('YoutubeApiClient', () => {
  let client: YoutubeApiClient;

  beforeEach(() => {
    jest.clearAllMocks();
    client = new YoutubeApiClient('test-token');
  });

  describe('constructor', () => {
    it('configures the v3 base URL, Bearer auth, and repeated-array query params', () => {
      expect(createApiClient).toHaveBeenCalledWith({
        baseURL: 'https://youtube.googleapis.com/youtube/v3',
        headers: { Authorization: 'Bearer test-token' },
        paramsSerializer: { indexes: null },
      });
    });
  });

  describe('getChannels', () => {
    it('GETs /channels with mine=true and the id/snippet parts', async () => {
      mockGet.mockResolvedValue({ data: { items: [{ id: 'c1' }] } });
      const result = await client.getChannels();
      expect(mockGet).toHaveBeenCalledWith('/channels', {
        params: { part: ['id', 'snippet'], mine: true, maxResults: 100 },
      });
      expect(result).toEqual({ items: [{ id: 'c1' }] });
    });
  });

  describe('getChannelsByIds', () => {
    it('GETs /channels filtered by the given channel ids', async () => {
      mockGet.mockResolvedValue({ data: { items: [] } });
      await client.getChannelsByIds(['c1', 'c2']);
      expect(mockGet).toHaveBeenCalledWith('/channels', {
        params: { part: ['id', 'snippet'], id: ['c1', 'c2'], maxResults: 100 },
      });
    });
  });

  describe('getVideos', () => {
    it('resolves the uploads playlist, lists its items, then fetches full videos', async () => {
      mockGet
        // 1) channel contentDetails → uploads playlist id
        .mockResolvedValueOnce({
          data: { items: [{ contentDetails: { relatedPlaylists: { uploads: 'UU123' } } }] },
        })
        // 2) playlistItems → resourceId.videoId for each
        .mockResolvedValueOnce({
          data: { items: [{ snippet: { resourceId: { videoId: 'v1' } } }], nextPageToken: 'NEXT', etag: 'e' },
        })
        // 3) videos.list → full video resources
        .mockResolvedValueOnce({ data: { items: [{ id: 'v1', snippet: { title: 'T' } }] } });

      const result = await client.getVideos('chan1', 'PAGE');

      expect(mockGet).toHaveBeenNthCalledWith(1, '/channels', {
        params: { part: ['contentDetails'], id: ['chan1'] },
      });
      expect(mockGet).toHaveBeenNthCalledWith(2, '/playlistItems', {
        params: { part: ['snippet'], playlistId: 'UU123', maxResults: 100, pageToken: 'PAGE' },
      });
      expect(mockGet).toHaveBeenNthCalledWith(3, '/videos', {
        params: { part: ['snippet', 'id', 'statistics', 'status'], id: ['v1'] },
      });
      expect(result).toMatchObject({
        items: [{ id: 'v1', snippet: { title: 'T' } }],
        nextPageToken: 'NEXT',
        kind: 'youtube#videoListResponse',
        etag: 'e',
      });
    });

    it('throws when the channel has no uploads playlist', async () => {
      mockGet.mockResolvedValueOnce({ data: { items: [{ contentDetails: {} }] } });
      await expect(client.getVideos('chan1')).rejects.toThrow('Could not find uploads playlist for channel chan1');
    });

    it('returns an empty list (carrying pagination) when the uploads playlist is empty', async () => {
      mockGet
        .mockResolvedValueOnce({ data: { items: [{ contentDetails: { relatedPlaylists: { uploads: 'UU' } } }] } })
        .mockResolvedValueOnce({ data: { items: [], nextPageToken: 'N2' } });
      const result = await client.getVideos('chan1');
      expect(result).toMatchObject({ items: [], nextPageToken: 'N2', kind: 'youtube#videoListResponse' });
      // No videos.list call should fire.
      expect(mockGet).toHaveBeenCalledTimes(2);
    });
  });

  describe('getVideo', () => {
    it('GETs /videos for a single id with the full part list', async () => {
      mockGet.mockResolvedValue({ data: { items: [{ id: 'v9' }] } });
      const result = await client.getVideo('v9');
      expect(mockGet).toHaveBeenCalledWith('/videos', {
        params: { part: ['snippet', 'id', 'statistics', 'status'], id: ['v9'] },
      });
      expect(result).toEqual({ items: [{ id: 'v9' }] });
    });
  });

  describe('updateVideo', () => {
    it('PUTs /videos with the snippet body and snippet/id parts, returning the persisted video verbatim', async () => {
      mockPut.mockResolvedValue({ data: { id: 'v1', snippet: { title: 'New' } } });
      const snippet = { title: 'New', categoryId: '22' };
      const result = await client.updateVideo('v1', snippet);
      expect(mockPut).toHaveBeenCalledWith('/videos', { id: 'v1', snippet }, { params: { part: ['snippet', 'id'] } });
      expect(result).toEqual({ id: 'v1', snippet: { title: 'New' } });
    });
  });

  describe('getVideoTranscript', () => {
    it('lists captions then downloads the English SRT track from /captions/{id}', async () => {
      mockGet
        .mockResolvedValueOnce({ data: { items: [{ id: 'cap1', snippet: { language: 'en' } }] } })
        .mockResolvedValueOnce({ data: Buffer.from('1\n00:00 --> 00:01\nhello', 'utf-8') });

      const result = await client.getVideoTranscript('v1');

      expect(mockGet).toHaveBeenNthCalledWith(1, '/captions', { params: { part: ['snippet'], videoId: 'v1' } });
      expect(mockGet).toHaveBeenNthCalledWith(2, '/captions/cap1', {
        params: { tfmt: 'srt' },
        responseType: 'arraybuffer',
      });
      expect(result.id).toBe('cap1');
      expect(result.text).toContain('hello');
    });

    it('returns a friendly message (no download) when no English track exists', async () => {
      mockGet.mockResolvedValueOnce({ data: { items: [{ id: 'cap1', snippet: { language: 'fr' } }] } });
      const result = await client.getVideoTranscript('v1');
      expect(result).toEqual({
        text: 'No English transcript found for video v1',
        id: null,
        captionListItems: [{ id: 'cap1', snippet: { language: 'fr' } }],
      });
      expect(mockGet).toHaveBeenCalledTimes(1);
    });

    it('maps a 403 on the caption list to an access-denied message', async () => {
      mockGet.mockRejectedValueOnce(makeAxiosError(403));
      const result = await client.getVideoTranscript('v1');
      expect(result).toEqual({ text: 'Access denied for transcript of video v1', id: null, captionListItems: null });
    });
  });

  describe('createTranscript', () => {
    it('multipart-POSTs the caption to the upload endpoint and returns the new id', async () => {
      mockRequest.mockResolvedValue({ data: { id: 'newcap' } });
      const id = await client.createTranscript('v1', 'the text', 'en');

      expect(id).toBe('newcap');
      expect(mockRequest).toHaveBeenCalledTimes(1);
      const arg = capturedRequest();
      expect(arg.method).toBe('post');
      expect(arg.url).toBe('https://youtube.googleapis.com/upload/youtube/v3/captions');
      expect(arg.params).toEqual({ part: ['snippet'], uploadType: 'multipart' });
      expect(arg.headers['Content-Type']).toMatch(/^multipart\/related; boundary=/);
      // The JSON resource and the caption text are both present in the related body.
      expect(arg.data).toContain('content-type: application/json');
      expect(arg.data).toContain('"videoId":"v1"');
      expect(arg.data).toContain('content-type: text/plain');
      expect(arg.data).toContain('the text');
    });

    it('maps a 403 to an access-denied error', async () => {
      mockRequest.mockRejectedValue(makeAxiosError(403));
      await expect(client.createTranscript('v1', 'x')).rejects.toThrow('Access denied for creating transcript');
    });
  });

  describe('updateTranscript', () => {
    it('multipart-uploads the replacement text for a draft caption track', async () => {
      mockGet.mockResolvedValueOnce({
        data: { items: [{ id: 'cap1', snippet: { language: 'en', trackKind: 'standard', status: 'draft' } }] },
      });
      mockRequest.mockResolvedValue({ data: { id: 'cap1' } });

      await client.updateTranscript('v1', 'cap1', 'updated text');

      expect(mockGet).toHaveBeenCalledWith('/captions', {
        params: { part: ['snippet'], id: ['cap1'], videoId: 'v1' },
      });
      const arg = capturedRequest();
      expect(arg.method).toBe('put');
      expect(arg.url).toBe('https://youtube.googleapis.com/upload/youtube/v3/captions');
      expect(arg.data).toContain('updated text');
    });

    it('maps a 403 whose API body mentions auto-generated captions to the replace-instead error', async () => {
      mockGet.mockResolvedValueOnce({
        data: { items: [{ id: 'cap1', snippet: { language: 'en', trackKind: 'standard', status: 'draft' } }] },
      });
      mockRequest.mockRejectedValue(
        makeAxiosError(403, { error: { message: 'The caption track is auto-generated and cannot be updated.' } }),
      );
      await expect(client.updateTranscript('v1', 'cap1', 'x')).rejects.toThrow(
        'Cannot update auto-generated captions. Please upload a new caption track instead.',
      );
    });

    it('refuses to update a serving caption track', async () => {
      mockGet.mockResolvedValueOnce({
        data: { items: [{ id: 'cap1', snippet: { trackKind: 'standard', status: 'serving' } }] },
      });
      await expect(client.updateTranscript('v1', 'cap1', 'x')).rejects.toThrow(
        "Cannot update caption track in 'serving' status",
      );
    });

    it('hides + recreates an auto-generated (asr) caption track', async () => {
      // 1) updateTranscript list → asr track
      mockGet.mockResolvedValueOnce({
        data: { items: [{ id: 'cap1', snippet: { language: 'en', trackKind: 'asr' } }] },
      });
      // 2) hideAutoGeneratedTranscript list → same asr track
      mockGet.mockResolvedValueOnce({
        data: { items: [{ id: 'cap1', snippet: { language: 'en', trackKind: 'asr' } }] },
      });
      mockPut.mockResolvedValue({ data: { id: 'cap1' } }); // the hide (draft) PUT
      mockRequest.mockResolvedValue({ data: { id: 'newcap' } }); // the recreate upload

      await client.updateTranscript('v1', 'cap1', 'fresh text');

      // The hide step PUTs /captions with isDraft:true and no media.
      expect(mockPut).toHaveBeenCalledWith(
        '/captions',
        { id: 'cap1', snippet: { language: 'en', trackKind: 'asr', isDraft: true } },
        { params: { part: ['snippet'] } },
      );
      // The recreate step multipart-POSTs a new track.
      expect(capturedRequest().method).toBe('post');
    });
  });
});
