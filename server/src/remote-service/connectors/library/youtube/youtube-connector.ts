/* eslint-disable @typescript-eslint/no-unused-vars -- create/delete/getSuggestedRecordFileNames take interface-required params they don't use (they throw or hardcode the path) */
import { connectorMetadata, ConnectorSettingDefinition } from '@spinner/shared-types';
import { JsonSafeObject } from 'src/utils/objects';
import { Connector, suggestFileNamesFromFieldPaths } from '../../connector';
import { ConnectorAccountRef, connectorRegistry } from '../../connector-registry';
import { ConnectorInstantiationError, ReadonlyFieldEditError, readonlyFieldEditErrorMessage } from '../../error';
import { Service } from '../../service-constants';
import {
  BaseJsonTableSpec,
  ConnectorErrorDetails,
  ConnectorFile,
  EntityId,
  PullRecordFilesOptions,
  PullRecordFilesResult,
  readRecordIdAsString,
  TablePreview,
} from '../../types';
import { YoutubeApiClient } from './youtube-api-client';
import {
  CHANNELS_TABLE_DISPLAY_NAME,
  CHANNELS_TABLE_WS_ID,
  channelTableWsId,
  PUBLIC_CHANNEL_ENTITY_KINDS,
  PUBLIC_CHANNEL_WRITES_DISABLED_REASON,
  YOUTUBE_CHANNEL_ENTITIES,
  YOUTUBE_REFERENCE_ENTITIES,
  YOUTUBE_REFERENCE_ENTITY_BY_KIND,
  YOUTUBE_REFERENCE_PARENT_PATH,
  YouTubeEntityKind,
} from './youtube-entities';
import {
  buildChannelSectionsJsonTableSpec,
  buildChannelsJsonTableSpec,
  buildMembershipsLevelsJsonTableSpec,
  buildMembersJsonTableSpec,
  buildPlaylistItemsJsonTableSpec,
  buildPlaylistsJsonTableSpec,
  buildReferenceJsonTableSpec,
  buildSubscriptionsJsonTableSpec,
  buildYouTubeJsonTableSpec,
} from './youtube-json-schema';
import type { YouTubeVideo } from './youtube-types';

/**
 * The video snippet sub-fields a user may edit and that we write back via
 * `videos.update?part=snippet`. Everything else on the snippet (publishedAt,
 * channelId, thumbnails, …) is read-only and is dropped from the write body.
 */
const WRITABLE_VIDEO_SNIPPET_FIELDS = ['title', 'description', 'categoryId', 'defaultLanguage', 'tags'] as const;

/**
 * The video status sub-fields a user may edit and that we write back via
 * `videos.update?part=status` (DEV-10629). `uploadStatus` and the computed
 * `madeForKids` are read-only; `selfDeclaredMadeForKids` is the writable
 * counterpart we always resend alongside a status write so YouTube doesn't reset
 * the made-for-kids declaration when it replaces the status part.
 */
const WRITABLE_VIDEO_STATUS_FIELDS = ['privacyStatus', 'license', 'embeddable', 'publicStatsViewable'] as const;

/**
 * Video pull options. `includeTranscript` / `includeComments` come from the
 * table's advanced-setting checkboxes and, when enabled, deep-fetch each video's
 * English caption track / first page of comments and embed them on the record
 * (extra captions / commentThreads requests per video).
 */
interface YouTubeVideoPullOptions extends PullRecordFilesOptions {
  includeTranscript?: boolean;
  includeComments?: boolean;
}

/**
 * Per-channel pull checkpoint. We persist a page token so a stalled pull resumes
 * mid-table rather than restarting from the first page. For PlaylistItems we also
 * remember which playlist we were in.
 */
interface YouTubeChannelDownloadProgress {
  pageToken?: string;
  /** PlaylistItems only: index into the channel's playlists we were paging through. */
  playlistIndex?: number;
}

/**
 * Connect-form field for brand/managed channel IDs. `channels.list?mine=true`
 * only returns the channel of the identity the user authorizes with, so managed
 * brand channels (and any public channel the user wants to read) are entered here
 * and persisted to `ConnectorAccount.extras.additionalChannels`. The key MUST
 * match `oauthInitiateOptionsSchema.youtubeAdditionalChannels` — the connect modal
 * copies the value onto the OAuth-initiate options by key.
 */
const YOUTUBE_ADDITIONAL_CHANNELS_FIELD: ConnectorSettingDefinition = {
  key: 'youtubeAdditionalChannels',
  type: 'string',
  label: 'Additional public channels (read-only, optional)',
  placeholder: 'UCxxxxxxxx, UCyyyyyyyy',
  description:
    'Channel IDs of OTHER channels to also sync, comma- or space-separated. YouTube only returns your own channel for the identity you authorize with; channels listed here are fetched as PUBLIC, read-only data — no private videos, captions, edits, or analytics. To fully manage another channel you own (e.g. a brand channel), connect it separately and pick it on Google’s consent screen.',
};

/** Parsed entity id: the kind (remoteId[0]) plus the channel id for per-channel tables. */
interface YouTubeParsedTableId {
  kind: YouTubeEntityKind;
  /** Present for per-channel kinds; absent for reference kinds. */
  channelId?: string;
}

export class YouTubeConnector extends Connector {
  readonly service = Service.YOUTUBE;
  static readonly displayName = 'YouTube';
  static readonly metadata = connectorMetadata({
    displayName: 'YouTube',
    table: 'table',
    tables: 'tables',
    record: 'record',
    records: 'records',
    logo: 'https://static.scratch.md/connector-icons/youtube.svg',
    // TEMP (local testing, DEV-10299): true so the connector shows in the web-app
    // picker for the OAuth connect flow. Revert to false before merge unless we
    // decide to ship it visible.
    visible: true,
    oauth: { label: 'OAuth (100 api credits/day)', privateLabel: 'Private OAuth (10,000 api credits/day)' },
    credentialFields: {
      oauth: [YOUTUBE_ADDITIONAL_CHANNELS_FIELD],
      oauth_custom: [YOUTUBE_ADDITIONAL_CHANNELS_FIELD],
    },
  });

