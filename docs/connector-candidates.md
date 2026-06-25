# Connector candidates — research (2025-2026)

~50 services scored as targets for the `/connector-build` workflow. Researched in 4 parallel passes (CRM, Spreadsheet/DB, CMS, Task/Project), then merged + normalized.

**Score (1-10):** 10 = huge user base **+** a genuinely free-forever plan (not a trial) **+** an API that fits our model well (REST, paste-able API-key auth, schema introspection, full CRUD). Penalized for: small user base, trial-only / no free plan / card-required, OAuth-only auth (hard for the CLI), GraphQL-only, read-only or paywalled write API, exotic content models.

**Difficulty:** easy / medium / hard for integrating the API to our pull→edit→publish model.

**Built?** ✓ = a connector already exists in `server/src/remote-service/connectors/library/`. Blank = not yet built (these are the real targets).

| Service | Built? | ~Users | Type | Cost (plans) | Free account | Difficulty (reason) | Score | Test env vars |
|---|:--:|---|---|---|---|---|:--:|---|
| **HubSpot CRM** | ✓ | ~248k paying (1M+ free) | CRM | Free; Sales/Mktg Starter ~$15-20/seat, Pro ~$90-100, Ent higher | Free-forever (2 users, 1M contacts); no card | Medium — REST v3, paste-able private-app token (or OAuth), full CRUD, `/schemas`+`/properties` introspection | **9** | `CB_HUBSPOT_API_TOKEN` |
| **Airtable** | ✓ | ~166k paid cos, millions | Spreadsheet/DB | Free; Team $20, Business $45 /user/mo; Ent custom | Free-forever (1k records/base); no card | Easy — REST+JSON, PAT auth, schema meta API, CRUD+upsert | **9** | `CB_AIRTABLE_API_TOKEN` |
| **ClickUp** | | ~10M+ users / 800k teams | Task/Work | Free; Unlimited ~$7, Business ~$12 /user/mo; Ent custom | Free-forever (60-use custom-field cap); no card | Easy — REST, personal API token, custom fields, full CRUD | **9** | — |
| **Trello** | | ~50M+ users | Task/Kanban | Free; Standard ~$5, Premium ~$10, Ent ~$17.50 /user/mo | Free-forever (10 boards/workspace); no card | Easy — REST, API-key+token, Custom Fields, full CRUD | **9** | — |
| **Baserow** | | est. tens of thousands + self-host | Spreadsheet/DB (OSS) | Free; Cloud Premium $10, Advanced $20 /user/mo; self-host Premium $10 | Free-forever (cloud 3k rows) **+ self-host free**; no card | Easy — REST+JSON, non-expiring DB tokens, per-table CRUD, introspectable | **9** | — |
| **NocoDB** | | est. large (50k+ GH stars) | Spreadsheet/DB (OSS) | Free Forever; Plus $12, Business $24 /seat/mo | Free-forever (cloud 1k records) **+ self-host free**; no card | Easy — REST v2/v3 + meta API, 40-char token, full CRUD, introspectable | **9** | — |
| **Teable** | | est. growing (~20k GH stars) | Spreadsheet/DB (OSS, Postgres) | Free; Pro from $10/seat; self-host Community free | Free-forever (cloud) **+ self-host free**; no card | Easy — full REST per table, PAT (+OAuth), introspectable CRUD | **9** | — |
| **Jira** | | ~300k+ companies | Task/Issue | Free (≤10 users); Standard ~$7.91, Premium ~$14.54 /user/mo; Ent custom | Free-forever (≤10 users, 2GB); no card | Medium — rich REST, heavy custom-field/schema model, API-token auth | **8** | — |
| **Asana** | | ~3.2M paid / ~150k cos | Task/Work | Personal Free; Starter ~$10.99, Advanced ~$24.99 /user/mo; Ent custom | Free-forever (Personal ~2-10 seats); no card | Medium — REST+JSON; custom-field types limited (text/enum/number) | **8** | — |
| **WordPress** | ✓ | ~518M sites (~43% of web) | CMS | WP.org free; WP.com Free/$4/$8/$25/$45 /mo | Free-forever (WP.org open-source; WP.com free tier); no card | Medium — REST `/wp-json` full CRUD, no central schema introspection, draft/publish | **8** | — |
| **Zoho CRM** | | ~250k+ businesses | CRM | Free (3 users); Std $14, Pro $23, Ent $40, Ultimate $52 /user/mo | Free-forever (3 users, core CRM); no card | Medium — REST v8, OAuth-only (self-client tokens), full CRUD, Field Metadata introspection | **8** | `CB_ZOHO_OAUTH_CLIENT_ID` `CB_ZOHO_OAUTH_CLIENT_SECRET` `CB_ZOHO_OAUTH_REFRESH_TOKEN` `CB_ZOHO_DATA_CENTER` |
| **Webflow** | ✓ | ~300k+ orgs | CMS / site builder | Starter free; Site Basic $15, Premium $25; Ent custom | Free-with-limits (50 CMS items/site); no card | Medium — REST + paste-able site token, schema introspection, **draft/staged vs published** | **8** | — |
| **Todoist** | | ~30M+ users | Task/To-do | Free; Pro ~$4-5, Business ~$8 /user/mo | Free-forever (5 projects, 5 collaborators); no card | Easy — REST v2 + Sync, Bearer personal token, simple model | **8** | — |
| **Freshsales** | | ~65k businesses | CRM | Free; Growth $9-29, Pro $39-59, Ent $59-69 /user/mo | Free-forever (3 users); no card | Medium — REST, API-key, CRUD, settings/fields introspection | **8** | — |
| **Grist** | | est. small-mid (OSS) | Spreadsheet/DB (OSS) | Free; Pro/Team paid; self-host Community free | Free-forever (cloud) **+ self-host free**; no card | Easy — REST+JSON, per-user Bearer key, CRUD, introspectable | **8** | — |
| **Pipedrive** | ✓ | ~100k+ companies | CRM | Lite $14, Growth $39, Premium $49, Ultimate $79 /user/mo | Trial-only (14-day, no card); no free plan | Easy — REST, paste-able API token (+OAuth), full CRUD, field endpoints | **7** | `CB_PIPEDRIVE_API_TOKEN` |
| **Strapi** | | est. very large OSS | CMS (OSS + cloud) | Self-host free (MIT); Cloud Free/$29/$99/$499 | Free-forever (self-host) + Cloud free tier; no card | Medium — auto-gen REST + GraphQL, full CRUD, per-instance (user runs server) | **7** | — |
| **Ghost** | | est. hundreds of thousands | CMS / blog+newsletter | Self-host free; Pro Starter $15+ (member-tiered) | Self-host free-forever; Pro 14-day trial (no card) | Medium — REST Admin API (full CRUD), Admin-key auth, fixed schema, draft/publish | **7** | — |
| **Storyblok** | | est. large (Tesla/Adidas) | CMS (headless) | Free; ~$99-$349/mo; Ent custom | Free-forever (1 seat, Mgmt+Delivery APIs); no card | Medium — Management API (write) on free, REST+GraphQL, component schema, draft/published | **7** | — |
| **Prismic** | | est. mid | CMS (headless) | Free; Team $15, Medium ~$100/mo; Ent custom | Free-forever (unlimited docs, 4M calls); no card | Medium — REST (write via Document/Migration API), GraphQL read-only, slices, draft/publish | **7** | — |
| **Attio** | ✓ | ~5k paying | CRM | Free; Plus $29, Pro $69 /user/mo; Ent custom | Free-forever (3 users, 250 credits/mo, API on all plans); no card | Medium — REST, paste-able token (+OAuth), CRUD, attributes introspection, credit-metered | **7** | `CB_ATTIO_API_TOKEN` |
| **Capsule CRM** | | est. low tens of thousands | CRM | Free (2 users); Starter $18, Growth $36, Advanced $54, Ultimate $72 /user/mo | Free-forever (2 users, 250 contacts); no card | Easy — REST, paste-able token (+OAuth), CRUD, custom-field schema | **7** | — |
| **Shortcut** | | no solid count | Task/Issue | Free (≤10 users); Team ~$10, Business ~$16 /user/mo; Ent custom | Free-forever (≤10 users); no card | Easy — REST, API-token, custom fields, CRUD + webhooks | **7** | — |
| **Teamwork** | | est. ~20k+ customers | Task/Project | Free (5 users); Deliver ~$9-11, Grow ~$20-26 /user/mo; Scale/Ent custom | Free-forever (5 users, 2 custom fields); no card | Medium — REST v2+v3, custom fields gated on lower tiers | **7** | — |
| **SeaTable** | | est. small-mid | Spreadsheet/DB (OSS) | Free; Plus from €7/user; Ent; self-host | Free-forever (10k rows) **+ self-host free**; no card | Medium — REST+JSON, two-step API-token→base-token (3-day) quirk | **7** | — |
| **Notion** | ✓ | ~100M users / 4M paying | Database/docs | Free; Plus $10, Business $20 /user/mo; Ent custom | Free-forever (DBs ~capped free); no card | Hard — page content = per-record block trees, 3 req/s, OAuth/internal token | **6** | — |
| **Monday.com** | | ~225k customers | Task/Work OS | Free (2 seats); Basic ~$9, Std ~$12, Pro ~$19, Ent ~$24-30 /seat/mo | Free-forever (2 seats, 3 boards); no card | Hard — **GraphQL-only** API | **6** | — |
| **Linear** | ✓ | ~33k orgs / 14k+ paying | Task/Issue | Free; Basic ~$8, Business ~$14 /user/mo; Ent custom | Free-forever (limited issues); no card | Hard — **GraphQL-only** (no REST) | **6** | — |
| **Contentful** | | ~4,800 brands (est.) | CMS (headless) | Free; Lite/Basic ~$300/mo; Premium/Ent custom | Free-with-limits (1 space, 100k calls/mo); no card | Medium — REST+GraphQL, CMA write on free, read-only CDA vs write CMA split, draft/published | **6** | — |
| **DatoCMS** | | est. mid | CMS (headless) | Free dev; Professional from €199/mo; Ent custom | Free-with-limits (300 records, dev-only); no card | Medium — GraphQL delivery + REST/JSON:API mgmt (write), schema introspection, draft/published | **6** | — |
| **Coda** | | ~50k+ teams | Doc/Database | Free; Pro $10, Team $30 /Doc-Maker/mo; Ent custom | Free-forever (Maker billing); no card | Medium — REST+JSON bearer token, doc/table model awkward, rate-limited | **6** | — |
| **Wrike** | | ~1.68M users / 20k customers | Task/Project | Free; Team ~$10, Business ~$24.80 /user/mo; Pinnacle custom | Free-forever (heavy limits; no custom fields Free/Team); no card | Medium — REST, permanent token, custom fields gated to Business+ | **6** | — |
| **Close** | | est. tens of thousands | CRM | Solo $19, Essentials $49, Growth $109, Scale $149 /seat/mo | Trial-only (14-day, no card); no free plan | Easy — clean REST, paste-able API key (+OAuth), full CRUD, fields | **6** | — |
| **Salesforce** | | ~150k+ companies | CRM | Starter $25, Pro $100, Ent ~$165-175, Unlimited ~$330-350 /user/mo | Trial-only (30-day, no card); no free plan | Hard — OAuth-only, complex object model; rich REST + metadata introspection | **5** | — |
| **Google Sheets** | | ~3B Workspace users | Spreadsheet | Free w/ Google acct; Workspace from ~$7/user/mo | Free-forever (Google account); no card for API | Hard — OAuth-only (painful for CLI), cells not records, no field-type schema | **5** | — |
| **Copper** | ✓ | ~30k+ businesses | CRM | Starter $9, Basic $23, Pro $59, Business $99 /seat/mo | Trial-only (14-day, no card); no free plan | Medium — REST, API-key (token+email) or OAuth, CRUD; Workspace-centric | **5** | `CB_COPPER_API_TOKEN` `CB_COPPER_EMAIL` |
| **Insightly** | | est. ~25k+ businesses | CRM | Plus $29, Pro $49, Ent $99 /user/mo | Trial-only (free plan removed Oct 2024; 14-day, no card) | Easy — REST v3.1, HTTP Basic w/ paste-able API key, full CRUD | **5** | — |
| **Sanity** | | est. tens of thousands of projects | CMS (headless) | Free; Growth $15/seat (≤50); Ent custom | Free-forever (20 seats, 10k docs); no card | Hard — GROQ query language, mutations via API, no conventional REST CRUD, portable-text | **5** | — |
| **Hygraph** | | est. mid | CMS (headless, GraphQL) | Hobby free; Basic $49, Std $149, Pro $499 /project/mo; Ent custom | Free-forever (Hobby: 3 users, 1k records); no card | Hard — **GraphQL-only** (read+write mutations), Mgmt API for schema, stage-based publish | **5** | — |
| **ButterCMS** | | est. smaller (blog focus) | CMS (headless) | Free dev (non-commercial); Micro $99, Startup $199, SMB $399 | Free-with-limits (dev/non-commercial); no card | Medium — clean read API + Write API (**paid**), token auth, collections schema | **5** | — |
| **Stackby** | | est. small | Spreadsheet/DB | Free (≤5 users); Economy ~$149/yr, Business ~$299/yr; Ent | Free-forever (≤5 users); no card | Medium — REST+JSON API key, CRUD, smaller/less-documented introspection | **5** | — |
| **Rows** | | est. mid | Spreadsheet (AI) | Free; Plus/Pro $59-$499; Ent | Free-forever (60 req/min, 500 enrichment/mo); no card | Medium — REST+JSON token, read/write cells, spreadsheet-cell model (not records) | **5** | — |
| **Basecamp** | | ~75k companies / 3.3M active | Task/Project | Free (1 project); Plus ~$15/user/mo; Pro Unlimited ~$299/mo flat | Free-forever (1 project, 1GB); no card to start | Medium — REST+JSON but **OAuth-2-only**, no custom fields/schema introspection | **5** | — |
| **Folk** | | est. <100k users | CRM | Standard $24-30, Premium $48-60, Custom $80-100+ /user/mo | Trial-only (14-day, no card); **API gated to Premium** | Medium — REST but early-stage, API behind Premium, limited CRUD depth | **4** | — |
| **GoHighLevel** | ✓ | ~60-70k direct (1M+ downstream) | CRM | Starter $97, Unlimited $297, Agency Pro $497 /mo (flat) | Trial-only (14-30 day); no free plan | Hard — V2 OAuth-2 only, agency/sub-account model, opaque rate limits | **4** | `CB_GOHIGHLEVEL_LOGIN_EMAIL` `CB_GOHIGHLEVEL_PASSWORD` `CB_GOHIGHLEVEL_OAUTH_CLIENT_ID` `CB_GOHIGHLEVEL_OAUTH_CLIENT_SECRET` |
| **Wix** | ✓ | ~282M registered / ~272M sites | CMS / site builder | Free; Light $17-19, Core $27, Business $34, Elite $159 /mo | Free-forever (Wix subdomain + branding); no card | Hard — REST CMS/Data API but OAuth + headless/dev setup, draft/publish | **4** | — |
| **Keap** | | ~200k users | CRM | Single plan from $249/mo (2 users) + mandatory paid onboarding | Trial-only (14-day, no card); no free plan; pricey | Medium — REST (+legacy XML-RPC), OAuth 2.0, CRUD, older/quirkier API | **3** | — |
| **Smartsheet** | | ~80k+ brands | Spreadsheet/work | No free plan; Pro $9, Business $19-32 /user/mo; Ent custom | Trial-only (free plan killed Aug 2024; 30-day → read-only) | Medium — REST+JSON, OAuth 2.0, columns introspectable | **3** | — |
| **Squarespace** | | ~7M live sites / 4M paid | CMS / site builder | Basic $16, Core $23, Plus $39, Advanced $99 /mo; no free plan | Trial-only (14-day, no card) | Hard — Commerce API only (no general content/page write API), OAuth, paid plans | **2** | — |
| **Height** | | ⚠️ DEFUNCT | Task (shut down) | n/a | Shut down Sept 24, 2025; data deleted | n/a — service no longer exists | **1** | — |

