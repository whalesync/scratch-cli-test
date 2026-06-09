<!-- Plain-language, append-only journal of every operation actually performed on
     the Zoho connector. STATE.md = what's covered; LOG.md = what was done, in order.
     One operation per line, tagged [Service UI] / [Service API] / [Scratch CLI] / [Manual Edits].
     Never write a real secret (mask tokens). -->

# Zoho CRM connector — activity log

## 2026-06-08 — /connector-build run (read + update + FK coverage via live-API spec)

Environment & enumeration:
[Service API] Minted an access token from the refresh token — POST https://accounts.zoho.com/oauth/v2/token (grant_type=refresh_token, client_id=1000.0…)
[Service API] Enumerated the full module surface — GET /crm/v8/settings/modules → 26 modules; 9 writable (Leads/Contacts/Accounts/Deals/Tasks/Events/Calls/Campaigns/Notes), rest read-only/excluded
[Service API] Profiled the field-type universe across writable modules — GET /crm/v8/settings/fields?module=<m> → text,textarea,email,website,phone,picklist,boolean,integer,bigint,double,currency,date,datetime,lookup,ownerlookup,multi_module_lookup,profileimage,ALARM,RRULE
[Service API] Sampled a Lead to learn value shapes — GET /crm/v8/Leads → picklist=literal label, Owner={id,name,email}, datetime carries org offset -07:00, id=string bigint
[Service UI] Confirmed the gstack browser is logged into Zoho CRM org 857392714 ("Whalesync Testing") — https://crm.zoho.com/crm/org857392714/tab/Home/begin

Custom-field seeding probe (edition gate):
[Service API] Tried to seed custom field types — POST /crm/v8/settings/fields?module={Leads,Contacts} for multiselectpicklist/percent/autonumber/formula → all 400 LIMIT_EXCEEDED (free edition caps these at 0)

Build harness:
[Scratch CLI] Built the scratchmd CLI — cd scratch-git-2 && cargo build --release --bin scratchmd (exit 0)
[Manual Edits] Built the shared-types workspace package (its dist/ was missing in this worktree, breaking all integration specs) — cd packages/shared-types && yarn build
[Manual Edits] Added Zoho creds to gitignored server/.env.integration — ZOHO_CLIENT_ID/SECRET/REFRESH_TOKEN/DATA_CENTER (sourced from ~/.zoho-scratch-test.json)
[Manual Edits] Wrote server/src/remote-service/connectors/library/zoho/STATE.md (coverage doc) + LOG.md (this file)
[Manual Edits] Wrote server/test/integration/zoho-connector.spec.ts (live-API integration spec)

Read-only coverage (live-API spec, all green):
[Scratch CLI] Ran the spec — cd server && yarn test:integration -- zoho-connector
[Service API] testConnection validates creds + rejects bad creds; listTables applies the eligibility policy (core writable modules present, api_supported=false excluded, read-only modules flagged); fetchJsonTableSpec builds schemas (id read-only, Modified_Time = last-modified, Owner FK→users); pullRecordFiles streams Leads full + incremental (fresh watermark)

Write coverage — discovered the storage cap, pivoted to non-destructive update:
[Service API] Minimal Lead create failed — POST /crm/v8/Leads → 400 MAX_LIMIT_REACHED (max_no_of_records 5000); GET /crm/v8/Accounts/actions/count → 25,094 (org is ~20k over the free cap → all creates blocked)
[Service API] Verified update works non-destructively — PUT /crm/v8/Leads {No_of_Employees:7777} then restored to null; emoji 🎯 in Description came back as '?' (Zoho utf8, service-side)
[Service API] Edit→Push field types via the connector's updateRecords — text/textarea/integer/boolean/picklist/currency round-trip on an existing Lead, then restored; null-clear round-trips
[Service API] FK both directions via updateRecords — read: existing Contact.Account_Name = {id,name}; write: repointed Account_Name to a different Account id ({id,name}→{id} reduction) and confirmed, then restored
[Manual Edits] Gated the create+delete suite behind ZOHO_ALLOW_CREATE=1 (ready for a green-field org under the cap)

Result: 15 passed / 1 gated (create+delete). Create/Delete blocked by the 5000-record storage cap; everything else confirmed.

## 2026-06-08 — green-field EU org provisioned → full CRUD confirmed

Provisioned a fresh org to beat the storage cap:
[Service UI] Signed out of the legacy org, signed up a new Zoho CRM account (user did signup + phone OTP) — ivan@whalesync.com, org 20115333801, EU data center
[Service UI] Created a Self Client + generated an auth code with CRM scopes — https://api-console.zoho.eu (Self Client → Generate Code, scopes ZohoCRM.modules.ALL,settings.ALL,users.ALL,org.READ,bulk.ALL)
[Service API] Exchanged the auth code for a refresh token — POST https://accounts.zoho.eu/oauth/v2/token (grant_type=authorization_code) → refresh_token + api_domain https://www.zohoapis.eu
[Manual Edits] Saved creds to ~/.zoho-scratch-test-2.json (chmod 600) and pointed server/.env.integration at the EU org (ZOHO_* + ZOHO_DATA_CENTER=EU + ZOHO_ALLOW_CREATE=1)
[Service API] Confirmed green-field — GET /crm/v8/users?type=CurrentUser (ivan@whalesync.com) + Leads/Contacts/Accounts/Deals count = 0