  /**
   * Video deep-fetch toggles. Off by default — both hit quota-heavy YouTube APIs
   * (captions.list = 50 units + captions.download = 200 units per video;
   * commentThreads = 1 unit/page but fans out per video), so we only fetch when
   * the user opts in. Scoped to the Videos tables (the only pull that consults
   * them) via `forTableWsIdPrefixes` — the dynamic-table form of `forTableWsIds`,
   * since each channel mints its own `videos_<channelId>` table and exact wsIds
   * aren't known statically. Mirrors HighLevel's `includeNotes`.
   */
  static readonly advancedSettings: ConnectorSettingDefinition[] = [
    {
      key: 'includeTranscript',
      type: 'boolean',
      label: 'Include video transcript',
      description:
        "Fetch and embed each video's English transcript. Much slower and quota-heavy — extra caption requests per video.",
      // `channelTableWsId('videos', '')` === 'videos_' — matches every channel's Videos table.
      forTableWsIdPrefixes: [channelTableWsId('videos', '')],
    },
    {
      key: 'includeComments',
      type: 'boolean',
      label: 'Include video comments',
      description:
        "Fetch and embed the first page of each video's comment threads (read-only). Slower — one extra request per video; skips videos with comments disabled.",
      forTableWsIdPrefixes: [channelTableWsId('videos', '')],
    },
  ];

  private readonly apiClient: YoutubeApiClient;

  constructor(
    private readonly accessToken: string,
    private readonly account: ConnectorAccountRef,
  ) {
    super();
    this.apiClient = new YoutubeApiClient(accessToken);
  }

