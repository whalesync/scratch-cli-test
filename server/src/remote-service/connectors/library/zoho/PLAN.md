<!-- Maintained by /connector-build. Active, atomic plans for the Zoho CRM connector.
     Each item carries a status: APPROVED (cleared to execute) or FOR_REVIEW (needs human sign-off).
     When an item ships, append it to ARCHIVE.md and delete it from here so this file stays short. -->

# Zoho CRM — Connector Plans (active)

## Make the Zoho `Tag` field writable — `APPROVED`

**Problem.** `Tag` round-trips on **read** as a `[{name, id}]` array, but Zoho does **not** accept it through the standard create/update record API — including it makes Zoho reject the **whole** record. As a stopgap it is currently marked **read-only** (`isReadonlyZohoField` → `READONLY_FIELD_API_NAMES` in `zoho-json-schema.ts`), so Tag edits are blocked in the grid and excluded from publish. This item removes that gate and makes Tag genuinely writable via Zoho's dedicated tag-action endpoints.

**Fix sketch.** In the write path, diff the record's current vs. published tag set and apply the delta through the actions API instead of the record body — `POST /crm/v2/{module}/actions/add_tags?ids={id}&tag_names={name}` and `…/remove_tags` — creating tags first if Zoho requires. Then drop `Tag` from `READONLY_FIELD_API_NAMES`. Touches: `zoho-api-client.ts` (`addTags`/`removeTags`), `zoho-connector.ts` (route Tag in the write path; fetch current tags for the diff), `zoho-json-schema.ts` (remove the gate), tests.

**Here is what happens now:**

- Record file: `"Tag": [{ "name": "VIP", "id": "…" }]`. User adds `"hot-lead"`.
- Publish sends the whole record (Tag included) to `PUT /crm/v2/Leads`:
  ```json
  { "code": "INVALID_DATA", "details": { "api_name": "Tag" }, "status": "error" }
  ```
  → the entire record write fails. *(With the current read-only stopgap, the Tag edit is instead silently not published.)*

**Here is what will happen after the fix:**

- Publish splits the diff — writable fields go in the `PUT` body as today; the Tag delta goes to the actions API:
  ```
  POST /crm/v2/Leads/actions/add_tags?ids=555&tag_names=hot-lead   →   { "code": "SUCCESS" }
  ```
- Read back: `"Tag": [{ "name": "VIP", … }, { "name": "hot-lead", … }]`.
