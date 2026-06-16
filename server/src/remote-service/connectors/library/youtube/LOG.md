# YouTube connector — activity log

Append-only, plain-language journal of operations performed. STATE.md = what's covered; this = what was done, in order.

## 2026-06-15 — revival: implement pull + transcript + additional-channels (DEV-10299)

Investigation:
[18:05:00] [Research] Cold-read connector + api-client + json-schema + oauth provider; confirmed `pullRecordFiles` was a no-op stub and create/delete throw.
[18:08:00] [Research] Located OAuth creds read-only via gcloud: test env uses client `111544850301-…` (registered in GCP project wsv1-test), secret in `spv1eu-test` Secret Manager; prod uses `287412075573-…` in wsv1-production. REDIRECT_URI is a plain env (`https://<client_domain>/oauth/callback`), not a secret.

Implement core pull + transcript:
[18:14:00] [Research] Implemented real `pullRecordFiles` (walk uploads playlist, page-token checkpoint, verbatim videos.list records) and `pullRecordFilesByIds`; deleted stale commented-out SDK-era helpers — youtube-connector.ts.
[18:15:00] [Research] Added `includeTranscript` advanced-setting (deep-fetch, GHL `includeNotes` pattern) + `attachTranscript`; added `transcript`/`transcriptId` to the schema — youtube-connector.ts, youtube-json-schema.ts.
[18:16:00] [Research] Added `contentDetails` to videos.list `part` (duration/definition/caption columns were always empty) + updated the 2 part-array test assertions — youtube-api-client.ts, __tests__/youtube-api-client.spec.ts.
[18:17:00] [Research] `updateRecords` now merges the persisted snippet onto the stored file (keeps statistics/status/contentDetails/transcript through the publish round-trip).

Wire additional-channels into the connect form:
[18:18:00] [Research] Added `youtubeAdditionalChannels` to `oauthInitiateOptionsSchema` + both OAuthStatePayload mirrors; threaded through `initiateOAuth`→state→`createOAuthAccount`; persists parsed channel-id list to `extras.additionalChannels`. Added `YouTubeConnectorExtras` + guard + `parseYouTubeAdditionalChannels` in shared-types. Added `credentialFields.{oauth,oauth_custom}` on the connector.

Verify:
[18:20:00] [Scratch CLI] Server typecheck: 0 errors. Server lint + shared-types lint: pass. Client tsc: clean.
[18:21:00] [Scratch CLI] `yarn --cwd server test src/remote-service/connectors/library/youtube` → 22 pass; `src/oauth` → 6 pass.

Local OAuth setup:
[18:22:00] [Manual Edits] Copied main checkout `server/.env` → worktree `server/.env` — local now uses the **test** OAuth client (`111544850301-…`) with `REDIRECT_URI=http://localhost:3000/oauth/callback` (already registered on that client). No GCP write or secret exposure needed.

