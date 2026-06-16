# YouTube → Scratch connector model — mapping & assumption review

Design analysis (DEV-10299, 2026-06-15). Grounded in two audits: (1) the Scratch connector model's expressive surface (codebase), (2) YouTube's full API surface + access constraints (official Google docs). Purpose: map YouTube onto our model and **challenge the v1 assumptions** we shipped this session. Companion to STATE.md (current coverage) and PLAN.md (actionable items).

## TL;DR — recommended target model

- **A connection = ONE authorized channel identity** (owner-scoped: full read/write) **+ optional additional channels by ID** (public data only, read-only). Multiple *owned* brand channels ⇒ one connection each (YouTube pins the OAuth token to the channel picked at consent; there is no channel switch on owner calls).
- **Channel = a structural PATH SEGMENT, not a table.** `basePath = [channelTitle]`. Under each channel sit *several* entity tables, each `remoteId: [kind, channelId, …]` (the ClickUp pattern).
- **Per-channel tables** (owned channel = writable where noted; additional public channels = read-only subset): **Videos**, **Playlists**, **PlaylistItems**, **ChannelSections**, **Subscriptions**, **Comments**, a 1-row **Channel** metadata table, owner-only **Members**/**MembershipsLevels**. Plus **Captions** as a *gated* per-video deep-fetch (quota — see below), ideally multi-language. Reference tables: **videoCategories**, **i18nLanguages/Regions**.
- Paths become `/{channel}/Videos/{video}.json`, `/{channel}/Playlists/{playlist}.json`, etc.
- **Incremental:** full-pull baseline; the real upgrade path is **WebSub/PubSubHubbub push** for new+updated uploads (not `search.list`).

## Object → model-slot mapping

| YouTube object | Model slot | Scope | CRUD we'd support | Notes |
|---|---|---|---|---|
| Channel (the authorized one) | structural path segment **+** 1-row table | owner | update (brandingSettings/status/localizations) | `mine=true` returns only this identity |
| Additional channels (by id) | structural path segments | public | read-only | public field subset only — no private videos/captions/analytics |
| Videos | table (records) | owner RW / public RO | update, delete (no create — upload needs media bytes) | verbatim `videos.list`; owner-only parts fileDetails/processingDetails/suggestions |
| Playlists | table | owner RW / public RO | create/update/delete | FK `channelId` |
| PlaylistItems | table | owner RW | create/update/delete + **re-parent** | **the real FK-write test** (move a video between playlists); FK `playlistId`+`videoId` |
| Captions | gated deep-fetch on Video (multi-lang) or opt-in table | owner only | update/insert/delete track | **quota-heavy**: list=50u/video, download=200u/track — must stay opt-in |
| ChannelSections | table | owner RW / public RO | create/update/delete | |
| Comments / CommentThreads | table or deep-fetch on Video | public read; own moderate | reply/update/delete/moderate | huge volume → gate or per-video |
| Subscriptions | table | owner (`mine`) | insert/delete | other users' lists usually private |
| Members / MembershipsLevels | table | owner only | read-only | only if memberships enabled; `members.list mode=updates` is a true delta |
| Analytics / Reporting | (special / out of scope v2) | owner only | read-only | async CSV (Reporting API) — different paradigm |
| Live (broadcasts/streams/superChat) | tables | owner | varies | niche → defer |
| videoCategories, i18n* | reference tables | public | read-only | |

## Assumption-by-assumption challenge (what we shipped vs. what the data says)

1. **"Channel = table."** → **CHANGE.** A connection can see several channels and each channel has *many* entity types. The model's idiom for that (audit §1–2) is a **structural segment** (`basePath=[channel]`) with entity **tables** underneath keyed by `remoteId:[kind,channelId,…]`. Today's "channel = the videos table" works only because videos are the sole entity; it doesn't scale to playlists/comments/etc. Restructure to channel-as-segment + a **Videos** table.
2. **"Video = record (verbatim)."** → **KEEP.** Confirmed correct; raw `videos.list` round-trips. (Add owner-only parts for the owned channel later; fix `status.*` edits — PLAN #2.)
3. **"Transcript = one English string, deep-fetched."** → **IMPROVE.** A video has *multiple* caption tracks across *languages* (asr vs standard, draft/serving). Flattening to one English string is lossy and can't round-trip other languages. Two better options: (a) **multi-language keyed object** `captions: { en: "…srt…", de: "…" }` so each language is an editable column (the array→keyed-object idiom, audit §4) — keep it a *gated* deep-fetch; or (b) a full **Captions table** (one row per track, full CRUD). **Recommend (a)** — (b) would re-list captions for every video on every pull and is quota-catastrophic.
4. **"additionalChannels = a login-form text field → extras."** → **KEEP, but relabel & scope.** It's correct for *public, read-only* channels reached by id. It does **not** give write/private access to *owned brand* channels — those need a **separate OAuth connection each**. Relabel the field "additional public channels (read-only)". (This also *forces* assumption #1: multiple channels per connection ⇒ channel must be a path segment.)
5. **"FK `snippet.channelId` → channel, read-only."** → **KEEP** (a video can't move channels). But our FK-write path (connector-build Stage D) currently has **nothing to test**. Adding **PlaylistItems** gives a genuine writable re-parent (move a video between playlists) — worth it for coverage alone.
6. **"No incremental."** → **KEEP for now, but there IS a better path.** No content resource has a changed-since filter (`search.list publishedAfter` = *creation* time, costs 100u, ~500 cap). The real upgrade is **WebSub/PubSubHubbub** (`pubsubhubbub.appspot.com` → `youtube.com/feeds/videos.xml?channel_id=…`): near-real-time pings on **new + updated** uploads (not deletes). `members.list mode=updates` is a true membership delta. Document WebSub as the incremental story; deletions still need full-list diffing.
7. **"create & delete throw."** → **SPLIT.** Video **create** is correctly unsupported (it's a resumable *media* upload, not a JSON write). Video **delete** *is* supported by the API (50u) and is a real "publish a deletion" op — implement it (destructive — PLAN #3). Playlists/PlaylistItems/ChannelSections/Comments/Captions all have real CRUD that arrives with those tables.
8. **"Only videos are exposed."** → **EXPAND (biggest opportunity).** Per the product's "sync everything possible" goal, we're leaving most of the surface on the table. Priority order: **Playlists + PlaylistItems** (writable, real FK), **Channel metadata** (editable branding/status), **ChannelSections**, **Subscriptions**, **Comments** (gated), **Members** (owner RO). See mapping table.
9. **"Path = /{connection}/{channelTitle}/{video}.json."** → **CHANGE** to nest entity-type folders under the channel: `/{channel}/Videos/{video}.json`, `/{channel}/Playlists/{playlist}.json`. Do it via `basePath` from the start (retrofitting churns every record's location — audit §1).

## Cross-cutting realities (constrain the design)

- **Quota = 10k units/day, shared project-wide.** Our pull chain is cheap (channels/playlistItems/videos list = 1u each); `search.list` is **100u** — keep avoiding it. Captions are the expensive part (list 50u/video, download 200u/track) → transcripts MUST stay opt-in and lazy. (Validates the gated `includeTranscript` checkbox.)
- **`maxResults` max = 50** (members: 1000). Confirms this session's 100→50 fix.
- **One connection = one channel identity.** Multi-brand-channel = multi-connection; surface this in UX.
- **Ship blocker: Testing-mode refresh tokens expire after 7 days**, and `youtube.force-ssl` is a *sensitive* scope → background sync breaks weekly until the app passes **Google sensitive-scope verification** and goes "In production." This is the gating item for any real release (STATE.md OAuth section).
- **Owned vs public asymmetry is structural:** tables under the owned channel are writable + see private data; the same tables under an additional (public) channel are read-only and field-limited. The connector must mark writes disabled per-table when the channel isn't owned (`TablePreview.disabledCreates/Updates/Deletes`).

## Recommended next steps (for review)
1. Restructure to **channel-as-structural-segment + Videos table** (assumptions 1 & 9) — foundational; do before adding entities.
2. Add **Playlists + PlaylistItems** (writable, gives the FK-move test).
3. Improve transcript to **multi-language keyed object** (assumption 3), still gated.
4. Implement **video delete** (assumption 7 / PLAN #3) + **`status.*` on update** (PLAN #2).
5. Then breadth: Channel metadata, ChannelSections, Subscriptions, Comments (gated), Members.
6. Longer-term: **WebSub** incremental; Analytics/Reporting as a special read-only surface.
