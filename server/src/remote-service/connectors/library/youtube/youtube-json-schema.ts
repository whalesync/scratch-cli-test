import { Type, type TSchema } from '@sinclair/typebox';
import { ValuePointer } from '@sinclair/typebox/value';
import { ForeignKeyOptionSchema, X_SCRATCH_FOREIGN_KEY_OPTIONS, X_SCRATCH_READONLY } from '@spinner/shared-types';
import { BaseJsonTableSpec, DotPath, dotPath, EntityId } from '../../types';
import { escapePointerToken } from '../../utils/json-pointer';
import {
  channelsTableLinkId,
  channelTableWsId,
  YOUTUBE_REFERENCE_PARENT_PATH,
  YouTubeEntityKind,
} from './youtube-entities';

// --- Shared field helpers -------------------------------------------------

/** A server-computed string we never write back (ids, etags, timestamps, statistics). */
const readonlyString = (description: string): TSchema =>
  Type.Optional(Type.String({ description, [X_SCRATCH_READONLY]: true }));

/** An editable optional string. */
const editableString = (description: string): TSchema => Type.Optional(Type.String({ description }));

/** A foreign-key string column pointing at another table's `wsId`. */
const foreignKeyString = (description: string, linkedTableId: string, readonly = false): TSchema =>
  Type.Optional(
    Type.String({
      description,
      [X_SCRATCH_FOREIGN_KEY_OPTIONS]: { linkedTableId },
      ...(readonly ? { [X_SCRATCH_READONLY]: true } : {}),
    }),
  );

/** A read-only thumbnails map (every YouTube resource carries this server-rendered object). */
const readonlyThumbnails = (): TSchema =>
  Type.Optional(
    Type.Record(Type.String(), Type.Unknown(), { description: 'Thumbnail images', [X_SCRATCH_READONLY]: true }),
  );

/** Common spec tail: how the framework places the table on disk + identifies records. */
function tableSpecTail(
  id: EntityId,
  name: string,
  schema: TSchema,
  basePath: string[],
  titlePath: DotPath,
  mainContentPath?: DotPath,
): BaseJsonTableSpec {
  return {
    id,
    slug: id.wsId,
    name,
    schema,
    idPath: dotPath('id'),
    titlePath,
    ...(mainContentPath ? { mainContentPath } : {}),
    basePath,
    generatedAt: new Date().toISOString(),
  };
}

// --- Videos ---------------------------------------------------------------

/**
 * Build the Videos table spec for a channel. The channel is a structural path
 * segment (`basePath = [channelTitle]`), so video records land at
 * `/{connection}/{channelTitle}/Videos/{video}.json`. `snippet.channelId` is a
 * read-only FK into the top-level Channels table. KEEPS the existing video
 * schema (incl. the deep-fetched `transcript`/`transcriptId` + `comments`).
 */
