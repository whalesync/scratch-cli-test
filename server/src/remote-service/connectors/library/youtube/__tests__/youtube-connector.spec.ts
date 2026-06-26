import { ConnectorAccountRef } from '../../../connector-registry';
import { ConnectorFile, EntityId } from '../../../types';
import { getForeignKeyOptions, isReadonlyField } from '../youtube-json-schema';

// Mock the api client so the connector's dispatch logic can be exercised without HTTP.
const mockClient = {
  getChannels: jest.fn(),
  getChannelsByIds: jest.fn(),
  getChannelById: jest.fn(),
  getUploadsPlaylistId: jest.fn(),
  getVideosPage: jest.fn(),
  getVideo: jest.fn(),
  getPlaylistsPage: jest.fn(),
  getPlaylistItemsPage: jest.fn(),
  createPlaylist: jest.fn(),
  updatePlaylist: jest.fn(),
  deletePlaylist: jest.fn(),
  createPlaylistItem: jest.fn(),
  updatePlaylistItem: jest.fn(),
  getChannelSections: jest.fn(),
  getSubscriptionsPage: jest.fn(),
  getMembersPage: jest.fn(),
  getMembershipsLevels: jest.fn(),
  getVideoCategories: jest.fn(),
  getI18nLanguages: jest.fn(),
  getI18nRegions: jest.fn(),
  getVideoCommentThreadsPage: jest.fn(),
};

jest.mock('../youtube-api-client', () => ({
  YoutubeApiClient: jest.fn(() => mockClient),
}));

import { settingAppliesToTable } from '@spinner/shared-types';
import { YouTubeConnector } from '../youtube-connector';
import { channelTableWsId } from '../youtube-entities';

const OWN_CHANNEL_ID = 'UCown';
const OWN_CHANNEL_TITLE = 'My Channel';
const PUBLIC_CHANNEL_ID = 'UCpublic';
const PUBLIC_CHANNEL_TITLE = 'Public Channel';

function buildAccount(additionalChannels?: string[]): ConnectorAccountRef {
  return {
    id: 'coa_test',
    authType: 'OAUTH',
    extras: additionalChannels ? { additionalChannels } : null,
    version: 1,
  };
}

function makeConnector(additionalChannels?: string[]): YouTubeConnector {
  return new YouTubeConnector('test-token', buildAccount(additionalChannels));
}

/** A table-id helper for a per-channel kind. */
function channelTableId(kind: string, channelId: string): EntityId {
  return { wsId: `${kind}_${channelId}`, remoteId: [kind, channelId] };
}

/**
 * A pull callback that collects every file into `sink`. Returns a resolved
 * promise without `await` (the callback type is `() => Promise<void>` but the
 * test body has nothing to await).
 */
function collectInto(sink: Record<string, unknown>[]): (params: { files: ConnectorFile[] }) => Promise<void> {
  return (params) => {
    sink.push(...params.files);
    return Promise.resolve();
  };
}

