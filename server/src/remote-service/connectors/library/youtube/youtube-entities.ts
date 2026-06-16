/**
 * Registry of the YouTube entity kinds the connector exposes.
 *
 * The connector is **multi-entity** (the ClickUp pattern): each table's
 * `EntityId.remoteId` carries the entity kind as its first segment, and the
 * connector dispatches every operation (fetchJsonTableSpec / pullRecordFiles /
 * createRecords / …) on `remoteId[0]`.
 *
 * Two table shapes:
 *  - **Per-channel** tables — `remoteId = [kind, channelId]`, `wsId = "<kind>_<channelId>"`.
 *    The channel becomes a structural PATH SEGMENT (`basePath = [channelTitle]`),
 *    so records land at `/{connection}/{channelTitle}/{Entity}/{record}.json`.
 *  - **Reference** tables — `remoteId = [kind]`, `wsId = "<kind>"`,
 *    `basePath = ["Reference"]` (public, read-only lookup data shared by all channels).
 *  - The single **Channels** table — `remoteId = ["channels"]`, `wsId = "channels"`,
 *    top-level (`basePath = []`). One row per channel involved in the connection
 *    (the owned channel + every additional public channel). It is the FK target the
 *    per-channel tables point `snippet.channelId` at (each row's `id` is the channelId).
 *
 * The owned channel (returned by `channels.list?mine=true`) emits every per-channel
 * kind with writes enabled per `OWNED_WRITE_SUPPORT`. Additional PUBLIC channels
 * (entered by id) emit only the public-readable subset, all writes disabled.
 */

/** Every YouTube entity kind. The first segment of a table's `remoteId`. */
export type YouTubeEntityKind =
  | 'videos'
  | 'playlists'
  | 'playlistItems'
  | 'channelSections'
  | 'channels'
  | 'subscriptions'
  | 'members'
  | 'membershipsLevels'
  | 'videoCategories'
  | 'i18nLanguages'
  | 'i18nRegions';

/** Which write operations the owned channel supports for a per-channel kind. */
export interface YouTubeWriteSupport {
  create: boolean;
  update: boolean;
  delete: boolean;
}

/** Static metadata describing one per-channel entity kind. */
export interface YouTubeChannelEntityConfig {
  kind: YouTubeEntityKind;
  /** Display name of the table (the entity folder under the channel). */
  displayName: string;
  /** Whether this entity reads only the OWNER's own data (Subscriptions/Members/…). */
  ownerOnly: boolean;
  /** Write operations the owned channel supports (additional public channels are always read-only). */
  ownedWriteSupport: YouTubeWriteSupport;
  /** Owner-only read-only tables (Members/MembershipsLevels) that may 403 → graceful degrade. */
  readonlyOwnerScoped?: boolean;
}

/** Static metadata describing one reference (public, read-only) entity kind. */
export interface YouTubeReferenceEntityConfig {
  kind: YouTubeEntityKind;
  displayName: string;
}

const NO_WRITES: YouTubeWriteSupport = { create: false, update: false, delete: false };
const FULL_WRITES: YouTubeWriteSupport = { create: true, update: true, delete: true };

/**
 * Per-channel entity kinds, in table-picker order. Writes per the agreed matrix:
 *  - **Videos** — update only (no create: needs a resumable media upload; no
 *    delete: destructive, maintainer decision — keep throwing).
 *  - **Playlists / PlaylistItems / ChannelSections** — full CRUD.
 *  - **Subscriptions** — create + delete (insert/unsubscribe); no update.
 *  - **Members / MembershipsLevels** — owner-only, read-only (require the
 *    channel-memberships scope; degrade gracefully on 403).
 */