export function buildYouTubeJsonTableSpec(id: EntityId, channelId: string, channelTitle: string): BaseJsonTableSpec {
  const schema = Type.Object(
    {
      kind: readonlyString('Resource type identifier'),
      etag: readonlyString('ETag of this resource'),
      id: Type.String({ description: 'Unique video identifier', [X_SCRATCH_READONLY]: true }),
      snippet: Type.Optional(
        Type.Object(
          {
            publishedAt: Type.Optional(
              Type.String({ description: 'Video publish date', format: 'date-time', [X_SCRATCH_READONLY]: true }),
            ),
            channelId: foreignKeyString('Channel ID', channelsTableLinkId(), true),
            title: editableString('Video title'),
            description: editableString('Video description'),
            thumbnails: readonlyThumbnails(),
            channelTitle: readonlyString('Channel title'),
            tags: Type.Optional(Type.Array(Type.String(), { description: 'Video tags' })),
            categoryId: editableString('Video category ID'),
            defaultLanguage: editableString('Default language'),
            defaultAudioLanguage: editableString('Default audio language'),
          },
          { description: 'Video snippet metadata' },
        ),
      ),
      contentDetails: Type.Optional(
        Type.Object(
          {
            duration: readonlyString('Video duration in ISO 8601 format'),
            dimension: readonlyString('2d or 3d'),
            definition: readonlyString('hd or sd'),
            caption: readonlyString('Caption availability'),
            licensedContent: Type.Optional(
              Type.Boolean({ description: 'Licensed content flag', [X_SCRATCH_READONLY]: true }),
            ),
          },
          { description: 'Video content details' },
        ),
      ),
      status: Type.Optional(
        Type.Object(
          {
            uploadStatus: readonlyString('Upload status'),
            privacyStatus: editableString('Privacy status: public, unlisted, or private'),
            license: editableString('Video license'),
            embeddable: Type.Optional(Type.Boolean({ description: 'Can video be embedded' })),
            publicStatsViewable: Type.Optional(Type.Boolean({ description: 'Public stats visibility' })),
            madeForKids: Type.Optional(Type.Boolean({ description: 'Made for kids flag', [X_SCRATCH_READONLY]: true })),
          },
          { description: 'Video status information' },
        ),
      ),
      statistics: Type.Optional(
        Type.Object(
          {
            viewCount: readonlyString('View count'),
            likeCount: readonlyString('Like count'),
            commentCount: readonlyString('Comment count'),
          },
          { description: 'Video statistics' },
        ),
      ),
      // Synthetic, deep-fetched field (not part of the raw videos.list resource),
      // populated only when the table's "Include video transcript" setting is on —
      // mirrors how Notion embeds `page_content`. Editing + publishing replaces the
      // caption track identified by `transcriptId`.
      transcript: editableString(
        'Video transcript (English captions); populated only when transcript fetching is enabled',
      ),
      transcriptId: readonlyString('Caption track ID backing the transcript'),
      // Synthetic, deep-fetched read-only field, populated only when the table's
      // "Include video comments" setting is on (quota-heavy — first page only).
      comments: Type.Optional(
        Type.Array(Type.Unknown(), {
          description: 'Video comment threads (first page); populated only when comment fetching is enabled',
          [X_SCRATCH_READONLY]: true,
        }),
      ),
    },
    { $id: `youtube/videos/${channelId}`, title: 'Videos' },
  );

  return tableSpecTail(id, 'Videos', schema, [channelTitle], dotPath('snippet.title'), dotPath('snippet.description'));
}

// --- Playlists ------------------------------------------------------------

/** Build the Playlists table spec for a channel. Editable: snippet.title/description, status.privacyStatus. */
export function buildPlaylistsJsonTableSpec(id: EntityId, channelId: string, channelTitle: string): BaseJsonTableSpec {
  const schema = Type.Object(
    {
      kind: readonlyString('Resource type identifier'),
      etag: readonlyString('ETag of this resource'),
      id: Type.String({ description: 'Playlist ID', [X_SCRATCH_READONLY]: true }),
      snippet: Type.Optional(
        Type.Object(
          {
            publishedAt: Type.Optional(
              Type.String({ description: 'Playlist creation date', format: 'date-time', [X_SCRATCH_READONLY]: true }),
            ),
            channelId: foreignKeyString('Owning channel ID', channelsTableLinkId(), true),
            title: editableString('Playlist title'),
            description: editableString('Playlist description'),
            thumbnails: readonlyThumbnails(),
            channelTitle: readonlyString('Owning channel title'),
            defaultLanguage: editableString('Default language for snippet text'),
          },
          { description: 'Playlist snippet metadata' },
        ),
      ),
      status: Type.Optional(
        Type.Object(
          { privacyStatus: editableString('Privacy status: public, unlisted, or private') },
          { description: 'Playlist status' },
        ),
      ),
      contentDetails: Type.Optional(
        Type.Object(
          {
            itemCount: Type.Optional(
              Type.Number({ description: 'Number of videos in the playlist', [X_SCRATCH_READONLY]: true }),
            ),
          },
          { description: 'Playlist content details', [X_SCRATCH_READONLY]: true },
        ),
      ),
    },
    { $id: `youtube/playlists/${channelId}`, title: 'Playlists' },
  );

  return tableSpecTail(
    id,
    'Playlists',
    schema,
    [channelTitle],
    dotPath('snippet.title'),
    dotPath('snippet.description'),
  );
}

