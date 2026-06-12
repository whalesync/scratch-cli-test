# Connecting Quo (formerly OpenPhone) to Scratch — what to expect

Quo works with Scratch's generic API connector (read-only). Here's the short version.

## Getting your API key
In the Quo/OpenPhone app: **Settings → API** → generate an **API key**. You need to be a workspace **owner/admin**, and the API is available on paid plans. Paste the key into Scratch when adding the connection.

**Auth note:** Quo sends the key **raw** — `Authorization: <key>`, with **no** "Bearer" in front. Pick the **raw** auth option in Scratch (not Bearer).

## What you can pull ✅
Each is a table you can add and pull: **Phone Numbers, Users, Contacts, Conversations, Webhooks, Contact Custom Fields.** Records come back exactly as Quo's API returns them, paging through automatically.

## Paste-ready setup config
When adding the connection in Scratch, pick **REST**, choose **raw** auth, enter your API key, and paste this. The `overrides` block on each entry is **required** — Quo's paging uses `pageToken`/`nextPageToken`, which Scratch won't auto-detect, so leave the overrides in.

```json
{
  "authHeader": "raw",
  "endpoints": [
    { "name": "Phone Numbers",        "method": "GET", "url": "https://api.openphone.com/v1/phone-numbers",       "overrides": { "paginationType": "cursor", "request": { "cursorParam": "pageToken", "limitParam": "maxResults", "maxPageSize": 50 }, "response": { "cursorPath": "nextPageToken", "dataPath": "data" } } },
    { "name": "Users",               "method": "GET", "url": "https://api.openphone.com/v1/users",                "overrides": { "paginationType": "cursor", "request": { "cursorParam": "pageToken", "limitParam": "maxResults", "maxPageSize": 50 }, "response": { "cursorPath": "nextPageToken", "dataPath": "data" } } },
    { "name": "Contacts",            "method": "GET", "url": "https://api.openphone.com/v1/contacts",             "overrides": { "paginationType": "cursor", "request": { "cursorParam": "pageToken", "limitParam": "maxResults", "maxPageSize": 50 }, "response": { "cursorPath": "nextPageToken", "dataPath": "data" } } },
    { "name": "Conversations",       "method": "GET", "url": "https://api.openphone.com/v1/conversations",        "overrides": { "paginationType": "cursor", "request": { "cursorParam": "pageToken", "limitParam": "maxResults", "maxPageSize": 50 }, "response": { "cursorPath": "nextPageToken", "dataPath": "data" } } },
    { "name": "Webhooks",            "method": "GET", "url": "https://api.openphone.com/v1/webhooks",             "overrides": { "paginationType": "cursor", "request": { "cursorParam": "pageToken", "limitParam": "maxResults", "maxPageSize": 50 }, "response": { "cursorPath": "nextPageToken", "dataPath": "data" } } },
    { "name": "ContactCustomFields", "method": "GET", "url": "https://api.openphone.com/v1/contact-custom-fields", "overrides": { "paginationType": "cursor", "request": { "cursorParam": "pageToken", "limitParam": "maxResults", "maxPageSize": 50 }, "response": { "cursorPath": "nextPageToken", "dataPath": "data" } } }
  ]
}
```

## What you can't pull ❌
- **Messages and Calls as full tables** — Quo won't return them unless you tell it *which* phone number and *which* contact, so there's no single "all messages" / "all calls" table.
  - **But one conversation can be its own table.** If you want, say, your full message history with a specific person (even 1,000+ messages), we pin that phone number + contact into the table's URL and it pulls the **entire** thread, paging through all of it. You just get one table per person rather than one big table for everyone.
- **Call recordings / summaries / transcripts** — each lives under a specific call ID, so they can't be listed as a table.

## Gotchas
- **Empty tables show no columns until they have data.** Add a record in Quo, then re-pull (or re-scan the table) and the columns appear.
- **No links between tables.** A Conversation stores its `phoneNumberId` as a plain value; Scratch won't turn it into a clickable link. The IDs are there if you need to match them up.
- **Read-only.** This connector pulls from Quo into Scratch; it does not push changes back.