  async testConnection(): Promise<void> {
    // Test connection by fetching the authorized user's channel.
    await this.apiClient.getChannels();
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async getApiQuota(): Promise<{ dashboardUrl: string }> {
    return { dashboardUrl: 'https://console.cloud.google.com/apis/api/youtube.googleapis.com/quotas' };
  }

  /**
   * Discover every table: the owned channel's full entity set (writes enabled per
   * the matrix), each additional PUBLIC channel's read-only subset, and the shared
   * reference tables. The channel is a structural path segment — each table groups
   * under its channel title in the picker (`parentPath`) and lands on disk at
   * `/{connection}/{channelTitle}/{Entity}/…` (the table's `basePath`).
   */
  async listTables(): Promise<TablePreview[]> {
    const tables: TablePreview[] = [];

    const ownChannelsResponse = await this.apiClient.getChannels();
    for (const channel of ownChannelsResponse.items ?? []) {
      tables.push(...this.tablesForChannel(channel.id, channel.snippet?.title, true));
    }

    // Additional PUBLIC channels (entered by id → extras.additionalChannels).
    const additionalChannelIds = this.readAdditionalChannelIds();
    if (additionalChannelIds.length > 0) {
      try {
        const additionalChannelsResponse = await this.apiClient.getChannelsByIds(additionalChannelIds);
        for (const channel of additionalChannelsResponse.items ?? []) {
          tables.push(...this.tablesForChannel(channel.id, channel.snippet?.title, false));
        }
      } catch (error) {
        // Continue with the owned channel + reference tables if the additional
        // channels can't be fetched (e.g. an invalid id) — warn and skip.
        console.debug('YouTube: failed to fetch additional channels:', error);
      }
    }

    // The single top-level Channels table — one row per channel in the connection
    // (the owned channel + every additional public channel). It is the FK target the
    // per-channel tables point `snippet.channelId` at. Create/delete are unsupported;
    // update is allowed but only the owned channel's row is writable (public rows are
    // rejected at write time in `updateRecords`).
    tables.push({
      id: { wsId: CHANNELS_TABLE_WS_ID, remoteId: ['channels'] },
      displayName: CHANNELS_TABLE_DISPLAY_NAME,
      disabledCreates: true,
      disabledDeletes: true,
      metadata: { kind: 'channels' },
    });

    // Reference tables (public lookup data, shared by all channels).
    for (const reference of YOUTUBE_REFERENCE_ENTITIES) {
      tables.push({
        id: { wsId: reference.kind, remoteId: [reference.kind] },
        displayName: reference.displayName,
        parentPath: YOUTUBE_REFERENCE_PARENT_PATH,
        disabledCreates: true,
        disabledUpdates: true,
        disabledDeletes: true,
        disabledReason: 'Reference data is read-only.',
        metadata: { reference: true },
      });
    }

    return tables;
  }

  /**
   * Build the table previews for one channel. The owned channel emits every
   * per-channel entity (writes enabled per `ownedWriteSupport`); an additional
   * public channel emits only the public-readable, non-owner-only entities, all
   * writes disabled.
   */
  private tablesForChannel(
    channelId: string | undefined,
    channelTitle: string | undefined,
    owned: boolean,
  ): TablePreview[] {
    if (!channelId) return [];
    const title = channelTitle || `Channel ${channelId}`;
    const tables: TablePreview[] = [];
    for (const entity of YOUTUBE_CHANNEL_ENTITIES) {
      if (!owned && !PUBLIC_CHANNEL_ENTITY_KINDS.has(entity.kind)) {
        // Owner-only tables (Subscriptions/Members/MembershipsLevels) aren't emitted for public channels.
        continue;
      }
      const preview: TablePreview = {
        id: { wsId: channelTableWsId(entity.kind, channelId), remoteId: [entity.kind, channelId] },
        displayName: entity.displayName,
        parentPath: title,
        metadata: { channelId, channelTitle: title, kind: entity.kind, owned },
      };
      if (owned) {
        if (!entity.ownedWriteSupport.create) preview.disabledCreates = true;
        if (!entity.ownedWriteSupport.update) preview.disabledUpdates = true;
        if (!entity.ownedWriteSupport.delete) preview.disabledDeletes = true;
        if (entity.readonlyOwnerScoped) preview.disabledReason = 'This table is read-only.';
      } else {
        preview.disabledCreates = true;
        preview.disabledUpdates = true;
        preview.disabledDeletes = true;
        preview.disabledReason = PUBLIC_CHANNEL_WRITES_DISABLED_REASON;
      }
      tables.push(preview);
    }
    return tables;
  }

  /** Read the additional (public) channel ids off the connector account's extras. */
  private readAdditionalChannelIds(): string[] {
    if (!this.account.extras || !('additionalChannels' in this.account.extras)) return [];
    const raw = this.account.extras.additionalChannels;
    if (!Array.isArray(raw)) return [];
    return raw.filter((id): id is string => typeof id === 'string');
  }

  /**
   * Build the JSON table spec for a table, dispatching on the entity kind. Each
   * per-channel spec resolves the channel title for its `basePath` segment.
   */
  async fetchJsonTableSpec(id: EntityId): Promise<BaseJsonTableSpec> {
    const parsed = this.parseTableId(id);

    if (this.isReferenceKind(parsed.kind)) {
      const reference = YOUTUBE_REFERENCE_ENTITY_BY_KIND.get(parsed.kind);
      const displayName = reference?.displayName ?? parsed.kind;
      return buildReferenceJsonTableSpec(id, parsed.kind, displayName);
    }

    // The Channels table is global (not scoped to one channel) — build it before
    // we require a channel id.
    if (parsed.kind === 'channels') {
      return buildChannelsJsonTableSpec(id);
    }

    const channelId = this.requireChannelId(parsed);
    const channelTitle = await this.resolveChannelTitle(channelId);

    switch (parsed.kind) {
      case 'videos':
        return buildYouTubeJsonTableSpec(id, channelId, channelTitle);
      case 'playlists':
        return buildPlaylistsJsonTableSpec(id, channelId, channelTitle);
      case 'playlistItems':
        return buildPlaylistItemsJsonTableSpec(id, channelId, channelTitle);
      case 'channelSections':
        return buildChannelSectionsJsonTableSpec(id, channelId, channelTitle);
      case 'subscriptions':
        return buildSubscriptionsJsonTableSpec(id, channelId, channelTitle);
      case 'members':
        return buildMembersJsonTableSpec(id, channelId, channelTitle);
      case 'membershipsLevels':
        return buildMembershipsLevelsJsonTableSpec(id, channelId, channelTitle);
      default:
        return this.throwUnknownKind(parsed.kind);
    }
  }

  /**
   * Pull records for a table, dispatching on the entity kind. Each branch
   * checkpoints its pagination cursor to `connectorProgress` so a stalled run
   * resumes mid-table (idempotent + resumable, the product principle).
   */
  async pullRecordFiles(
    tableSpec: BaseJsonTableSpec,
    callback: (params: { files: ConnectorFile[]; connectorProgress?: JsonSafeObject }) => Promise<void>,
    progress: JsonSafeObject,
    options: PullRecordFilesOptions,
  ): Promise<PullRecordFilesResult> {
    const parsed = this.parseTableId(tableSpec.id);

    switch (parsed.kind) {
      case 'videos':
        await this.pullVideos(this.requireChannelId(parsed), callback, progress, options as YouTubeVideoPullOptions);
        break;
      case 'playlists':
        await this.pullPlaylists(this.requireChannelId(parsed), callback, progress);
        break;
      case 'playlistItems':
        await this.pullPlaylistItems(this.requireChannelId(parsed), callback, progress);
        break;
      case 'channelSections':
        await this.pullChannelSections(this.requireChannelId(parsed), callback);
        break;
      case 'channels':
        await this.pullChannels(callback);
        break;
      case 'subscriptions':
        await this.pullSubscriptions(callback, progress);
        break;
      case 'members':
        await this.pullMembers(callback, progress);
        break;
      case 'membershipsLevels':
        await this.pullMembershipsLevels(callback);
        break;
      case 'videoCategories':
        await this.pullReference(callback, () => this.apiClient.getVideoCategories());
        break;
      case 'i18nLanguages':
        await this.pullReference(callback, () => this.apiClient.getI18nLanguages());
        break;
      case 'i18nRegions':
        await this.pullReference(callback, () => this.apiClient.getI18nRegions());
        break;
      default:
        this.throwUnknownKind(parsed.kind);
    }

    return {};
  }

  /**
   * Re-fetch specific records by ID (used after a publish to reconcile the local
   * file with what the service persisted). Dispatches on the entity kind.
   */
  async pullRecordFilesByIds(
    tableSpec: BaseJsonTableSpec,
    ids: string[],
    callback: (params: { files: ConnectorFile[] }) => Promise<void>,
  ): Promise<void> {
    const parsed = this.parseTableId(tableSpec.id);

    switch (parsed.kind) {
      case 'videos':
        await this.fetchByIds(ids, async (id) => (await this.apiClient.getVideo(id)).items?.[0], callback);
        break;
      case 'playlists':
        await this.fetchByIds(ids, async (id) => (await this.apiClient.getPlaylistById(id)).items?.[0], callback);
        break;
      case 'playlistItems':
        await this.fetchByIds(ids, async (id) => (await this.apiClient.getPlaylistItemById(id)).items?.[0], callback);
        break;
      case 'channelSections':
        await this.fetchByIds(ids, async (id) => (await this.apiClient.getChannelSectionById(id)).items?.[0], callback);
        break;
      case 'channels':
        await this.fetchByIds(ids, async (id) => (await this.apiClient.getChannelById(id)).items?.[0], callback);
        break;
      default:
        // Subscriptions / Members / MembershipsLevels / reference tables have no
        // get-by-id path; they aren't written, so a post-publish re-pull never
        // targets them. Nothing to do.
        break;
    }
  }

  // --- Per-kind pulls -------------------------------------------------------

  private async pullVideos(
    channelId: string,
    callback: (params: { files: ConnectorFile[]; connectorProgress?: JsonSafeObject }) => Promise<void>,
    progress: JsonSafeObject,
    options: YouTubeVideoPullOptions,
  ): Promise<void> {
    const includeTranscript = options.includeTranscript === true;
    const includeComments = options.includeComments === true;
    // Resolve the uploads playlist ONCE (not per page — saves 1u/page).
    const uploadsPlaylistId = await this.apiClient.getUploadsPlaylistId(channelId);

    let nextPageToken = (progress as YouTubeChannelDownloadProgress).pageToken;
    do {
      const page = await this.apiClient.getVideosPage(uploadsPlaylistId, nextPageToken);
      const files = (page.items ?? []) as ConnectorFile[];
      for (const file of files) {
        if (includeTranscript) await this.attachTranscript(file);
        if (includeComments) await this.attachComments(file);
      }
      nextPageToken = page.nextPageToken;
      const connectorProgress: JsonSafeObject = nextPageToken ? { pageToken: nextPageToken } : {};
      await callback({ files, connectorProgress });
    } while (nextPageToken);
  }

  private async pullPlaylists(
    channelId: string,
    callback: (params: { files: ConnectorFile[]; connectorProgress?: JsonSafeObject }) => Promise<void>,
    progress: JsonSafeObject,
  ): Promise<void> {
    const mine = this.isOwnedChannel(channelId);
    let nextPageToken = (progress as YouTubeChannelDownloadProgress).pageToken;
    do {
      const page = await this.apiClient.getPlaylistsPage(channelId, { mine, pageToken: nextPageToken });
      const files = (page.items ?? []) as ConnectorFile[];
      nextPageToken = page.nextPageToken;
      const connectorProgress: JsonSafeObject = nextPageToken ? { pageToken: nextPageToken } : {};
      await callback({ files, connectorProgress });
    } while (nextPageToken);
  }

  /**
   * Pull every item across all of the channel's playlists. Checkpoints both the
   * playlist index and the page token within it, so a stalled run resumes inside
   * the right playlist rather than re-walking earlier ones.
   */
  private async pullPlaylistItems(
    channelId: string,
    callback: (params: { files: ConnectorFile[]; connectorProgress?: JsonSafeObject }) => Promise<void>,
    progress: JsonSafeObject,
  ): Promise<void> {
    const mine = this.isOwnedChannel(channelId);
    const playlistIds = await this.listAllPlaylistIds(channelId, mine);

    const resume = progress as YouTubeChannelDownloadProgress;
    const startIndex = typeof resume.playlistIndex === 'number' && resume.playlistIndex > 0 ? resume.playlistIndex : 0;
    let pageToken = startIndex > 0 || resume.pageToken ? resume.pageToken : undefined;

    for (let playlistIndex = startIndex; playlistIndex < playlistIds.length; playlistIndex++) {
      const playlistId = playlistIds[playlistIndex];
      do {
        const page = await this.apiClient.getPlaylistItemsPage(playlistId, pageToken);
        const files = (page.items ?? []) as ConnectorFile[];
        pageToken = page.nextPageToken;
        // Checkpoint where the NEXT page lives: same playlist if pageToken, else
        // the start of the next playlist.
        const connectorProgress: JsonSafeObject = pageToken
          ? { playlistIndex, pageToken }
          : playlistIndex + 1 < playlistIds.length
            ? { playlistIndex: playlistIndex + 1 }
            : {};
        await callback({ files, connectorProgress });
      } while (pageToken);
      pageToken = undefined;
    }
  }

  private async pullChannelSections(
    channelId: string,
    callback: (params: { files: ConnectorFile[]; connectorProgress?: JsonSafeObject }) => Promise<void>,
  ): Promise<void> {
    const response = await this.apiClient.getChannelSections(channelId);
    const files = (response.items ?? []) as ConnectorFile[];
    if (files.length > 0) await callback({ files, connectorProgress: {} });
  }

  /**
   * Pull the single Channels table: the owned channel (`channels.list?mine=true`)
   * plus every additional public channel (by id), one row each. An additional-
   * channel fetch failure warns and skips so the owned channel still lands.
   */
  private async pullChannels(
    callback: (params: { files: ConnectorFile[]; connectorProgress?: JsonSafeObject }) => Promise<void>,
  ): Promise<void> {
    // `getChannels` (mine=true) returns only id+snippet, so resolve the owned id(s)
    // and re-fetch every channel with FULL parts (statistics/brandingSettings/
    // status/contentDetails) — the same fidelity the old per-channel Channel table had.
    const ownChannelsResponse = await this.apiClient.getChannels();
    const ownedChannelIds = (ownChannelsResponse.items ?? [])
      .map((channel) => channel.id)
      .filter((id): id is string => typeof id === 'string');

    const files: ConnectorFile[] = [];
    if (ownedChannelIds.length > 0) {
      const ownedChannelsFull = await this.apiClient.getChannelsByIdsWithFullParts(ownedChannelIds);
      files.push(...((ownedChannelsFull.items ?? []) as ConnectorFile[]));
    }

    const additionalChannelIds = this.readAdditionalChannelIds();
    if (additionalChannelIds.length > 0) {
      try {
        const additionalChannelsFull = await this.apiClient.getChannelsByIdsWithFullParts(additionalChannelIds);
        files.push(...((additionalChannelsFull.items ?? []) as ConnectorFile[]));
      } catch (error) {
        console.debug('YouTube: failed to fetch additional channels for the Channels table:', error);
      }
    }

    if (files.length > 0) await callback({ files, connectorProgress: {} });
  }

  private async pullSubscriptions(
    callback: (params: { files: ConnectorFile[]; connectorProgress?: JsonSafeObject }) => Promise<void>,
    progress: JsonSafeObject,
  ): Promise<void> {
    let nextPageToken = (progress as YouTubeChannelDownloadProgress).pageToken;
    do {
      const page = await this.apiClient.getSubscriptionsPage(nextPageToken);
      const files = (page.items ?? []) as ConnectorFile[];
      nextPageToken = page.nextPageToken;
      const connectorProgress: JsonSafeObject = nextPageToken ? { pageToken: nextPageToken } : {};
      await callback({ files, connectorProgress });
    } while (nextPageToken);
  }

  /**
   * Pull the channel's current members. Read-only and owner-scoped — requires the
   * `youtube.channel-memberships.creator` scope, which the connector's current
   * `youtube.force-ssl` scope does NOT include, so this usually 403s. Degrade
   * gracefully: warn + yield nothing (like HighLevel's custom-objects try/catch).
   */
  private async pullMembers(
    callback: (params: { files: ConnectorFile[]; connectorProgress?: JsonSafeObject }) => Promise<void>,
    progress: JsonSafeObject,
  ): Promise<void> {
    try {
      let nextPageToken = (progress as YouTubeChannelDownloadProgress).pageToken;
      do {
        const page = await this.apiClient.getMembersPage(nextPageToken);
        const files = (page.items ?? []) as ConnectorFile[];
        nextPageToken = page.nextPageToken;
        const connectorProgress: JsonSafeObject = nextPageToken ? { pageToken: nextPageToken } : {};
        await callback({ files, connectorProgress });
      } while (nextPageToken);
    } catch (error) {
      console.warn('YouTube: could not list channel members (memberships scope likely not granted); skipping.', error);
    }
  }

  private async pullMembershipsLevels(
    callback: (params: { files: ConnectorFile[]; connectorProgress?: JsonSafeObject }) => Promise<void>,
  ): Promise<void> {
    try {
      const response = await this.apiClient.getMembershipsLevels();
      const files = (response.items ?? []) as ConnectorFile[];
      if (files.length > 0) await callback({ files, connectorProgress: {} });
    } catch (error) {
      console.warn(
        'YouTube: could not list membership levels (memberships scope likely not granted); skipping.',
        error,
      );
    }
  }

  private async pullReference(
    callback: (params: { files: ConnectorFile[]; connectorProgress?: JsonSafeObject }) => Promise<void>,
    fetch: () => Promise<{ items?: unknown[] }>,
  ): Promise<void> {
    const response = await fetch();
    const files = (response.items ?? []) as ConnectorFile[];
    if (files.length > 0) await callback({ files, connectorProgress: {} });
  }

  /**
   * Deep-fetch a video's English transcript and embed it on the record in-place,
   * mirroring how Notion embeds `page_content`. `transcript` is the editable
   * caption text; `transcriptId` (read-only) is the caption track the publish path
   * targets. A video with no English caption gets an empty transcript and no
   * `transcriptId`, so a user edit doesn't try to update a non-existent track.
   */
  private async attachTranscript(record: ConnectorFile): Promise<void> {
    const videoId = typeof record.id === 'string' ? record.id : undefined;
    if (!videoId) return;
    const { text, id } = await this.apiClient.getVideoTranscript(videoId);
    record.transcript = id ? text : '';
    if (id) record.transcriptId = id;
  }

  /**
   * Deep-fetch the first page of a video's comment threads and embed them on the
   * record (read-only). Quota-heavy → gated behind `includeComments`. Videos with
   * comments disabled return 403 → skip that video's comments rather than failing
   * the whole pull (warn + skip).
   */
  private async attachComments(record: ConnectorFile): Promise<void> {
    const videoId = typeof record.id === 'string' ? record.id : undefined;
    if (!videoId) return;
    try {
      const page = await this.apiClient.getVideoCommentThreadsPage(videoId);
      record.comments = page.items ?? [];
    } catch (error) {
      console.warn(`YouTube: could not fetch comments for video ${videoId} (likely disabled); skipping.`, error);
    }
  }

  getBatchSize(_operation: 'create' | 'update' | 'delete'): number {
    // YouTube has no bulk CRUD endpoints — records are written one at a time.
    return 1;
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async getNewFile(tableSpec: BaseJsonTableSpec): Promise<Record<string, unknown>> {
    const parsed = this.parseTableId(tableSpec.id);
    // Playlists require a snippet.title on create; seed the snippet so a new
    // record is closer to publishable.
    if (parsed.kind === 'playlists') return { snippet: { title: '' }, status: { privacyStatus: 'private' } };
    return {};
  }

  /**
   * Create records, dispatching on the entity kind. Returns each created record
   * (carrying its new `id`) so the framework can link the file. Kinds without
   * create support throw a clear "not supported" error (surface failures).
   */
  async createRecords(tableSpec: BaseJsonTableSpec, files: ConnectorFile[]): Promise<ConnectorFile[]> {
    const parsed = this.parseTableId(tableSpec.id);
    this.assertOwnedWritable(parsed, 'create');
    const results: ConnectorFile[] = [];
    for (const file of files) {
      switch (parsed.kind) {
        case 'playlists':
          results.push(
            (await this.apiClient.createPlaylist(this.pickParts(file, ['snippet', 'status']))) as ConnectorFile,
          );
          break;
        case 'playlistItems':
          results.push(
            (await this.apiClient.createPlaylistItem(
              this.pickParts(file, ['snippet', 'contentDetails']),
            )) as ConnectorFile,
          );
          break;
        case 'channelSections':
          results.push(
            (await this.apiClient.createChannelSection(
              this.pickParts(file, ['snippet', 'contentDetails']),
            )) as ConnectorFile,
          );
          break;
        case 'subscriptions':
          results.push((await this.apiClient.createSubscription(this.pickParts(file, ['snippet']))) as ConnectorFile);
          break;
        default:
          this.throwWriteNotSupported(parsed.kind, 'create');
      }
    }
    return results;
  }

  /**
   * Update records, dispatching on the entity kind. Videos keep the existing
   * snippet (+ transcript) update path; the other writable kinds send the parts
   * the API accepts. Kinds without update support throw.
   */
  async updateRecords(
    tableSpec: BaseJsonTableSpec,
    files: ConnectorFile[],
    changedFields: Record<string, unknown>[],
  ): Promise<ConnectorFile[]> {
    const parsed = this.parseTableId(tableSpec.id);
    this.assertOwnedWritable(parsed, 'update');

    if (parsed.kind === 'videos') {
      return this.updateVideos(files, changedFields);
    }

    const results: ConnectorFile[] = [];
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const changed = changedFields[i];
      const recordId = readRecordIdAsString(file, tableSpec.idPath);
      if (!recordId) {
        results.push(file);
        continue;
      }
      let persisted: ConnectorFile | undefined;
      switch (parsed.kind) {
        case 'playlists':
          this.assertNoReadonlyPartsChanged(changed, ['snippet', 'status']);
          persisted = (await this.apiClient.updatePlaylist(
            recordId,
            this.pickParts(file, ['snippet', 'status']),
          )) as ConnectorFile;
          break;
        case 'playlistItems':
          this.assertNoReadonlyPartsChanged(changed, ['snippet', 'contentDetails']);
          persisted = (await this.apiClient.updatePlaylistItem(
            recordId,
            this.pickParts(file, ['snippet', 'contentDetails']),
          )) as ConnectorFile;
          break;
        case 'channelSections':
          this.assertNoReadonlyPartsChanged(changed, ['snippet', 'contentDetails']);
          persisted = (await this.apiClient.updateChannelSection(
            recordId,
            this.pickParts(file, ['snippet', 'contentDetails']),
          )) as ConnectorFile;
          break;
        case 'channels':
          // The Channels table mixes the owned channel (writable) with additional
          // public channels (read-only). Reject a public-row edit with a clear
          // message rather than letting YouTube return an opaque 403.
          if (!this.isOwnedChannel(recordId)) {
            throw new Error(
              `YouTube: cannot edit channel '${recordId}' — it is an additional public channel and is read-only. ` +
                `To edit a channel you own, connect it separately and authorize it on Google's consent screen.`,
            );
          }
          this.assertNoReadonlyPartsChanged(changed, ['brandingSettings', 'status', 'localizations']);
          persisted = (await this.apiClient.updateChannel(
            recordId,
            this.pickParts(file, ['brandingSettings', 'status', 'localizations']),
          )) as ConnectorFile;
          break;
        default:
          this.throwWriteNotSupported(parsed.kind, 'update');
      }
      // Overlay what YouTube actually persisted onto the original file so read-only
      // parts the sparse response omitted survive the publish round-trip.
      results.push(persisted ? { ...file, ...persisted } : file);
    }
    return results;
  }

  /**
   * The existing video update path: send the editable snippet fields (always
   * including categoryId — YouTube requires it) and, when the transcript text
   * changed, update the caption track. Read-only parts survive the round-trip by
   * overlaying the persisted snippet onto the original file.
   */
  private async updateVideos(
    files: ConnectorFile[],
    changedFields: Record<string, unknown>[],
  ): Promise<ConnectorFile[]> {
    const results: ConnectorFile[] = [];
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const changed = changedFields[i];
      const videoId = file.id as string;
      // Surface an edit to a read-only video field (a non-snippet part like
      // statistics/status, or a read-only snippet sub-field like publishedAt /
      // channelId / thumbnails) instead of silently dropping it (DEV-10597).
      this.assertNoReadonlyVideoFieldsChanged(changed);
      const changedSnippet = (changed.snippet as Record<string, unknown> | undefined) ?? changed;
      const changedStatus = changed.status as Record<string, unknown> | undefined;

      // `videos.update?part=snippet` REPLACES the snippet, and YouTube requires BOTH
      // `title` and `categoryId` on every snippet write. So we cannot send only the
      // changed fields: a title-only edit 400s ("invalid categoryId"), a
      // description-only edit 400s ("empty title"), and even a passing sparse write
      // would wipe the fields we omitted. Merge the changes over the video's existing
      // snippet so the full writable set is always present.
      const snippetChanged = WRITABLE_VIDEO_SNIPPET_FIELDS.some((field) => changedSnippet[field] !== undefined);
      const statusChanged =
        changedStatus !== undefined && WRITABLE_VIDEO_STATUS_FIELDS.some((field) => changedStatus[field] !== undefined);

      const updateParts: { snippet?: Record<string, unknown>; status?: Record<string, unknown> } = {};
      if (snippetChanged) {
        const existingSnippet = (file.snippet as Record<string, unknown> | undefined) ?? {};
        const mergedSnippet = { ...existingSnippet, ...changedSnippet };
        updateParts.snippet = {
          title: mergedSnippet.title,
          description: mergedSnippet.description,
          categoryId: mergedSnippet.categoryId,
          defaultLanguage: mergedSnippet.defaultLanguage,
          tags: mergedSnippet.tags,
        };
      }
      if (statusChanged) {
        // `videos.update?part=status` likewise REPLACES the status part, so resend
        // the full writable status set (merged over the existing status) — sending
        // only the one changed sub-field would reset the others. `madeForKids` /
        // `uploadStatus` are read-only and excluded; `selfDeclaredMadeForKids` is
        // resent so YouTube keeps the existing made-for-kids declaration.
        updateParts.status = this.buildWritableVideoStatus(
          (file.status as Record<string, unknown> | undefined) ?? {},
          changedStatus,
        );
      }

      let persisted: YouTubeVideo | undefined;
      if (snippetChanged || statusChanged) {
        persisted = await this.apiClient.updateVideo(videoId, updateParts);
      }

      // Transcript update is keyed by transcriptId from the full file; only push when the transcript text changed.
      if (changed.transcript !== undefined && file.transcriptId) {
        try {
          await this.apiClient.updateTranscript(videoId, file.transcriptId as string, changed.transcript as string);
        } catch (error) {
          console.warn(`Failed to update transcript for video ${videoId}:`, error);
        }
      }

      const merged: ConnectorFile = persisted ? { ...file, ...(persisted as unknown as ConnectorFile) } : file;
      results.push(merged);
    }
    return results;
  }