// --- Playlist items -------------------------------------------------------

/**
 * Build the PlaylistItems table spec for a channel. This is the connector's
 * FK-write / re-parent path: `snippet.playlistId` (FK → Playlists) and
 * `contentDetails.videoId` (FK → Videos) are EDITABLE, so a user can move a video
 * between playlists or change which video an item points at. Also editable:
 * `snippet.position`, `contentDetails.note`.
 */
export function buildPlaylistItemsJsonTableSpec(
  id: EntityId,
  channelId: string,
  channelTitle: string,
): BaseJsonTableSpec {
  const schema = Type.Object(
    {
      kind: readonlyString('Resource type identifier'),
      etag: readonlyString('ETag of this resource'),
      id: Type.String({ description: 'Playlist item ID', [X_SCRATCH_READONLY]: true }),
      snippet: Type.Optional(
        Type.Object(
          {
            publishedAt: Type.Optional(
              Type.String({ description: 'When the item was added', format: 'date-time', [X_SCRATCH_READONLY]: true }),
            ),
            channelId: foreignKeyString('Channel that owns the playlist', channelsTableLinkId(), true),
            title: readonlyString('Title of the referenced video'),
            description: readonlyString('Description of the referenced video'),
            thumbnails: readonlyThumbnails(),
            // Editable FK — the re-parent: move the item to another playlist.
            playlistId: foreignKeyString(
              'Playlist this item belongs to (editable to re-parent)',
              channelTableWsId('playlists', channelId),
            ),
            position: Type.Optional(
              Type.Number({ description: 'Zero-based position of the item in the playlist (editable)' }),
            ),
            resourceId: Type.Optional(
              Type.Record(Type.String(), Type.Unknown(), {
                description: 'The resource (video) this item points at',
                [X_SCRATCH_READONLY]: true,
              }),
            ),
          },
          { description: 'Playlist item snippet metadata' },
        ),
      ),
      contentDetails: Type.Optional(
        Type.Object(
          {
            // Editable FK — which video this item points at.
            videoId: foreignKeyString('Video this item references (editable)', channelTableWsId('videos', channelId)),
            note: editableString('A user-supplied note about the item'),
            videoPublishedAt: readonlyString('When the referenced video was published'),
          },
          { description: 'Playlist item content details' },
        ),
      ),
    },
    { $id: `youtube/playlistItems/${channelId}`, title: 'PlaylistItems' },
  );

  return tableSpecTail(id, 'PlaylistItems', schema, [channelTitle], dotPath('snippet.title'));
}

// --- Channel sections -----------------------------------------------------

/** Build the ChannelSections table spec for a channel. snippet (type/title/position) + contentDetails are editable. */
export function buildChannelSectionsJsonTableSpec(
  id: EntityId,
  channelId: string,
  channelTitle: string,
): BaseJsonTableSpec {
  const schema = Type.Object(
    {
      kind: readonlyString('Resource type identifier'),
      etag: readonlyString('ETag of this resource'),
      id: Type.String({ description: 'Channel section ID', [X_SCRATCH_READONLY]: true }),
      snippet: Type.Optional(
        Type.Object(
          {
            type: editableString('Section type (e.g. singlePlaylist, multiplePlaylists, recentUploads)'),
            channelId: foreignKeyString('Owning channel ID', channelsTableLinkId(), true),
            title: editableString('Section title (for the *Playlists section types)'),
            position: Type.Optional(
              Type.Number({ description: 'Zero-based position of the section on the channel page' }),
            ),
          },
          { description: 'Channel section snippet metadata' },
        ),
      ),
      contentDetails: Type.Optional(
        Type.Object(
          {
            playlists: Type.Optional(
              Type.Array(Type.String(), { description: 'Playlist IDs featured in this section' }),
            ),
            channels: Type.Optional(Type.Array(Type.String(), { description: 'Channel IDs featured in this section' })),
          },
          { description: 'Channel section content (playlists/channels it features)' },
        ),
      ),
    },
    { $id: `youtube/channelSections/${channelId}`, title: 'ChannelSections' },
  );

  return tableSpecTail(id, 'ChannelSections', schema, [channelTitle], dotPath('snippet.title'));
}

