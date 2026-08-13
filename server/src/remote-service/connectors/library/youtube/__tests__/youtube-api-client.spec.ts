import axios from 'axios';
import { YoutubeApiClient } from '../youtube-api-client';

// Mock create-api-client to return a mock axios instance whose verbs we can
// inspect. This pins the exact path / query / body each method sends — the whole
// point of an api-client test (the connector-level spec mocks the entire client
// and so can't catch a wrong URL, a dropped query param, or a mis-shaped body).
const mockGet = jest.fn();
const mockPut = jest.fn();
const mockPost = jest.fn();
const mockDelete = jest.fn();
const mockRequest = jest.fn();

/**
 * Every `authorizationHeaderValueProvider` handed to `createApiClient`, in call
 * order. Captured here (rather than dug out of `mock.calls`) so the provider stays
 * typed — the client resolves its bearer token per request now, so the provider is
 * the thing worth asserting on.
 */
const mockAuthorizationHeaderValueProviders: (() => Promise<string>)[] = [];

jest.mock('../../../create-api-client', () => ({
  createApiClient: jest.fn(
    (_config?: unknown, options?: { authorizationHeaderValueProvider?: () => Promise<string> }) => {
      if (options?.authorizationHeaderValueProvider) {
        mockAuthorizationHeaderValueProviders.push(options.authorizationHeaderValueProvider);
      }
      return {
        get: mockGet,
        put: mockPut,
        post: mockPost,
        delete: mockDelete,
        request: mockRequest,
      };
    },
  ),
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
    mockAuthorizationHeaderValueProviders.length = 0;
    client = new YoutubeApiClient('test-token');
  });

  describe('constructor', () => {
    it('configures the v3 base URL, Bearer auth, and repeated-array query params', async () => {
      // The bearer token is supplied as a provider rather than a static header, so
      // a job longer than the token's lifetime picks up the refresh (DEV-11270).
      expect(createApiClient).toHaveBeenCalledWith(
        {
          baseURL: 'https://youtube.googleapis.com/youtube/v3',
          paramsSerializer: { indexes: null },
        },
        { authorizationHeaderValueProvider: mockAuthorizationHeaderValueProviders[0] },
      );
      await expect(mockAuthorizationHeaderValueProviders[0]()).resolves.toBe('Bearer test-token');
    });

    it('re-resolves the bearer token on every request so a refreshed OAuth token is used', async () => {
      const accessTokens = ['first-token', 'second-token'];
      new YoutubeApiClient(() => Promise.resolve(accessTokens.shift() ?? 'exhausted'));

      const provider = mockAuthorizationHeaderValueProviders[1];
      await expect(provider()).resolves.toBe('Bearer first-token');
      await expect(provider()).resolves.toBe('Bearer second-token');
    });
  });

  describe('getChannels', () => {
    it('GETs /channels with mine=true and the id/snippet parts', async () => {
      mockGet.mockResolvedValue({ data: { items: [{ id: 'c1' }] } });
      const result = await client.getChannels();
      expect(mockGet).toHaveBeenCalledWith('/channels', {
        params: { part: ['id', 'snippet'], mine: true, maxResults: 50 },
      });
      expect(result).toEqual({ items: [{ id: 'c1' }] });
    });
  });

  describe('getChannelsByIds', () => {
    it('GETs /channels filtered by the given channel ids', async () => {
      mockGet.mockResolvedValue({ data: { items: [] } });
      await client.getChannelsByIds(['c1', 'c2']);
      expect(mockGet).toHaveBeenCalledWith('/channels', {
        params: { part: ['id', 'snippet'], id: ['c1', 'c2'], maxResults: 50 },
      });
    });
  });

  describe('getUploadsPlaylistId', () => {
    it('GETs /channels contentDetails and returns the uploads playlist id', async () => {
      mockGet.mockResolvedValueOnce({
        data: { items: [{ contentDetails: { relatedPlaylists: { uploads: 'UU123' } } }] },
      });
      const result = await client.getUploadsPlaylistId('chan1');
      expect(mockGet).toHaveBeenCalledWith('/channels', {
        params: { part: ['contentDetails'], id: ['chan1'], maxResults: 50 },
      });
      expect(result).toBe('UU123');
    });

    it('throws when the channel has no uploads playlist', async () => {
      mockGet.mockResolvedValueOnce({ data: { items: [{ contentDetails: {} }] } });
      await expect(client.getUploadsPlaylistId('chan1')).rejects.toThrow(
        'Could not find uploads playlist for channel chan1',
      );
    });
  });

  describe('getVideosPage', () => {
    it('lists the uploads-playlist items, then fetches the full videos', async () => {
      mockGet
        // 1) playlistItems → resourceId.videoId for each
        .mockResolvedValueOnce({
          data: { items: [{ snippet: { resourceId: { videoId: 'v1' } } }], nextPageToken: 'NEXT', etag: 'e' },
        })
        // 2) videos.list → full video resources
        .mockResolvedValueOnce({ data: { items: [{ id: 'v1', snippet: { title: 'T' } }] } });

      const result = await client.getVideosPage('UU123', 'PAGE');

      expect(mockGet).toHaveBeenNthCalledWith(1, '/playlistItems', {
        params: { part: ['snippet'], playlistId: 'UU123', maxResults: 50, pageToken: 'PAGE' },
      });
      expect(mockGet).toHaveBeenNthCalledWith(2, '/videos', {
        params: { part: ['snippet', 'id', 'statistics', 'status', 'contentDetails'], id: ['v1'] },
      });
      expect(result).toMatchObject({
        items: [{ id: 'v1', snippet: { title: 'T' } }],
        nextPageToken: 'NEXT',
        kind: 'youtube#videoListResponse',
        etag: 'e',
      });
    });

    it('returns an empty list (carrying pagination) when the uploads playlist page is empty', async () => {
      mockGet.mockResolvedValueOnce({ data: { items: [], nextPageToken: 'N2' } });
      const result = await client.getVideosPage('UU');
      expect(result).toMatchObject({ items: [], nextPageToken: 'N2', kind: 'youtube#videoListResponse' });
      // No videos.list call should fire.
      expect(mockGet).toHaveBeenCalledTimes(1);
    });
  });

  describe('getChannelById', () => {
    it('GETs /channels with the full part list for the one-row Channel table', async () => {
      mockGet.mockResolvedValue({ data: { items: [{ id: 'chan1' }] } });
      await client.getChannelById('chan1');
      expect(mockGet).toHaveBeenCalledWith('/channels', {
        params: {
          part: ['id', 'snippet', 'statistics', 'contentDetails', 'status', 'brandingSettings', 'localizations'],
          id: ['chan1'],
          maxResults: 50,
        },
      });
    });
  });

  describe('updateChannel', () => {
    it('PUTs /channels with id + only the changed mutable parts', async () => {
      mockPut.mockResolvedValue({ data: { id: 'chan1' } });
      await client.updateChannel('chan1', { brandingSettings: { channel: { title: 'New' } } });
      expect(mockPut).toHaveBeenCalledWith(
        '/channels',
        { id: 'chan1', brandingSettings: { channel: { title: 'New' } } },
        { params: { part: ['id', 'brandingSettings'] } },
      );
    });
  });

  describe('playlists', () => {
    it('lists the owned channel playlists with mine=true', async () => {
      mockGet.mockResolvedValue({ data: { items: [] } });
      await client.getPlaylistsPage('chan1', { mine: true });
      expect(mockGet).toHaveBeenCalledWith('/playlists', {
        params: { part: ['snippet', 'status', 'contentDetails'], maxResults: 50, pageToken: undefined, mine: true },
      });
    });

    it('lists a public channel playlists by channelId (no mine)', async () => {
      mockGet.mockResolvedValue({ data: { items: [] } });
      await client.getPlaylistsPage('chan1', { mine: false, pageToken: 'P2' });
      expect(mockGet).toHaveBeenCalledWith('/playlists', {
        params: { part: ['snippet', 'status', 'contentDetails'], maxResults: 50, pageToken: 'P2', channelId: 'chan1' },
      });
    });

    it('POSTs a new playlist with snippet+status parts', async () => {
      mockPost.mockResolvedValue({ data: { id: 'pl1' } });
      await client.createPlaylist({ snippet: { title: 'T' } });
      expect(mockPost).toHaveBeenCalledWith(
        '/playlists',
        { snippet: { title: 'T' } },
        { params: { part: ['snippet', 'status'] } },
      );
    });

    it('PUTs a playlist update carrying its id', async () => {
      mockPut.mockResolvedValue({ data: { id: 'pl1' } });
      await client.updatePlaylist('pl1', { snippet: { title: 'T2' } });
      expect(mockPut).toHaveBeenCalledWith(
        '/playlists',
        { id: 'pl1', snippet: { title: 'T2' } },
        { params: { part: ['snippet', 'status'] } },
      );
    });

    it('DELETEs a playlist by id', async () => {
      mockDelete.mockResolvedValue({ data: {} });
      await client.deletePlaylist('pl1');
      expect(mockDelete).toHaveBeenCalledWith('/playlists', { params: { id: 'pl1' } });
    });
  });

  describe('playlistItems', () => {
    it('lists items for a playlist with snippet+contentDetails parts', async () => {
      mockGet.mockResolvedValue({ data: { items: [] } });
      await client.getPlaylistItemsPage('pl1', 'PG');
      expect(mockGet).toHaveBeenCalledWith('/playlistItems', {
        params: { part: ['snippet', 'contentDetails'], playlistId: 'pl1', maxResults: 50, pageToken: 'PG' },
      });
    });

    it('POSTs a new playlist item', async () => {
      mockPost.mockResolvedValue({ data: { id: 'pli1' } });
      await client.createPlaylistItem({ snippet: { playlistId: 'pl1' } });
      expect(mockPost).toHaveBeenCalledWith(
        '/playlistItems',
        { snippet: { playlistId: 'pl1' } },
        { params: { part: ['snippet', 'contentDetails'] } },
      );
    });

    it('PUTs a playlist item update (the FK re-parent path) carrying its id', async () => {
      mockPut.mockResolvedValue({ data: { id: 'pli1' } });
      await client.updatePlaylistItem('pli1', { snippet: { playlistId: 'pl2', position: 0 } });
      expect(mockPut).toHaveBeenCalledWith(
        '/playlistItems',
        { id: 'pli1', snippet: { playlistId: 'pl2', position: 0 } },
        { params: { part: ['snippet', 'contentDetails'] } },
      );
    });

    it('DELETEs a playlist item by id', async () => {
      mockDelete.mockResolvedValue({ data: {} });
      await client.deletePlaylistItem('pli1');
      expect(mockDelete).toHaveBeenCalledWith('/playlistItems', { params: { id: 'pli1' } });
    });
  });

  describe('channelSections', () => {
    it('lists a channel sections by channelId', async () => {
      mockGet.mockResolvedValue({ data: { items: [] } });
      await client.getChannelSections('chan1');
      expect(mockGet).toHaveBeenCalledWith('/channelSections', {
        params: { part: ['snippet', 'contentDetails'], channelId: 'chan1' },
      });
    });

    it('POSTs / PUTs / DELETEs channel sections', async () => {
      mockPost.mockResolvedValue({ data: { id: 'cs1' } });
      mockPut.mockResolvedValue({ data: { id: 'cs1' } });
      mockDelete.mockResolvedValue({ data: {} });
      await client.createChannelSection({ snippet: { type: 'singlePlaylist' } });
      await client.updateChannelSection('cs1', { snippet: { title: 'S' } });
      await client.deleteChannelSection('cs1');
      expect(mockPost).toHaveBeenCalledWith(
        '/channelSections',
        { snippet: { type: 'singlePlaylist' } },
        { params: { part: ['snippet', 'contentDetails'] } },
      );
      expect(mockPut).toHaveBeenCalledWith(
        '/channelSections',
        { id: 'cs1', snippet: { title: 'S' } },
        { params: { part: ['snippet', 'contentDetails'] } },
      );
      expect(mockDelete).toHaveBeenCalledWith('/channelSections', { params: { id: 'cs1' } });
    });
  });

  describe('subscriptions', () => {
    it('lists the authorized channel own subscriptions with mine=true', async () => {
      mockGet.mockResolvedValue({ data: { items: [] } });
      await client.getSubscriptionsPage('PG');
      expect(mockGet).toHaveBeenCalledWith('/subscriptions', {
        params: { part: ['snippet', 'contentDetails'], mine: true, maxResults: 50, pageToken: 'PG' },
      });
    });

    it('POSTs a new subscription and DELETEs by id', async () => {
      mockPost.mockResolvedValue({ data: { id: 'sub1' } });
      mockDelete.mockResolvedValue({ data: {} });
      await client.createSubscription({ snippet: { resourceId: { channelId: 'other' } } });
      await client.deleteSubscription('sub1');
      expect(mockPost).toHaveBeenCalledWith(
        '/subscriptions',
        { snippet: { resourceId: { channelId: 'other' } } },
        { params: { part: ['snippet'] } },
      );
      expect(mockDelete).toHaveBeenCalledWith('/subscriptions', { params: { id: 'sub1' } });
    });
  });

  describe('members / membershipsLevels (owner-only, read-only)', () => {
    it('lists current members with mode=all_current', async () => {
      mockGet.mockResolvedValue({ data: { items: [] } });
      await client.getMembersPage('PG');
      expect(mockGet).toHaveBeenCalledWith('/members', {
        params: { part: ['snippet'], mode: 'all_current', maxResults: 50, pageToken: 'PG' },
      });
    });

    it('lists membership levels', async () => {
      mockGet.mockResolvedValue({ data: { items: [] } });
      await client.getMembershipsLevels();
      expect(mockGet).toHaveBeenCalledWith('/membershipsLevels', { params: { part: ['snippet'] } });
    });
  });

  describe('reference resources', () => {
    it('lists video categories for a region (default US)', async () => {
      mockGet.mockResolvedValue({ data: { items: [] } });
      await client.getVideoCategories();
      expect(mockGet).toHaveBeenCalledWith('/videoCategories', { params: { part: ['snippet'], regionCode: 'US' } });
    });

    it('lists i18n languages and regions', async () => {
      mockGet.mockResolvedValue({ data: { items: [] } });
      await client.getI18nLanguages();
      await client.getI18nRegions();
      expect(mockGet).toHaveBeenCalledWith('/i18nLanguages', { params: { part: ['snippet'] } });
      expect(mockGet).toHaveBeenCalledWith('/i18nRegions', { params: { part: ['snippet'] } });
    });
  });

  describe('getVideoCommentThreadsPage', () => {
    it('GETs /commentThreads for a video with snippet+replies parts', async () => {
      mockGet.mockResolvedValue({ data: { items: [] } });
      await client.getVideoCommentThreadsPage('v1');
      expect(mockGet).toHaveBeenCalledWith('/commentThreads', {
        params: { part: ['snippet', 'replies'], videoId: 'v1', maxResults: 50, pageToken: undefined },
      });
    });
  });

  describe('getVideo', () => {
    it('GETs /videos for a single id with the full part list', async () => {
      mockGet.mockResolvedValue({ data: { items: [{ id: 'v9' }] } });
      const result = await client.getVideo('v9');
      expect(mockGet).toHaveBeenCalledWith('/videos', {
        params: { part: ['snippet', 'id', 'statistics', 'status', 'contentDetails'], id: ['v9'] },
      });
      expect(result).toEqual({ items: [{ id: 'v9' }] });
    });
  });

  describe('updateVideo', () => {
    it('PUTs /videos with the snippet body and id/snippet parts, returning the persisted video verbatim', async () => {
      mockPut.mockResolvedValue({ data: { id: 'v1', snippet: { title: 'New' } } });
      const snippet = { title: 'New', categoryId: '22' };
      const result = await client.updateVideo('v1', { snippet });
      expect(mockPut).toHaveBeenCalledWith('/videos', { id: 'v1', snippet }, { params: { part: ['id', 'snippet'] } });
      expect(result).toEqual({ id: 'v1', snippet: { title: 'New' } });
    });

    it('PUTs only the status part (id/status) for a status-only update (DEV-10629)', async () => {
      mockPut.mockResolvedValue({ data: { id: 'v1', status: { privacyStatus: 'public' } } });
      const status = { privacyStatus: 'public', selfDeclaredMadeForKids: false };
      await client.updateVideo('v1', { status });
      expect(mockPut).toHaveBeenCalledWith('/videos', { id: 'v1', status }, { params: { part: ['id', 'status'] } });
    });

    it('PUTs both parts (id/snippet/status) when snippet and status both change', async () => {
      mockPut.mockResolvedValue({ data: { id: 'v1' } });
      const snippet = { title: 'New', categoryId: '22' };
      const status = { privacyStatus: 'unlisted' };
      await client.updateVideo('v1', { snippet, status });
      expect(mockPut).toHaveBeenCalledWith(
        '/videos',
        { id: 'v1', snippet, status },
        { params: { part: ['id', 'snippet', 'status'] } },
      );
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