  /**
   * Delete records, dispatching on the entity kind. Playlists / PlaylistItems /
   * ChannelSections / Subscriptions support delete; Videos do NOT (destructive —
   * maintainer decision) and Channel/read-only kinds do not. Each delete tolerates
   * an already-gone record.
   */
  async deleteRecords(tableSpec: BaseJsonTableSpec, files: ConnectorFile[]): Promise<void> {
    const parsed = this.parseTableId(tableSpec.id);
    this.assertOwnedWritable(parsed, 'delete');
    for (const filter of files) {
      const recordId = readRecordIdAsString(filter, tableSpec.idPath);
      if (!recordId) continue;
      switch (parsed.kind) {
        case 'playlists':
          await this.apiClient.deletePlaylist(recordId);
          break;
        case 'playlistItems':
          await this.apiClient.deletePlaylistItem(recordId);
          break;
        case 'channelSections':
          await this.apiClient.deleteChannelSection(recordId);
          break;
        case 'subscriptions':
          await this.apiClient.deleteSubscription(recordId);
          break;
        default:
          this.throwWriteNotSupported(parsed.kind, 'delete');
      }
    }
  }

  getSuggestedRecordFileNames(records: ConnectorFile[], tableSpec: BaseJsonTableSpec): (string | undefined)[] {
    const parsed = this.parseTableId(tableSpec.id);
    if (this.isReferenceKind(parsed.kind)) {
      // Reference rows have human-readable snippet titles, falling back to id.
      return suggestFileNamesFromFieldPaths(records, 'snippet.title', 'id');
    }
    // Per-channel content rows (and the Channels table) carry a snippet.title; fall back to the id.
    return suggestFileNamesFromFieldPaths(records, 'snippet.title', 'id');
  }