// --- Channel (one-row table) ----------------------------------------------

/**
 * Build the top-level Channels table spec. One row per channel in the connection
 * (the owned channel + every additional public channel); each record is a channel
 * resource. Only `brandingSettings`, `status`, and `localizations` are mutable on
 * `channels.update`, and only for the owned channel (public rows are rejected at
 * write time) — everything else (snippet, statistics, contentDetails) is
 * server-computed and read-only.
 */
export function buildChannelsJsonTableSpec(id: EntityId): BaseJsonTableSpec {
  const schema = Type.Object(
    {
      kind: readonlyString('Resource type identifier'),
      etag: readonlyString('ETag of this resource'),
      id: Type.String({ description: 'Channel ID', [X_SCRATCH_READONLY]: true }),
      snippet: Type.Optional(
        Type.Object(
          {
            title: readonlyString('Channel title (edit via brandingSettings.channel.title)'),
            description: readonlyString('Channel description (edit via brandingSettings.channel.description)'),
            customUrl: readonlyString('Channel custom URL'),
            publishedAt: Type.Optional(
              Type.String({ description: 'Channel creation date', format: 'date-time', [X_SCRATCH_READONLY]: true }),
            ),
            thumbnails: readonlyThumbnails(),
            country: readonlyString('Channel country (edit via brandingSettings.channel.country)'),
          },
          {
            description: 'Channel snippet metadata (read-only — edit branding via brandingSettings)',
            [X_SCRATCH_READONLY]: true,
          },
        ),
      ),
      statistics: Type.Optional(
        Type.Object(
          {
            viewCount: readonlyString('Total channel view count'),
            subscriberCount: readonlyString('Subscriber count'),
            hiddenSubscriberCount: Type.Optional(
              Type.Boolean({ description: 'Whether the subscriber count is hidden', [X_SCRATCH_READONLY]: true }),
            ),
            videoCount: readonlyString('Number of public videos'),
          },
          { description: 'Channel statistics', [X_SCRATCH_READONLY]: true },
        ),
      ),
      contentDetails: Type.Optional(
        Type.Object(
          {
            relatedPlaylists: Type.Optional(
              Type.Record(Type.String(), Type.Unknown(), {
                description: 'Related playlists (uploads, likes, …)',
                [X_SCRATCH_READONLY]: true,
              }),
            ),
          },
          { description: 'Channel content details', [X_SCRATCH_READONLY]: true },
        ),
      ),
      status: Type.Optional(
        Type.Object(
          {
            privacyStatus: editableString('Channel privacy status'),
            isLinked: Type.Optional(
              Type.Boolean({
                description: 'Whether the channel is linked to a Google account',
                [X_SCRATCH_READONLY]: true,
              }),
            ),
            longUploadsStatus: readonlyString('Whether the channel can upload videos longer than 15 minutes'),
            madeForKids: Type.Optional(
              Type.Boolean({ description: 'Whether the channel is designated as made for kids' }),
            ),
            selfDeclaredMadeForKids: Type.Optional(Type.Boolean({ description: 'Self-declared made-for-kids flag' })),
          },
          { description: 'Channel status (privacyStatus / madeForKids are editable)' },
        ),
      ),
      brandingSettings: Type.Optional(
        Type.Record(Type.String(), Type.Unknown(), {
          description: 'Channel branding (title/description/keywords/country/etc.) — editable',
        }),
      ),
      localizations: Type.Optional(
        Type.Record(Type.String(), Type.Unknown(), {
          description: 'Per-language localized title/description — editable',
        }),
      ),
    },
    { $id: 'youtube/channels', title: 'Channels' },
  );

  // Top-level table (`basePath: []`) — one row per channel in the connection,
  // landing at `/{connection}/Channels/{channel}.json`. It is the FK target the
  // per-channel tables resolve `snippet.channelId` against (row `id` = channelId).
  return tableSpecTail(id, 'Channels', schema, [], dotPath('snippet.title'), dotPath('snippet.description'));
}

