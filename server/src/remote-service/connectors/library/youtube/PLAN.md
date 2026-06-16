# YouTube connector — active plans

Atomic, concise plan items for substantial changes. Each is `APPROVED` (work freely) or `FOR_REVIEW` (await human OK). Small fixes are applied directly with no entry. Ship → move to ARCHIVE.md.

---

## 1. `maxResults` cap on list calls — `APPLIED` 2026-06-15 (confirm on live pull)

`channels.list` (×2) and `playlistItems.list` passed `maxResults: 100`, but YouTube documents the max as **50** — likely a 400 on the first call (which would break even `testConnection`). **Lowered all three to 50** (`youtube-api-client.ts` + 3 test assertions). Pagination handles any video count regardless. Confirm a real multi-page channel pulls cleanly on the first live pull, then move this to ARCHIVE.md.

---

## 2. Send a `status` part on update — `FOR_REVIEW`

The schema marks `status.privacyStatus`/`license`/`embeddable` editable, but `updateRecords` only sends snippet fields, so those edits are **silently dropped** on publish (violates "surface failures; never silently succeed").

**Now:** editing `status.privacyStatus` from `public`→`unlisted` and publishing → no change in YouTube (only snippet is sent).
**After:** when `changedFields` includes a `status.*` field, send `part=snippet,status,id` with the `status` object so privacy/license/embeddable changes land. (Mind: `status` may need its full object, like snippet needs categoryId.)

---

## 3. Video delete — `DECIDED: WON'T IMPLEMENT` (maintainer call 2026-06-15)

The API supports `DELETE /videos?id=…`, but deleting a video is **destructive/irreversible**. Maintainer decision: **keep it unimplemented** — `deleteRecords` continues to throw. (Playlists/PlaylistItems/ChannelSections/Comments/Captions deletes are fine — those are reversible/re-creatable; only *video* delete is off.)

---

## 5. Restructure: channel = path segment + multi-entity tables — `FOR_REVIEW` (foundational)

Per [DESIGN.md](DESIGN.md) assumptions 1 & 9: today "channel = the videos table"; it doesn't scale to playlists/comments/etc. Move to **channel as a structural `basePath` segment** with entity **tables** underneath (`remoteId: [kind, channelId, …]`, the ClickUp pattern).

**Now:** `/{connection}/{channel}/{video}.json` — one table per channel, videos only.
**After:** `/{connection}/{channel}/Videos/{video}.json`, `…/Playlists/{playlist}.json`, … — channel is a folder level; each entity type is its own table. Do via `basePath` from the start (retrofitting churns every record's path). Owned channel = writable tables; additional (public) channels = read-only (`TablePreview.disabled*`).

## 6. Add Playlists + PlaylistItems tables — `FOR_REVIEW`

[DESIGN.md](DESIGN.md) assumptions 5 & 8. PlaylistItems is **writable** (add/remove/reorder/move a video between playlists) → the connector's first **real FK-write / re-parent** test (Stage D), which Videos' read-only `channelId` can't provide. FK `playlistItem.playlistId → Playlists`, `playlistItem.videoId → Videos`. All 50u/write.

## 7. Multi-language transcript (keyed object) — `DEFERRED` (maintainer call 2026-06-15)

v1 intentionally keeps a **single English transcript** (one source-of-truth, English-only). Future option: replace the single `transcript` string with `captions: { <lang>: "<srt>" }` (each language an editable column via the array→keyed-object idiom), still gated behind `includeTranscript`. Not in the current build — revisit if multi-language transcripts are needed.

## 4. Fetch uploads-playlist id once per pull — `APPROVED` (low priority)

`getVideos` re-runs `channels.list?part=contentDetails` on **every** page to re-derive the uploads playlist id (1 wasted unit/page). Split into `getUploadsPlaylistId(channelId)` (once) + a page-walker, so a multi-page pull spends 1 channels.list total instead of 1/page. Quota matters here (10k/day shared).