  extractConnectorErrorDetails(error: unknown): ConnectorErrorDetails {
    return this.fallbackErrorDetails(error);
  }

  // --- Helpers --------------------------------------------------------------

  /** Parse a table's `remoteId` into its entity kind + (for per-channel tables) channel id. */
  private parseTableId(id: EntityId): YouTubeParsedTableId {
    const [kind, channelId] = id.remoteId;
    if (!kind) {
      throw new Error(`YouTube: invalid table id ${JSON.stringify(id.remoteId)}`);
    }
    return { kind: kind as YouTubeEntityKind, channelId };
  }

  private isReferenceKind(kind: YouTubeEntityKind): boolean {
    return YOUTUBE_REFERENCE_ENTITY_BY_KIND.has(kind);
  }

  private requireChannelId(parsed: YouTubeParsedTableId): string {
    if (!parsed.channelId) {
      throw new Error(`YouTube: ${parsed.kind} table is missing its channel id`);
    }
    return parsed.channelId;
  }

  /** Resolve a channel's display title (the channel path segment) from its id. */
  private async resolveChannelTitle(channelId: string): Promise<string> {
    const own = await this.apiClient.getChannels();
    const ownMatch = own.items?.find((c) => c.id === channelId);
    if (ownMatch?.snippet?.title) return ownMatch.snippet.title;
    // Additional/public channel — look it up by id.
    const byId = await this.apiClient.getChannelsByIds([channelId]);
    const match = byId.items?.find((c) => c.id === channelId);
    return match?.snippet?.title || `Channel ${channelId}`;
  }