## Start here (high score, NOT yet built)

The strongest new targets — large user base, real free-forever plan, clean REST + paste-able API key + introspectable schema + full CRUD:

- **ClickUp (9)**, **Trello (9)** — huge, easy, free-forever.
- **Baserow (9)**, **NocoDB (9)**, **Teable (9)** — open-source Airtable-likes; perfect dynamic-schema fit, self-host = free-forever, token auth.
- **Jira (8)**, **Asana (8)**, **Todoist (8)** — big task trackers, free-forever, REST.
- **Zoho CRM (8)**, **Freshsales (8)** — big CRMs with free-forever tiers (Zoho is OAuth → medium).
- **Grist (8)** — OSS spreadsheet-DB, clean REST.

Next tier worth doing: Strapi, Ghost, Storyblok, Prismic, Capsule, Shortcut, Teamwork, SeaTable (all 7).

## Caveats
- **Height is dead** (shut down 2025-09-24) — exclude.
- User counts marked "est." are best public estimates; most private SaaS don't publish totals (Coda, SeaTable, Grist, Stackby, Rows, Sanity, Storyblok, Prismic, Hygraph, DatoCMS, ButterCMS, Shortcut, Teamwork, Close, Folk).
- **OAuth-only** (harder for the paste-a-token CLI flow): Salesforce, Google Sheets, Zoho, Basecamp, Smartsheet, Keap, GoHighLevel, Wix, Squarespace.
- **GraphQL-only** (no REST): Linear, Monday.com, Hygraph (Sanity is GROQ-only).
- **Write API read-only / paywalled / commerce-only**: Squarespace (commerce only), ButterCMS (write paid), Contentful/DatoCMS (delivery API read-only, separate management API).
