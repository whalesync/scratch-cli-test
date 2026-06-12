# Connecting CompanyCam to Scratch — what to expect

CompanyCam works with Scratch's generic API connector (read-only). Here's the short version.

## Getting your API key
In CompanyCam: click your **profile menu → Access Tokens** (`https://app.companycam.com/access_tokens`) → **+ New Token** → leave "read only" unchecked → **Create Token**, then copy it. You need an **Admin** role; it's available on all plans. That token is long-lived — paste it into Scratch when adding the connection. (Use this personal Access Token, not the OAuth option.)

## What you can pull ✅
Each of these is a table you can add and pull: **Projects, Photos, Users, Groups, Tags, Videos, Webhooks, Checklists.**

Everything comes back exactly as CompanyCam's API returns it. Pulls page through all records automatically, and re-pulling is safe.

## Paste-ready setup config
When adding the connection in Scratch, pick **REST**, enter your Access Token, and paste this as the endpoints config. Each entry is one table; rename or delete any you don't want, and the page size (`per_page=100`) is fine as-is.

```json
{
  "authHeader": "Bearer",
  "endpoints": [
    { "name": "Projects",   "method": "GET", "url": "https://api.companycam.com/v2/projects?page=1&per_page=100" },
    { "name": "Photos",     "method": "GET", "url": "https://api.companycam.com/v2/photos?page=1&per_page=100" },
    { "name": "Users",      "method": "GET", "url": "https://api.companycam.com/v2/users?page=1&per_page=100" },
    { "name": "Groups",     "method": "GET", "url": "https://api.companycam.com/v2/groups?page=1&per_page=100" },
    { "name": "Tags",       "method": "GET", "url": "https://api.companycam.com/v2/tags?page=1&per_page=100" },
    { "name": "Videos",     "method": "GET", "url": "https://api.companycam.com/v2/videos?page=1&per_page=100" },
    { "name": "Webhooks",   "method": "GET", "url": "https://api.companycam.com/v2/webhooks?page=1&per_page=100" },
    { "name": "Checklists", "method": "GET", "url": "https://api.companycam.com/v2/checklists?page=1&per_page=100" }
  ]
}
```

No extra options are needed for CompanyCam — Scratch auto-detects the paging. (If you ever connect an API that pages differently, each endpoint can take an optional `"overrides"` block, but you don't need one here.) Checklist Templates is intentionally left out — see below.

## What you can't pull ❌
- **Checklist Templates** — CompanyCam doesn't expose this one to API tokens (the request bounces to a login page), so it can't be synced. Everything else above works with the same token.
- **Per-project / per-photo lists** (a project's comments, documents, labels, photos; a photo's tags) — these aren't standalone tables, because CompanyCam requires the specific project/photo ID in the address. If you need one of these, we can add it as its own table pinned to a single project (e.g. "Comments for Project X"); it just can't be one table that spans every project.

## Gotchas
- **Empty tables show no fields until they have data.** Scratch learns a table's columns from the records it sees. If you add, say, **Photos** while you have zero photos, it'll come in blank — add a photo in CompanyCam, then re-pull (or re-scan the table) and the columns appear.
- **No links between tables.** A Checklist record carries its `project_id` as a plain value; Scratch won't turn that into a clickable link to the Project. The IDs are all there if you need to match them up yourself.
- **Read-only.** This connector pulls from CompanyCam into Scratch; it does not push changes back.