Pre-pull fixes + parallel session + live pull verification:
[19:40:00] [Manual Edits] Lowered `maxResults` 100→50 on channels.list/playlistItems.list (YouTube doc max is 50) + flipped `metadata.visible` true (local TEMP) — youtube-api-client.ts, youtube-connector.ts. Tests still 22 pass.
[19:48:00] [Manual Edits] Diagnosed "0 videos / crash": the `:3010` server was the MAIN checkout (cwd /Users/ijd/repos/spinner/server, old no-op stub). Stopped it + watcher; later restored main on :3010.
[19:54:00] [Manual Edits] Wrote `.claude/skills/start-parallel-session/start-parallel-session.sh` (auto-pick N, start Redis 6379+N + monolith server 3010+N, print ports) and referenced it from the skill. Ran it → N=1, Redis `spinner-redis-1` :6380, worktree server `http://localhost:3011` (new connector code, own worker).
[19:57:00] [Scratch CLI] Cloned YT workspace from :3011 and pulled the channel folder on the new code — `linked pull dfd_pN0OpgZYal --mode full` (--scratch-url http://localhost:3011).
[19:57:30] [Scratch CLI] ✅ 2 videos fetched verbatim (internal-linking-part-2.json, notion-to-airtable.json); top-level keys kind/etag/id/snippet/contentDetails/status/statistics — Milestone 3 (first fetch) confirmed.

Multi-entity expansion (channel = path segment + all entity tables):
[21:30:00] [Research] Implemented via subagent against DESIGN.md: youtube-entities.ts registry; rewrote connector for kind-dispatch on remoteId[0]; added api-client list/CRUD methods + per-entity json-schema builders; includeComments deep-fetch. Reviewed diff (~1960 lines). Independently re-ran: typecheck 0 errors, lint pass (--max-warnings=0), 59 tests pass (3 suites).
[21:45:00] [Scratch CLI] Linked + READ-pulled all 11 tables via :3011 into /tmp/yt-verify/YT. Counts: Videos 2, Playlists 1, PlaylistItems 1, Channel 1, ChannelSections 0, Subscriptions 0, Members 0 (403 graceful-degrade), MembershipsLevels 0 (403), videoCategories 34, i18nLanguages 83, i18nRegions 111.
[21:48:00] [Scratch CLI] Verified records verbatim + correct: new paths /{conn}/{channel}/Videos|Playlists|Channel/… and /Reference/…; Playlist `snippet.channelId`→Channel FK present; Channel 1-row carries snippet/statistics/brandingSettings (full-parts fetch). Milestone 4 (all entities fetched) confirmed.
[21:49:00] [Research] CLI gotcha: `linked add --table-id` is repeatable to supply each remoteId SEGMENT of ONE table (server matches by remoteId.join(',')); don't comma-join. Also: link auto-download may under-populate — an explicit `linked pull --mode full` is needed (i18nRegions showed 0 then 111).

## 2026-06-16 — worktree-setup fix + per-channel `Channel` → top-level `Channels` table refactor (DEV-10299)

Re-test setup:
[16:13:00] [Manual Edits] After rebasing onto master, the worktree server failed to compile (132 TS errors — sync-draft/migration-lock/schema-builder). Root cause: stale generated state, NOT YouTube code. Fixed with `yarn --cwd server generate` (Prisma client) + `yarn build --filter=@spinner/shared-types` (rebuilt dist for new master exports). The default `:3010` is the MAIN checkout (old stub); new code needs the parallel session.
[16:35:00] [Scratch CLI] Brought up parallel session (auto-picked N=2 → server `:3012`, Redis `spinner-redis-2` :6381). Cloned wkb_I275JxSDYu, pulled Videos (2, verbatim incl. contentDetails/statistics), Channel (1), Playlists (1). References were empty only because they hadn't been pulled — explicit `linked pull` → Video Categories 32, i18n Languages 83, i18n Regions 111. Confirms the user's "pull failed" = pulling against the old-code `:3010`.

Refactor (user request: "remove the Channel folder — 1-row folders break the general logic; fetch all involved channels into a top-level Channels folder"):
[16:38:00] [Research] Removed the per-channel `channel` entity kind; added a single top-level **Channels** table (`wsId: channels`, `remoteId: ['channels']`, `basePath: []`) that aggregates the owned channel (`mine=true` → id) + every additional public channel, one row each (row id = channelId). Repointed every `snippet.channelId` FK from `channel_<id>` to the single `channels` table (`channelTableLinkId(channelId)` → `channelsTableLinkId()`). Owned-channel UPDATE preserved: the table allows update; public rows are rejected at write time in `updateRecords` (surface-failures principle). Files: youtube-entities.ts, youtube-connector.ts, youtube-json-schema.ts, youtube-api-client.ts (+ tests).
[16:40:00] [Research] Caught + fixed a fidelity regression: first cut used snippet-only `getChannels`/`getChannelsByIds`, dropping statistics/brandingSettings/status/contentDetails. Added `getChannelsByIdsWithFullParts` and made `pullChannels` re-fetch every channel with CHANNEL_FULL_PARTS (matches the old per-channel table). typecheck 0, lint clean, 60 tests pass.
[16:41:00] [Scratch CLI] Verified LIVE on `:3012`: `linked available` shows `Channels (ID: channels)` top-level and NO per-channel Channel table; pulled → `/YouTube/Channels/ivan-dimitrov-whalesync.json`, row id = UC9C9d6HqFq5_MQfH83ELRlQ (= the FK target), full parts present (snippet/contentDetails/statistics/status/brandingSettings). Single owned row for now; awaiting a SMALL public channel id (Veritasium deferred — too large, would burn quota) to verify a 2-row owned+public Channels table.

Additional public channel + write round-trip:
[17:05:00] [Manual Edits] Added additional public channel `UCdz6hKlUBsaC5em6b4NDK9A` ("Scratch Content", 4 subs) to `coa_MQ0qrVTXPj` via a local-DB write — `UPDATE "ConnectorAccount" SET extras='{"additionalChannels":["UCdz6hKlUBsaC5em6b4NDK9A"]}'::jsonb` in DB `scratch` (no CLI exists to edit an existing connection's channel list). `linked available` then showed the public channel's read-only tables (Videos/Playlists/PlaylistItems/ChannelSections, all "creates not supported"; owner-only Subscriptions/Members excluded).
[17:08:00] [Scratch CLI] Channels table now 2 rows (owned `Ivan Dimitrov Whalesync` + public `Scratch Content`), both full-parts. Pulled the public channel's Videos = 8 records under `/YouTube/Scratch Content/Videos/`; its Playlists/PlaylistItems/ChannelSections pulled = 0 (none on that channel) — empties handled gracefully. 1-private/1-public structure confirmed.
[17:20:00] [Scratch CLI] **WRITE ROUND-TRIP (Milestone 5, partial):** edited `notion-to-airtable.json` snippet.title → `files accept` → `linked publish dfd_21iZRv8qOV` → "Publish completed". Verified by a FRESH `linked pull --mode full` (re-fetch from YouTube, not the local file): title changed live; categoryId 22 preserved (the feared categoryId-required 400 did NOT occur — the publish path supplies the full snippet). Reverted title back to "Notion to Airtable" + re-published + re-verified (non-destructive). `cliCanPublish` was already true for ivan@whalesync.com.

Playlist create + add-video + delete (user request, all verified live):
[17:40:00] [Scratch CLI] **Playlist CREATE.** Wrote a new `scratch-test-playlist.json` (snippet.title + status.privacyStatus) → `files accept`. First attempts published with **create phase = 0 entries**; root cause = the missing **`files upload`** step (creates need accept→**upload**→publish; `linked publish` alone does not push new files to the server's dirty branch — only the git diff dirty-vs-main feeds the create phase). After `files upload`, create phase = 1 → fresh re-pull shows the new playlist with real id `PLe_IgJrKX4b0`.
[17:45:00] [Scratch CLI] **Add video = PlaylistItem CREATE.** New item with `snippet.playlistId=PLe_IgJrKX4b0` + `snippet.resourceId={kind:youtube#video,videoId:P_0d1rjqlQs}` (+ `contentDetails.videoId`) → accept→upload→publish → real item id on YouTube. NOTE: the editable schema field is `contentDetails.videoId` but the API needs `snippet.resourceId.videoId`; it only worked because I set `resourceId` directly. Connector-improvement candidate: map `contentDetails.videoId`→`snippet.resourceId` in `createPlaylistItem`.
[17:50:00] [Scratch CLI] **Playlist DELETE** (cleanup): re-cloned fresh, `rm` the playlist file → accept-all→upload→publish → delete phase = 1 → fresh re-pull shows only `Internal` remains. Channel left clean.
[17:52:00] [Gotchas] (1) `DataFolder.lock` gets STUCK ('pull') after an interrupted op and blocks publish with "Linked table … is currently locked by another pull operation" → clear with `UPDATE "DataFolder" SET lock=NULL WHERE id=…`. (2) Re-pulling between operations leaves stale accepted-patches that fail to re-apply ("failed to apply accepted Update patch") — cleanest is a fresh `workspaces init --force` per write op. (3) The orphaned old per-channel `Channel` linked table (`dfd_xDTuw7n8l1`) threw "unknown entity kind 'channel'" during publish schema-refresh until removed via `linked remove --yes`.