Full CRUD via the connector (live-API spec, ZOHO_ALLOW_CREATE=1, 14/14 passed):
[Service API] Leads create→read→update→null-clear→delete with every standard field type — createRecords/updateRecords/deleteRecords; emoji 🎯 confirmed replaced with '?' service-side
[Service API] Lookup FK both directions — created an Account, created a Contact with Account_Name={id} (name dropped on write, re-hydrated on read), Date_of_Birth date round-tripped, then deleted both
[Service API] Datetime/timezone fidelity — created an Event with Start/End_DateTime in UTC, read back in org offset, identical instant
[Manual Edits] Folded multi_module_lookup/ALARM/RRULE/multireminder into the schema switch's verbatim group (was hitting the default warn branch) — zoho-json-schema.ts

Result: 14/14 passed on the green-field org. Read + full CRUD + field types + FK + datetime/tz all confirmed against the live service.

## 2026-06-08 — Scratch workspace + Zoho token-management fix

(LOG timestamp convention adopted here; the two sections above predate it. Times before ~22:50 are best-effort.)

Created a Scratch workspace so the human can monitor records in the desktop app:
[19:40:32] [Scratch CLI] Created workspace "Zoho CRM" — scratchmd workspaces create "Zoho CRM" → wkb_K7rI94Db0y
[19:41:10] [Scratch CLI] Added Zoho EU connection, Health OK — scratchmd connections --workspace wkb_K7rI94Db0y add --service ZOHO --param zohoClientId=… --param zohoDataCenter=EU → coa_N9FksXhWpG
[19:42:30] [Service API] Seeded demo data (3 Leads, 1 Account, 1 Contact→Account, 1 Deal) in org 20115333801 — POST /crm/v8/{Leads,Accounts,Contacts,Deals}
[19:43:05] [Scratch CLI] Linked + pulled Leads + Contacts — scratchmd linked add/pull dfd_hPf7cY2rgp, dfd_yrLUwUpnMa (records landed)

Hit Zoho's token-generation throttle (per-operation token minting + many standalone probe mints):
[22:54:00] [Scratch CLI] Accounts/Deals pull + all further links failed — Server 500/400, "too many requests continuously"
[22:56:07] [Manual Edits] Started a 15-min quiet cooldown — no Zoho token requests

Fixed the root cause — shared the access token across throwaway connector instances:
[23:03:56] [Manual Edits] Replaced ZohoApiClient's instance-level token cache with a process-wide cache (keyed by hashed creds) + in-flight mint dedup — zoho-api-client.ts
[23:03:56] [Scratch CLI] Verified — yarn build + 21 unit tests + eslint clean (no live token used)

## 2026-06-08 — seed all entities + wire the Users table

Seeded every creatable entity (API-first, one token) so the reviewer has full visibility:
[23:28:14] [Service API] Seeded Products/Tasks/Events/Campaigns/Vendors/Price_Books/Cases/Solutions OK — POST /crm/v8/{module} (+ earlier Leads/Contacts/Accounts/Deals)
[23:28:14] [Service API] Caught entity-specific create requirements — Calls need Outgoing_Call_Status+Call_Start_Time+Call_Duration; Notes need a parent (POST /Accounts/{id}/Notes); inventory need named line-item subforms (Quoted_Items/Ordered_Items/Invoiced_Items/Purchase_Items)
[23:28:14] [Service UI] Seeded read-only Stage History via the gstack browser — changed the Northwind deal's stage Qualification→Value Proposition → DealHistory rows generated
[23:28:14] [Scratch CLI] Linked + pulled all 19 tables into wkb_K7rI94Db0y — linked add + pull-all + per-table pull --mode full (token-cache fix held; no throttle)

Wired the Users entity (was half-built: api-client listUsers() + ownerlookup FK existed, but no table):
[23:28:14] [Manual Edits] Added a synthetic read-only 'users' table — listTables() append + buildZohoUsersTableSpec() (curated schema, no /settings/fields) + pull via listUsers() — zoho-connector.ts, zoho-json-schema.ts
[23:28:14] [Scratch CLI] Verified — yarn build + 21 unit tests + eslint clean (needs server restart to expose, then link+pull 'users')
[23:32:01] [Scratch CLI] Server restarted → linked + pulled the 'users' table — scratchmd linked add/pull dfd_nZtwGThOP5 → Users/ivan-dimitrov.json (id 1001416000000545001, role CEO); 20 tables total; Owner FK now resolves

Foreign-key CLI move (milestone #6 — manual edit + CLI publish, the green-✅ standard):
[23:38:26] [Manual Edits] Re-parented Contact "Butt (Sample)" Benton→Chanay — edited Account_Name.id in "Zoho CRM (EU)/Contacts/butt-sample.json" (cloned wkb)
[23:38:26] [Scratch CLI] Pushed via the 3-step flow — scratchmd files accept "…/butt-sample.json" && files upload && files publish → Published 1 connection
[23:38:26] [Service API] Confirmed in Zoho — GET /Contacts/1001416000000554181 → Account_Name {name:"Chanay (Sample)", id:…093} ✅ re-parented