  /** True when `channelId` is the authorized identity's own channel (writes/private data allowed). */
  private isOwnedChannel(channelId: string): boolean {
    // The owned channel set is the only one `mine=true` returns; an additional
    // public channel is anything in extras. We can't cheaply re-query mine here in
    // every pull, so derive it: a channel id present in extras is NOT owned.
    return !this.readAdditionalChannelIds().includes(channelId);
  }

  /** Fail an owned-only write attempt on a public channel or a read-only kind, fast and clear. */
  private assertOwnedWritable(parsed: YouTubeParsedTableId, operation: 'create' | 'update' | 'delete'): void {
    if (this.isReferenceKind(parsed.kind)) {
      throw new Error(`YouTube: ${operation} is not supported for reference table '${parsed.kind}' (read-only).`);
    }
    if (parsed.channelId && !this.isOwnedChannel(parsed.channelId)) {
      throw new Error(
        `YouTube: ${operation} is not supported for additional public channel '${parsed.channelId}' (read-only).`,
      );
    }
  }

  /**
   * Fetch records one-by-one by id and flush to the callback in batches. `fetchOne`
   * returns the resource or undefined (404/missing → skipped).
   */
  private async fetchByIds(
    ids: string[],
    fetchOne: (id: string) => Promise<ConnectorFile | undefined>,
    callback: (params: { files: ConnectorFile[] }) => Promise<void>,
  ): Promise<void> {
    const buffer: ConnectorFile[] = [];
    const BATCH_SIZE = 20;
    for (const id of ids) {
      const record = await fetchOne(id);
      if (record) buffer.push(record);
      if (buffer.length >= BATCH_SIZE) await callback({ files: buffer.splice(0) });
    }
    if (buffer.length > 0) await callback({ files: buffer });
  }