export const YOUTUBE_CHANNEL_ENTITIES: readonly YouTubeChannelEntityConfig[] = [
  {
    kind: 'videos',
    displayName: 'Videos',
    ownerOnly: false,
    ownedWriteSupport: { create: false, update: true, delete: false },
  },
  { kind: 'playlists', displayName: 'Playlists', ownerOnly: false, ownedWriteSupport: FULL_WRITES },
  { kind: 'playlistItems', displayName: 'PlaylistItems', ownerOnly: false, ownedWriteSupport: FULL_WRITES },
  { kind: 'channelSections', displayName: 'ChannelSections', ownerOnly: false, ownedWriteSupport: FULL_WRITES },
  {
    kind: 'subscriptions',
    displayName: 'Subscriptions',
    ownerOnly: true,
    ownedWriteSupport: { create: true, update: false, delete: true },
  },
  { kind: 'members', displayName: 'Members', ownerOnly: true, ownedWriteSupport: NO_WRITES, readonlyOwnerScoped: true },
  {
    kind: 'membershipsLevels',
    displayName: 'MembershipsLevels',
    ownerOnly: true,
    ownedWriteSupport: NO_WRITES,
    readonlyOwnerScoped: true,
  },
] as const;

/** Reference (public, read-only) entity kinds, grouped under `/Reference/`. */
export const YOUTUBE_REFERENCE_ENTITIES: readonly YouTubeReferenceEntityConfig[] = [
  { kind: 'videoCategories', displayName: 'Video Categories' },
  { kind: 'i18nLanguages', displayName: 'i18n Languages' },
  { kind: 'i18nRegions', displayName: 'i18n Regions' },
] as const;

/** The kinds an additional PUBLIC channel may read (only public-readable, non-owner-only entities). */
export const PUBLIC_CHANNEL_ENTITY_KINDS: ReadonlySet<YouTubeEntityKind> = new Set<YouTubeEntityKind>(
  YOUTUBE_CHANNEL_ENTITIES.filter((entity) => !entity.ownerOnly).map((entity) => entity.kind),
);

/** kind → per-channel config lookup, for dispatch. */
export const YOUTUBE_CHANNEL_ENTITY_BY_KIND: ReadonlyMap<YouTubeEntityKind, YouTubeChannelEntityConfig> = new Map(
  YOUTUBE_CHANNEL_ENTITIES.map((entity) => [entity.kind, entity]),
);

/** kind → reference config lookup, for dispatch. */
export const YOUTUBE_REFERENCE_ENTITY_BY_KIND: ReadonlyMap<YouTubeEntityKind, YouTubeReferenceEntityConfig> = new Map(
  YOUTUBE_REFERENCE_ENTITIES.map((entity) => [entity.kind, entity]),
);

/** Folder name the reference tables group under (their `basePath` and table-picker parent path). */
export const YOUTUBE_REFERENCE_PARENT_PATH = 'Reference';

/** Disabled-write reason shown in the table picker for additional (public) channels. */
export const PUBLIC_CHANNEL_WRITES_DISABLED_REASON =
  'This is an additional public channel you do not own — it is read-only. To edit a channel you own, connect it separately and pick it on Google’s consent screen.';

/** The `wsId` for a per-channel table: `"<kind>_<channelId>"`. */
export function channelTableWsId(kind: YouTubeEntityKind, channelId: string): string {
  return `${kind}_${channelId}`;
}

/**
 * The single top-level table that aggregates every channel involved in the
 * connection — the owned channel plus any additional public channels — one row
 * per channel. Replaces the old per-channel one-row `Channel` table.
 */
export const CHANNELS_TABLE_WS_ID = 'channels';
export const CHANNELS_TABLE_DISPLAY_NAME = 'Channels';

/**
 * The FK target id (`linkedTableId`) that the Videos/Playlists/etc. tables point
 * `snippet.channelId` at: the single top-level Channels table. Each Channels row's
 * `id` is the channelId, so the foreign key resolves a record to its owning channel.
 */
export function channelsTableLinkId(): string {
  return CHANNELS_TABLE_WS_ID;
}