// --- Subscriptions (owner-only) -------------------------------------------

/** Build the Subscriptions table spec for the owned channel. Mostly read; create/delete only. */
export function buildSubscriptionsJsonTableSpec(
  id: EntityId,
  channelId: string,
  channelTitle: string,
): BaseJsonTableSpec {
  const schema = Type.Object(
    {
      kind: readonlyString('Resource type identifier'),
      etag: readonlyString('ETag of this resource'),
      id: Type.String({ description: 'Subscription ID', [X_SCRATCH_READONLY]: true }),
      snippet: Type.Optional(
        Type.Object(
          {
            publishedAt: Type.Optional(
              Type.String({
                description: 'When the subscription was created',
                format: 'date-time',
                [X_SCRATCH_READONLY]: true,
              }),
            ),
            title: readonlyString('Title of the subscribed-to resource'),
            description: readonlyString('Description of the subscribed-to resource'),
            channelId: foreignKeyString('Subscriber channel ID', channelsTableLinkId(), true),
            resourceId: Type.Optional(
              Type.Record(Type.String(), Type.Unknown(), {
                description: 'The channel this subscription points at (set on create)',
              }),
            ),
            thumbnails: readonlyThumbnails(),
          },
          { description: 'Subscription snippet metadata' },
        ),
      ),
      contentDetails: Type.Optional(
        Type.Record(Type.String(), Type.Unknown(), {
          description: 'Subscription content details',
          [X_SCRATCH_READONLY]: true,
        }),
      ),
    },
    { $id: `youtube/subscriptions/${channelId}`, title: 'Subscriptions' },
  );

  return tableSpecTail(id, 'Subscriptions', schema, [channelTitle], dotPath('snippet.title'));
}

// --- Members (owner-only, read-only) --------------------------------------

/** Build the Members table spec (read-only). Requires the channel-memberships scope. */
export function buildMembersJsonTableSpec(id: EntityId, channelId: string, channelTitle: string): BaseJsonTableSpec {
  const schema = Type.Object(
    {
      kind: readonlyString('Resource type identifier'),
      etag: readonlyString('ETag of this resource'),
      snippet: Type.Optional(
        Type.Object(
          {
            memberDetails: Type.Optional(
              Type.Record(Type.String(), Type.Unknown(), {
                description: 'The member channel details',
                [X_SCRATCH_READONLY]: true,
              }),
            ),
            membershipsDetails: Type.Optional(
              Type.Record(Type.String(), Type.Unknown(), {
                description: 'Membership level + duration details',
                [X_SCRATCH_READONLY]: true,
              }),
            ),
          },
          { description: 'Member snippet (read-only)', [X_SCRATCH_READONLY]: true },
        ),
      ),
    },
    { $id: `youtube/members/${channelId}`, title: 'Members' },
  );
  // Members have no top-level `id` (the snippet is keyed by member channel id);
  // keep the id path at `id` and let the framework fall back to the filename index.
  return tableSpecTail(id, 'Members', schema, [channelTitle], dotPath('snippet.memberDetails.displayName'));
}

// --- Membership levels (owner-only, read-only) ----------------------------