  /** List every playlist id for a channel (used to fan out the PlaylistItems pull). */
  private async listAllPlaylistIds(channelId: string, mine: boolean): Promise<string[]> {
    const playlistIds: string[] = [];
    let nextPageToken: string | undefined;
    do {
      const page = await this.apiClient.getPlaylistsPage(channelId, { mine, pageToken: nextPageToken });
      for (const playlist of page.items ?? []) {
        if (typeof playlist.id === 'string') playlistIds.push(playlist.id);
      }
      nextPageToken = page.nextPageToken;
    } while (nextPageToken);
    return playlistIds;
  }

  /**
   * Pick only the given top-level parts from a record (e.g. `snippet`, `status`)
   * for a write body, dropping computed parts (id/etag/statistics/contentDetails)
   * the API rejects or ignores. Only parts actually present on the record are
   * included, so a sparse write stays partial.
   */
  private pickParts(file: ConnectorFile, parts: string[]): Record<string, unknown> {
    const body: Record<string, unknown> = {};
    for (const part of parts) {
      if (part in file) body[part] = file[part];
    }
    return body;
  }

  /**
   * Throw if the user's sparse changedFields touch a top-level part that's
   * read-only for this entity kind (DEV-10597). The write payload is built from
   * the full file via {@link pickParts}, which silently drops any part outside
   * `writableParts` (id/etag/statistics/contentDetails/…); without this guard an
   * edit to such a part would vanish while the publish reported success. Identity
   * wrappers (`id`, `etag`, `kind`) are ignored — they're never user edits.
   */
  private assertNoReadonlyPartsChanged(changed: Record<string, unknown> | undefined, writableParts: string[]): void {
    if (!changed) return;
    const ignoredKeys = new Set(['id', 'etag', 'kind']);
    const writablePartSet = new Set(writableParts);
    const readonlyChangedPartNames = Object.keys(changed).filter(
      (key) => !ignoredKeys.has(key) && !writablePartSet.has(key),
    );
    if (readonlyChangedPartNames.length > 0) {
      throw new ReadonlyFieldEditError(readonlyFieldEditErrorMessage(readonlyChangedPartNames));
    }
  }