describe('YouTubeConnector', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockClient.getChannels.mockResolvedValue({
      items: [{ id: OWN_CHANNEL_ID, snippet: { title: OWN_CHANNEL_TITLE } }],
    });
    mockClient.getChannelsByIds.mockResolvedValue({
      items: [{ id: PUBLIC_CHANNEL_ID, snippet: { title: PUBLIC_CHANNEL_TITLE } }],
    });
  });

  describe('listTables', () => {
    it('emits every per-channel entity + reference tables for the owned channel, grouped by channel title', async () => {
      const tables = await makeConnector().listTables();

      const ownedKinds = tables.filter((t) => t.parentPath === OWN_CHANNEL_TITLE).map((t) => t.id.remoteId[0]);
      expect(ownedKinds).toEqual([
        'videos',
        'playlists',
        'playlistItems',
        'channelSections',
        'subscriptions',
        'members',
        'membershipsLevels',
      ]);

      // The single Channels table is top-level (no parentPath), not nested under a channel.
      const channelsTable = tables.find((t) => t.id.wsId === 'channels');
      expect(channelsTable?.parentPath).toBeUndefined();
      expect(channelsTable?.displayName).toBe('Channels');
      expect(channelsTable?.disabledCreates).toBe(true);
      expect(channelsTable?.disabledDeletes).toBe(true);
      // Update stays enabled (owned-channel edits; public rows are rejected at write time).
      expect(channelsTable?.disabledUpdates).toBeUndefined();

      // Reference tables present, grouped under "Reference", read-only.
      const referenceTables = tables.filter((t) => t.parentPath === 'Reference');
      expect(referenceTables.map((t) => t.id.wsId)).toEqual(['videoCategories', 'i18nLanguages', 'i18nRegions']);
      for (const ref of referenceTables) {
        expect(ref.disabledCreates).toBe(true);
        expect(ref.disabledUpdates).toBe(true);
        expect(ref.disabledDeletes).toBe(true);
      }
    });

    it('disables the right writes per entity on the owned channel', async () => {
      const tables = await makeConnector().listTables();
      const byKind = new Map(tables.map((t) => [t.id.remoteId[0], t]));

      // Videos: update only (no create, no delete).
      expect(byKind.get('videos')?.disabledCreates).toBe(true);
      expect(byKind.get('videos')?.disabledDeletes).toBe(true);
      expect(byKind.get('videos')?.disabledUpdates).toBeUndefined();

      // Playlists: full CRUD (no disabled flags).
      expect(byKind.get('playlists')?.disabledCreates).toBeUndefined();
      expect(byKind.get('playlists')?.disabledUpdates).toBeUndefined();
      expect(byKind.get('playlists')?.disabledDeletes).toBeUndefined();

      // Subscriptions: create + delete, no update.
      expect(byKind.get('subscriptions')?.disabledCreates).toBeUndefined();
      expect(byKind.get('subscriptions')?.disabledDeletes).toBeUndefined();
      expect(byKind.get('subscriptions')?.disabledUpdates).toBe(true);

      // Members / MembershipsLevels: fully read-only.
      expect(byKind.get('members')?.disabledUpdates).toBe(true);
      expect(byKind.get('membershipsLevels')?.disabledUpdates).toBe(true);
    });

    it('emits only the public-readable subset for additional channels, all writes disabled', async () => {
      const tables = await makeConnector([PUBLIC_CHANNEL_ID]).listTables();
      const publicTables = tables.filter((t) => t.parentPath === PUBLIC_CHANNEL_TITLE);
      const publicKinds = publicTables.map((t) => t.id.remoteId[0]);

      // Owner-only kinds (subscriptions/members/membershipsLevels) are NOT emitted.
      expect(publicKinds).toEqual(['videos', 'playlists', 'playlistItems', 'channelSections']);
      for (const t of publicTables) {
        expect(t.disabledCreates).toBe(true);
        expect(t.disabledUpdates).toBe(true);
        expect(t.disabledDeletes).toBe(true);
        expect(t.disabledReason).toContain('read-only');
      }
    });

    it('continues with owned + reference tables when additional channels fail to fetch', async () => {
      mockClient.getChannelsByIds.mockRejectedValue(new Error('bad id'));
      const tables = await makeConnector(['UCbad']).listTables();
      expect(tables.some((t) => t.parentPath === OWN_CHANNEL_TITLE)).toBe(true);
      expect(tables.some((t) => t.parentPath === 'Reference')).toBe(true);
      expect(tables.some((t) => t.parentPath === PUBLIC_CHANNEL_TITLE)).toBe(false);
    });
  });

  describe('fetchJsonTableSpec', () => {
    it('places the table under the channel-title basePath and sets the channel FK target', async () => {
      const spec = await makeConnector().fetchJsonTableSpec(channelTableId('videos', OWN_CHANNEL_ID));
      expect(spec.name).toBe('Videos');
      expect(spec.basePath).toEqual([OWN_CHANNEL_TITLE]);
      // snippet.channelId is a read-only FK into the single top-level Channels table.
      expect(getForeignKeyOptions('snippet.channelId', spec)).toEqual({ linkedTableId: 'channels' });
      expect(isReadonlyField('snippet.channelId', spec)).toBe(true);
    });

    it('wires the PlaylistItems FK columns to the Playlists and Videos tables (editable re-parent)', async () => {
      const spec = await makeConnector().fetchJsonTableSpec(channelTableId('playlistItems', OWN_CHANNEL_ID));
      expect(spec.name).toBe('PlaylistItems');
      expect(getForeignKeyOptions('snippet.playlistId', spec)).toEqual({
        linkedTableId: `playlists_${OWN_CHANNEL_ID}`,
      });
      expect(getForeignKeyOptions('contentDetails.videoId', spec)).toEqual({
        linkedTableId: `videos_${OWN_CHANNEL_ID}`,
      });
      // The re-parent FKs are EDITABLE.
      expect(isReadonlyField('snippet.playlistId', spec)).toBe(false);
      expect(isReadonlyField('contentDetails.videoId', spec)).toBe(false);
    });

    it('builds reference table specs under /Reference/ without a channel id', async () => {
      const spec = await makeConnector().fetchJsonTableSpec({ wsId: 'videoCategories', remoteId: ['videoCategories'] });
      expect(spec.name).toBe('Video Categories');
      expect(spec.basePath).toEqual(['Reference']);
    });
  });

  describe('pullRecordFiles dispatch', () => {
    it('resolves the uploads playlist once, then pages videos', async () => {
      mockClient.getUploadsPlaylistId.mockResolvedValue('UU1');
      mockClient.getVideosPage.mockResolvedValueOnce({ items: [{ id: 'v1' }], nextPageToken: undefined });
      const spec = await makeConnector().fetchJsonTableSpec(channelTableId('videos', OWN_CHANNEL_ID));
      const files: Record<string, unknown>[] = [];
      await makeConnector().pullRecordFiles(spec, collectInto(files), {}, {});
      expect(mockClient.getUploadsPlaylistId).toHaveBeenCalledWith(OWN_CHANNEL_ID);
      expect(mockClient.getVideosPage).toHaveBeenCalledWith('UU1', undefined);
      expect(files).toEqual([{ id: 'v1' }]);
    });

    it('deep-fetches comments onto videos when includeComments is on', async () => {
      mockClient.getUploadsPlaylistId.mockResolvedValue('UU1');
      mockClient.getVideosPage.mockResolvedValueOnce({ items: [{ id: 'v1' }], nextPageToken: undefined });
      mockClient.getVideoCommentThreadsPage.mockResolvedValue({ items: [{ id: 'ct1' }] });
      const spec = await makeConnector().fetchJsonTableSpec(channelTableId('videos', OWN_CHANNEL_ID));
      const files: Record<string, unknown>[] = [];
      await makeConnector().pullRecordFiles(spec, collectInto(files), {}, { includeComments: true });
      expect(mockClient.getVideoCommentThreadsPage).toHaveBeenCalledWith('v1');
      expect(files[0].comments).toEqual([{ id: 'ct1' }]);
    });

    it('lists owned-channel playlists with mine=true', async () => {
      mockClient.getPlaylistsPage.mockResolvedValueOnce({ items: [{ id: 'pl1' }], nextPageToken: undefined });
      const spec = await makeConnector().fetchJsonTableSpec(channelTableId('playlists', OWN_CHANNEL_ID));
      await makeConnector().pullRecordFiles(spec, collectInto([]), {}, {});
      expect(mockClient.getPlaylistsPage).toHaveBeenCalledWith(OWN_CHANNEL_ID, { mine: true, pageToken: undefined });
    });

    it('lists public-channel playlists by channelId (no mine)', async () => {
      mockClient.getPlaylistsPage.mockResolvedValueOnce({ items: [], nextPageToken: undefined });
      const connector = makeConnector([PUBLIC_CHANNEL_ID]);
      const spec = await connector.fetchJsonTableSpec(channelTableId('playlists', PUBLIC_CHANNEL_ID));
      await connector.pullRecordFiles(spec, collectInto([]), {}, {});
      expect(mockClient.getPlaylistsPage).toHaveBeenCalledWith(PUBLIC_CHANNEL_ID, {
        mine: false,
        pageToken: undefined,
      });
    });

    it('degrades gracefully (no throw, no files) when members 403', async () => {
      mockClient.getMembersPage.mockRejectedValue(new Error('403 forbidden'));
      const spec = await makeConnector().fetchJsonTableSpec(channelTableId('members', OWN_CHANNEL_ID));
      const files: Record<string, unknown>[] = [];
      await expect(makeConnector().pullRecordFiles(spec, collectInto(files), {}, {})).resolves.toEqual({});
      expect(files).toEqual([]);
    });
  });

  describe('write dispatch', () => {
    it('creates a playlist on the owned channel', async () => {
      mockClient.createPlaylist.mockResolvedValue({ id: 'pl_new' });
      const connector = makeConnector();
      const spec = await connector.fetchJsonTableSpec(channelTableId('playlists', OWN_CHANNEL_ID));
      const created = await connector.createRecords(spec, [{ snippet: { title: 'T' }, id: 'ignored' }]);
      // pickParts drops id/etc; only snippet+status are sent.
      expect(mockClient.createPlaylist).toHaveBeenCalledWith({ snippet: { title: 'T' } });
      expect(created).toEqual([{ id: 'pl_new' }]);
    });

    it('updates a playlist item (the FK re-parent path)', async () => {
      mockClient.updatePlaylistItem.mockResolvedValue({ id: 'pli1', snippet: { playlistId: 'pl2' } });
      const connector = makeConnector();
      const spec = await connector.fetchJsonTableSpec(channelTableId('playlistItems', OWN_CHANNEL_ID));
      await connector.updateRecords(spec, [{ id: 'pli1', snippet: { playlistId: 'pl2', position: 0 } }], [{}]);
      expect(mockClient.updatePlaylistItem).toHaveBeenCalledWith('pli1', {
        snippet: { playlistId: 'pl2', position: 0 },
      });
    });

    // DEV-10597: pickParts builds the write body from the full file and silently
    // drops any non-writable part. A sparse changedFields touching a read-only
    // part means the user edited it — surface it instead of dropping it.
    it('throws when an edit changes a read-only part (statistics), and does not call the API', async () => {
      const connector = makeConnector();
      const spec = await connector.fetchJsonTableSpec(channelTableId('playlists', OWN_CHANNEL_ID));
      await expect(
        connector.updateRecords(spec, [{ id: 'pl1', snippet: { title: 'X' } }], [{ statistics: { viewCount: '5' } }]),
      ).rejects.toThrow(/"statistics" is read-only/);
      expect(mockClient.updatePlaylist).not.toHaveBeenCalled();
    });

    it('throws when a video edit changes a read-only snippet field (publishedAt)', async () => {
      const connector = makeConnector();
      const spec = await connector.fetchJsonTableSpec(channelTableId('videos', OWN_CHANNEL_ID));
      await expect(
        connector.updateRecords(
          spec,
          [{ id: 'v1', snippet: { title: 'T', publishedAt: '2020-01-01T00:00:00Z' } }],
          [{ snippet: { publishedAt: '2021-01-01T00:00:00Z' } }],
        ),
      ).rejects.toThrow(/"publishedAt" is read-only/);
    });

    it('throws on video create (unsupported) and video delete (disabled)', async () => {
      const connector = makeConnector();
      const spec = await connector.fetchJsonTableSpec(channelTableId('videos', OWN_CHANNEL_ID));
      await expect(connector.createRecords(spec, [{ id: 'v1' }])).rejects.toThrow(/does not support create for videos/);
      await expect(connector.deleteRecords(spec, [{ id: 'v1' }])).rejects.toThrow(/does not support delete for videos/);
    });

    it('refuses writes to an additional public channel', async () => {
      const connector = makeConnector([PUBLIC_CHANNEL_ID]);
      const spec = await connector.fetchJsonTableSpec(channelTableId('playlists', PUBLIC_CHANNEL_ID));
      await expect(connector.createRecords(spec, [{ snippet: {} }])).rejects.toThrow(/read-only/);
    });
  });

  describe('advanced-setting scoping (includeTranscript / includeComments → Videos tables only)', () => {
    it('applies to every channel’s Videos table but not to other entity or reference tables', () => {
      for (const setting of YouTubeConnector.advancedSettings) {
        // Any channel's Videos table → applies (prefix match on `videos_<channelId>`).
        expect(settingAppliesToTable(setting, channelTableWsId('videos', 'UCabc'))).toBe(true);
        expect(settingAppliesToTable(setting, channelTableWsId('videos', 'UCxyz'))).toBe(true);
        // Other per-channel entity tables → do NOT apply.
        expect(settingAppliesToTable(setting, channelTableWsId('playlists', 'UCabc'))).toBe(false);
        expect(settingAppliesToTable(setting, 'channels')).toBe(false);
        // Reference tables → do NOT apply.
        expect(settingAppliesToTable(setting, 'videoCategories')).toBe(false);
      }
    });
  });
});