/** Build the MembershipsLevels table spec (read-only). Requires the channel-memberships scope. */
export function buildMembershipsLevelsJsonTableSpec(
  id: EntityId,
  channelId: string,
  channelTitle: string,
): BaseJsonTableSpec {
  const schema = Type.Object(
    {
      kind: readonlyString('Resource type identifier'),
      etag: readonlyString('ETag of this resource'),
      id: Type.String({ description: 'Membership level ID', [X_SCRATCH_READONLY]: true }),
      snippet: Type.Optional(
        Type.Object(
          {
            creatorChannelId: foreignKeyString('Channel that offers this level', channelsTableLinkId(), true),
            levelDetails: Type.Optional(
              Type.Record(Type.String(), Type.Unknown(), {
                description: 'Level display name + pricing',
                [X_SCRATCH_READONLY]: true,
              }),
            ),
          },
          { description: 'Membership level snippet (read-only)', [X_SCRATCH_READONLY]: true },
        ),
      ),
    },
    { $id: `youtube/membershipsLevels/${channelId}`, title: 'MembershipsLevels' },
  );
  return tableSpecTail(id, 'MembershipsLevels', schema, [channelTitle], dotPath('snippet.levelDetails.displayName'));
}

// --- Reference tables (public, read-only) ---------------------------------

/**
 * Build a reference table spec (videoCategories / i18nLanguages / i18nRegions).
 * These are public lookup data shared by all channels, grouped under `/Reference/`.
 * Every field is read-only.
 */
export function buildReferenceJsonTableSpec(
  id: EntityId,
  kind: YouTubeEntityKind,
  displayName: string,
): BaseJsonTableSpec {
  const schema = Type.Object(
    {
      kind: readonlyString('Resource type identifier'),
      etag: readonlyString('ETag of this resource'),
      id: Type.String({ description: `${displayName} ID`, [X_SCRATCH_READONLY]: true }),
      snippet: Type.Optional(
        Type.Record(Type.String(), Type.Unknown(), {
          description: `${displayName} details`,
          [X_SCRATCH_READONLY]: true,
        }),
      ),
    },
    { $id: `youtube/${kind}`, title: displayName },
  );

  return tableSpecTail(id, displayName, schema, [YOUTUBE_REFERENCE_PARENT_PATH], dotPath('snippet.title'));
}

// --- JSON-pointer helpers (used by isReadonlyField / isForeignKey) --------

/**
 * Convert a dot-notation field path (e.g. "snippet.channelId") to a JSON pointer
 * path through nested properties in the schema. Each segment is RFC 6901-escaped
 * so segments containing `/` or `~` walk to the right node.
 */
function fieldToPointer(field: string): string {
  return '/properties/' + field.split('.').map(escapePointerToken).join('/properties/');
}

/**
 * Checks if a field is readonly.
 * @param field - The dot-notation field path (e.g. "id", "snippet.channelId").
 * @param tableSpec - The table specification.
 * @returns True if the field is readonly, false otherwise.
 */
export function isReadonlyField(field: string, tableSpec: BaseJsonTableSpec): boolean {
  return ValuePointer.Get(tableSpec.schema, `${fieldToPointer(field)}/${X_SCRATCH_READONLY}`) === true;
}

/**
 * Checks if a field is a foreign key.
 * @param field - The dot-notation field path (e.g. "snippet.channelId").
 * @param tableSpec - The table specification.
 * @returns True if the field is a foreign key, false otherwise.
 */
export function isForeignKey(field: string, tableSpec: BaseJsonTableSpec): boolean {
  return ValuePointer.Has(tableSpec.schema, `${fieldToPointer(field)}/${X_SCRATCH_FOREIGN_KEY_OPTIONS}`) !== undefined;
}

/**
 * Gets the foreign key options for a field if they exist.
 * @param field - The dot-notation field path (e.g. "snippet.channelId").
 * @param tableSpec - The table specification.
 * @returns The foreign key options, or undefined if the field is not a foreign key.
 */
export function getForeignKeyOptions(field: string, tableSpec: BaseJsonTableSpec): ForeignKeyOptionSchema | undefined {
  return ValuePointer.Get(tableSpec.schema, `${fieldToPointer(field)}/${X_SCRATCH_FOREIGN_KEY_OPTIONS}`) as
    | ForeignKeyOptionSchema
    | undefined;
}