  /**
   * Build the `status` part body for a `videos.update?part=status` write. The
   * status part is REPLACED wholesale, so we resend every writable status field
   * (merged: the user's changes over the video's existing status), plus
   * `selfDeclaredMadeForKids` to preserve the made-for-kids declaration. Read-only
   * status fields (`uploadStatus`, the computed `madeForKids`) are excluded —
   * YouTube rejects or ignores them.
   */
  private buildWritableVideoStatus(
    existingStatus: Record<string, unknown>,
    changedStatus: Record<string, unknown>,
  ): Record<string, unknown> {
    const mergedStatus = { ...existingStatus, ...changedStatus };
    const statusBody: Record<string, unknown> = {};
    for (const field of WRITABLE_VIDEO_STATUS_FIELDS) {
      if (mergedStatus[field] !== undefined) statusBody[field] = mergedStatus[field];
    }
    if (mergedStatus.selfDeclaredMadeForKids !== undefined) {
      statusBody.selfDeclaredMadeForKids = mergedStatus.selfDeclaredMadeForKids;
    }
    return statusBody;
  }

  /**
   * Throw if the user's sparse changedFields touch a read-only video field
   * (DEV-10597). Videos write the snippet, the status (DEV-10629), and —
   * separately — the transcript; only the editable sub-fields of snippet
   * ({@link WRITABLE_VIDEO_SNIPPET_FIELDS}) and status
   * ({@link WRITABLE_VIDEO_STATUS_FIELDS}) are writable. Everything else (other
   * parts like statistics/contentDetails, read-only snippet sub-fields like
   * publishedAt / channelId / thumbnails, and read-only status sub-fields like
   * uploadStatus / madeForKids) is silently dropped by the update path without
   * this guard.
   */
  private assertNoReadonlyVideoFieldsChanged(changed: Record<string, unknown>): void {
    const writableSnippetFields = new Set<string>(WRITABLE_VIDEO_SNIPPET_FIELDS);
    const writableStatusFields = new Set<string>(WRITABLE_VIDEO_STATUS_FIELDS);
    const readonlyChangedFieldNames: string[] = [];

    const collectReadonlySubfields = (part: unknown, writableFields: Set<string>): void => {
      if (part && typeof part === 'object' && !Array.isArray(part)) {
        for (const [key, value] of Object.entries(part)) {
          if (value !== undefined && !writableFields.has(key)) readonlyChangedFieldNames.push(key);
        }
      }
    };

    if (changed.snippet !== undefined || changed.status !== undefined) {
      // Normal sparse diff: parts other than snippet/status (and the special-cased
      // transcript / identity keys) are not writable on videos.
      const writableTopLevelKeys = new Set(['snippet', 'status', 'transcript', 'id', 'transcriptId']);
      for (const key of Object.keys(changed)) {
        if (!writableTopLevelKeys.has(key)) readonlyChangedFieldNames.push(key);
      }
      collectReadonlySubfields(changed.snippet, writableSnippetFields);
      collectReadonlySubfields(changed.status, writableStatusFields);
    } else {
      // Fallback shape: `changed` carries snippet sub-fields flat (mirrors the
      // `?? changed` the video update path uses when there's no snippet wrapper).
      for (const [key, value] of Object.entries(changed)) {
        if (key === 'transcript' || key === 'id' || key === 'transcriptId') continue;
        if (value !== undefined && !writableSnippetFields.has(key)) readonlyChangedFieldNames.push(key);
      }
    }

    if (readonlyChangedFieldNames.length > 0) {
      throw new ReadonlyFieldEditError(readonlyFieldEditErrorMessage(readonlyChangedFieldNames));
    }
  }

  private throwWriteNotSupported(kind: YouTubeEntityKind, operation: string): never {
    if (kind === 'videos') {
      throw new Error(
        `YouTube does not support ${operation} for videos through the API. ${
          operation === 'create'
            ? 'Videos must be uploaded through the YouTube interface.'
            : 'Video deletion is disabled.'
        }`,
      );
    }
    throw new Error(`YouTube: ${operation} is not supported for '${kind}'.`);
  }

  private throwUnknownKind(kind: string): never {
    throw new Error(`YouTube: unknown entity kind '${kind}'.`);
  }
}

connectorRegistry.register({
  service: Service.YOUTUBE,
  metadata: YouTubeConnector.metadata,
  advancedSettings: YouTubeConnector.advancedSettings,
  supportedAuthMethods: ['oauth', 'oauth_custom'],
  async createConnector(ctx) {
    if (!ctx.connectorAccount) {
      throw new ConnectorInstantiationError('Connector account is required for YouTube', Service.YOUTUBE);
    }
    if (ctx.connectorAccount.authType === 'OAUTH') {
      const accessToken = await ctx.getOAuthAccessToken(ctx.connectorAccount.id);
      return new YouTubeConnector(accessToken, ctx.connectorAccount);
    } else {
      throw new Error('YouTube only supports OAuth authentication');
    }
  },
});
