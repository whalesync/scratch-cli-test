# Preflight Validation for Scratch

## Summary

When customers publish data from Scratch, they have no way to know if their data will succeed or meet their quality standards until the publish actually runs. Failures leave them in partially-published states with cryptic errors, and unwanted content makes it all the way to production. We propose a **preflight validation system** — built-in connector rules that catch predictable API failures, plus user-defined rules for content quality standards — so customers can find and fix problems before they publish.

## Why Now?

- **Customer onboarding is blocked by publish failures.** New customers hit data problems on their first publish, lose confidence in Scratch, and need hand-holding to get past it. This is our most immediate sales blocker.
- **Engineering support is already a drain.** Solving data problems one-off was a huge time sink in Whalesync, and the same pattern is starting again in Scratch. We need systems that prevent problems for everyone, not reactive support for individual cases.
- **"Scratch doesn't work" is the wrong takeaway.** When a publish fails, the customer blames the tool — but 99% of the time, it's the data that needs fixing. Preflight validation makes the real problem visible and gives customers the tools to fix it themselves.

## The Problem

There are two distinct categories of problems, and customers need protection from both.

### Problem 1: Publish failures from API errors

Every external service has constraints on the data it accepts. When data violates those constraints, the API rejects the request — often partway through a batch, leaving the customer in a partially-published state with cryptic error messages.

These failures are especially painful because they're **predictable**. The constraints are well-known (slugs must be unique, `NOT NULL` columns can't be null, ad headlines can't exceed 30 characters), and Scratch has enough information about the data and the destination to check them before publishing. But today, we don't.

**Representative failures we've seen across Whalesync and Scratch:**

- **Duplicate slugs (Webflow).** Webflow requires unique slugs per collection. The publish failed partway through, leaving records in an inconsistent state.
- **Newlines in single-line text fields (Webflow).** PlainText fields reject records containing line breaks, but nothing warned the customer before they hit "Publish."
- **Images exceeding Webflow's 4MB limit.** When one image is over the limit, Webflow rejects all updates to the entire rich text field — not just the oversized image.
- **Deleting records referenced by unlinked tables (Webflow).** A customer deleted records from one collection, but other CMS collections (not linked as data folders in Scratch) still referenced those records. Scratch's publish planner clears references in folders it knows about, but it can't see or fix references in unlinked tables.
- **Text fields exceeding Notion's 2,000-character limit.** The API rejected or truncated the data without a clear warning.
- **NOT NULL constraint violations (Postgres).** Publishing records with null values in `NOT NULL` columns. The error sometimes didn't clearly identify which column.
- **Case-sensitive enum fields (Shopify).** The Status field only accepts exactly `active`, `draft`, or `archived`. A value like "Active" is rejected.
- **Duplicate email contacts (HubSpot).** HubSpot enforces email uniqueness. Syncing contacts with duplicate emails caused conflicts.
- **Unknown field names (Airtable).** After a field was deleted in Airtable but remained mapped in Whalesync, updates failed with "Unknown field name."

We've documented 25+ distinct failure modes across 6 connectors (see [Appendix A](#appendix-a-full-catalog-of-known-failure-modes)). Every new connector we build will introduce its own set of constraints that cause the same category of problems (see [Appendix B](#appendix-b-expected-failures-for-future-connectors)). The pattern is universal: the destination has rules, the data violates them, the publish fails, and the customer is frustrated. These are all preventable with upfront checks.

### Problem 2: Unwanted data getting published

Not all bad publishes result in API errors. Sometimes the data goes through fine — but the result is wrong. A blog post goes live with a title in the wrong case. A product description contains a character the brand style guide doesn't allow. A bulk price update accidentally sets a $50 item to $5.00. An ad campaign goes live with a phrase that doesn't match the company's messaging standards.

These problems are subtler but often more costly. An API error at least stops the bad data from going live. An unwanted change makes it all the way to production, and the customer might not notice until a reader, shopper, or compliance team does.

Unlike API constraint violations, these rules are **customer-specific**. What counts as "wrong" depends on the team's editorial standards, brand guidelines, and business logic. Some examples:

_Content and editorial standards:_

- Blog post titles must be in sentence case
- Body content must not contain emdashes or smart quotes
- Every post must have a summary and meta description before going live
- Product descriptions must be between 100 and 500 characters

_Business logic:_

- No prices should be set to $0.00
- Sale prices must not drop below cost (preventing unprofitable promotions)
- Price increases above 20% should be flagged for review
- Inventory quantities should not be negative

_SEO and compliance:_

- All pages need a meta description
- Meta titles must not exceed 60 characters
- No duplicate title tags across pages
- Ad copy must not contain specific disallowed phrases

_Data hygiene:_

- Phone numbers must be in a consistent format
- Email addresses must be valid
- No duplicate contacts by email address
- Every CRM record must have a lead source

_Change scope control:_

- Only specific fields should be editable — the rest should be treated as locked
- AI agents editing local files should only touch whitelisted fields, not rewrite entire records
- A team member updating blog post content shouldn't accidentally modify SEO metadata or slugs

These rules are specific to each customer's business — not something we can hardcode into connectors. Customers need a way to define their own checks and run them before publishing.

## Proposed Solution

A **preflight validation system** that lets customers check their data before publishing. Users run validation on-demand — scoped to a single file, a folder, their recent changes, or the entire workbook. The system reports issues as warnings or errors, and the user decides what to fix before publishing.

The system supports two categories of rules:

1. **Connector rules** — Built-in rules that each connector (Webflow, Airtable, etc.) defines based on what it knows will cause API failures. These ship out of the box with no configuration needed.

2. **User-defined rules** — Custom rules that customers define for their own content quality standards. Configured through a simple UI or a JSON config file that lives in the workbook's git repo.

### How a customer would use it

**Scenario 1: First-time Webflow publisher**

A customer pulls their Webflow CMS data into Scratch, makes edits, and is ready to publish. Before clicking "Publish," they right-click the folder and select "Validate." Scratch checks all their records against Webflow's known constraints — slug format, required fields, no newlines in plain text — and reports 4 errors across 12 records. The customer clicks each issue, fixes the data in the editor, and re-validates. Clean. They publish with confidence.

**Scenario 2: Content team with editorial standards**

A marketing team uses Scratch to manage blog posts published to Webflow. They configure custom rules: titles must be sentence case, no emdashes in body content, every post needs a summary. A content writer finishes a draft and runs validation. Two warnings flag emdashes in the body text. The writer fixes them, validates clean, and publishes. The rules live in the git repo, so every team member gets the same checks.

**Scenario 3: CLI user with AI-assisted fixes**

A developer uses the Scratch CLI to manage content locally. They run validation from the UI and see 15 warnings across their blog posts. They click "Copy Issues," paste the structured output into their AI coding agent, and the agent fixes all 15 issues across the local files in seconds. They re-validate, confirm everything is clean, and publish.

**Scenario 4: Partial CMS onboarding**

A customer has linked 3 of their 5 Webflow CMS collections as data folders. They delete an author record and run validation. Scratch warns: "2 of 5 CMS collections in this Webflow site are not linked to Scratch. If the unlinked collections (Team Members, Press Mentions) reference this record, the delete may fail." The customer can choose to link those collections first, or proceed knowing the risk.

See [Appendix C](#appendix-c-additional-user-scenarios) for more scenarios covering e-commerce, CRM, advertising, and database use cases.

## Alternatives Considered

**Better error messages on publish failure.** This is what we did in Whalesync, and it only helped a bit. It still makes errors a runtime problem — the customer has already committed to publishing, the batch is partway through, and now they're debugging. In Scratch, we want to move as many problems as possible to be "compile-time problems" that are caught before the publish runs.

**Auto-fix data on publish.** Whalesync also did this (e.g., auto-generating slugs, trimming whitespace). It makes things too "magical" and unpredictable. Scratch depends on visibility and control — it's the user's data and they should decide what to do with it. Silently changing data on publish undermines trust.

**Schema enforcement at write time.** This would prevent bad data from ever being saved, but it goes against Scratch being a flexible editor. Users should be able to edit freely — it's their data. Preflight validation gives them a safety check when they're ready, without restricting how they work.

## Benefits

- **Prevents failed publishes.** Connector rules catch data issues that are guaranteed to cause API errors, before the publish runs.
- **Reduces onboarding friction.** New customers can validate their data immediately, catching problems before their first publish instead of after.
- **Reduces engineering support load.** Data problems become self-service. Customers can diagnose and fix issues themselves instead of filing tickets and waiting for engineering to investigate. This was one of the biggest time sinks in Whalesync — every connector had its own failure modes, and we solved them one customer at a time.
- **Enables content quality standards.** Teams can enforce editorial rules that keep unwanted content off their site.
- **Works with the CLI workflow.** Copy-to-clipboard output is designed for AI agents to parse and fix issues automatically.
- **Version-controlled rules.** User-defined rules live in the git repo, so they travel with the data and apply consistently across team members.
- **Non-blocking by default.** Validation is a tool, not a gate. It surfaces issues without adding friction to the publish flow.

## Future: Custom Code Rules (V2)

The V1 system uses a declarative rule configuration — users pick from a menu of rule types (required, unique, regex, etc.) and configure them through the UI. This covers most use cases, but power users will eventually want arbitrary logic.

V2 would let users write JavaScript validation functions stored in git alongside their data:

```javascript
// .scratch/validators/title-check.js
export default {
  id: "title-sentence-case",
  severity: "warning",
  validate(record, ctx) {
    const title = ctx.getField(record, "fieldData.name");
    if (!title) return;
    if (title[0] !== title[0].toUpperCase()) {
      return ctx.issue(
        "fieldData.name",
        "Title must start with a capital letter",
      );
    }
  },
};
```

These functions would run in a sandboxed environment with strict memory and time limits. The validation engine treats them identically to built-in rules — same output format, same severity system, same results UI. The V1 architecture is designed to support this without changes to the engine, storage, or client.

---

## Technical Design

_The sections below cover implementation details for engineering reference._

### Rule System

#### Connector Rules

Each connector defines rules via a new `getValidationRules(tableSpec)` method on the Connector base class. The base class provides default rules (required fields, reference checks, type mismatches, delete-unlinked-tables). Connectors override to add service-specific rules.

**Core rules (all connectors):**

| Rule ID                       | Trigger     | Logic                                                                                                            | Default |
| ----------------------------- | ----------- | ---------------------------------------------------------------------------------------------------------------- | ------- |
| `core/required-fields`        | Create/edit | Non-optional, non-readonly fields must have values                                                               | warning |
| `core/reference-exists`       | Create/edit | FK fields must point to existing records (supports remote IDs and pseudo-refs like `@/path/to/file.json`)        | warning |
| `core/type-mismatch`          | Create/edit | Value type must match schema type                                                                                | error   |
| `core/readonly-not-modified`  | Edit        | Read-only fields should not differ from their pulled values                                                      | warning |
| `core/delete-unlinked-tables` | Delete      | Warns if not all tables in the connector's site are linked as data folders — unlinked tables may hold references | warning |

**Webflow rules:**

| Rule ID                            | Logic                                                                   | Default |
| ---------------------------------- | ----------------------------------------------------------------------- | ------- |
| `webflow/slug-required`            | Slug field must not be null or empty                                    | error   |
| `webflow/slug-unique`              | Slug must be unique across the folder                                   | error   |
| `webflow/slug-format`              | Slug must match `^[a-z0-9]+(-[a-z0-9]+)*$`                              | error   |
| `webflow/no-newlines-in-plaintext` | PlainText fields must not contain `\n` or `\r`                          | error   |
| `webflow/required-fields`          | Fields marked required in Webflow's field definitions must have values  | error   |
| `webflow/richtext-valid-html`      | RichText fields must contain parseable HTML with Webflow-supported tags | warning |
| `webflow/image-url-accessible`     | Image/MultiImage `url` fields must be non-empty and well-formed         | warning |

#### User-Defined Rules

Stored in `.scratch/validation.json` per data folder:

```json
{
  "rules": [
    {
      "id": "title-sentence-case",
      "type": "regex",
      "field": "fieldData.name",
      "pattern": "^[A-Z]",
      "message": "Title should start with a capital letter",
      "severity": "warning"
    },
    {
      "id": "no-emdashes",
      "type": "disallowed-chars",
      "field": "fieldData.post-body",
      "chars": ["\u2014"],
      "message": "Content should not contain emdashes",
      "severity": "warning"
    },
    {
      "id": "field-editing-whitelist",
      "type": "editable-fields",
      "fields": ["fieldData.name", "fieldData.post-body", "fieldData.summary"],
      "message": "Field was changed but is not in this folder's editable fields list",
      "severity": "error"
    }
  ],
  "overrides": {
    "webflow/richtext-valid-html": { "severity": "error" },
    "webflow/image-url-accessible": { "enabled": false }
  }
}
```

Built-in rule types for V1:

| Type               | Params             | Description                                                 |
| ------------------ | ------------------ | ----------------------------------------------------------- |
| `required`         | `field`            | Field must not be null, undefined, or empty string          |
| `unique`           | `field`            | Field value must be unique across all records in the folder |
| `regex`            | `field`, `pattern` | Field value must match the regex pattern                    |
| `disallowed-chars` | `field`, `chars[]` | Field must not contain any of the listed characters         |
| `max-length`       | `field`, `max`     | String field must not exceed the specified length           |
| `no-newlines`      | `field`            | String field must not contain newline characters            |
| `reference-exists` | `field`            | Referenced record must exist in the linked folder           |
| `editable-fields`  | `fields[]`         | Only whitelisted fields may differ from their pulled values |

Every rule — connector or user-defined — produces a common output:

```typescript
interface ValidationIssue {
  ruleId: string;
  filePath: string;
  field?: string;
  severity: "warning" | "error";
  message: string;
}
```

### Server Architecture

#### Module Structure

```
server/src/validation/
├── validation.module.ts
├── validation.controller.ts
├── validation.service.ts             # Orchestration
├── validation-engine.service.ts      # Rule execution (stateless, no DB)
├── validation-rules.service.ts       # Loads and merges connector + user rules
├── validation.types.ts
├── dto/
│   ├── run-validation.dto.ts
│   └── validation-result.dto.ts
├── entities/
│   └── validation-result.entity.ts
└── __tests__/
    └── validation-engine.spec.ts
```

#### Services

**`ValidationService`** orchestrates the full flow:

1. Receives a validation request with scope and optional path filters
2. Resolves affected folders and files from git based on scope
3. For small scopes (single file, small folder), runs inline for immediate response
4. For large scopes (changed files across folders, full workbook), enqueues a Bull job
5. Stores results in DB and returns them to the client

**`ValidationRulesService`** assembles the rule set for a given folder:

1. Calls `connector.getValidationRules(tableSpec)` for connector rules
2. Reads `.scratch/validation.json` from the git repo for user rules
3. Applies severity overrides and disabled flags
4. Returns a unified `ValidationRule[]` array

**`ValidationEngineService`** executes rules against records. Stateless and side-effect-free:

- Single-record rules (required, regex, no-newlines) run against each record individually
- Cross-record rules (unique) run against all records in the folder
- Cross-folder rules (reference-exists, delete-unlinked-tables) load data from other folders or connector metadata
- Returns `ValidationIssue[]`

#### Connector Base Class Extension

```typescript
abstract class Connector<T> {
  getValidationRules(tableSpec: BaseJsonTableSpec): ValidationRule[] {
    return getDefaultValidationRules(tableSpec);
  }
}
```

Connectors like Webflow override this to add service-specific rules. The base implementation provides core rules.

#### API Endpoints

```
POST   /workbook/:workbookId/validation/run
       Body: { scope: 'file' | 'folder' | 'changed' | 'all', folderPath?, filePath? }
       Returns: { jobId?, resultId }

GET    /workbook/:workbookId/validation/results/:resultId
       Returns: { status, issues[], summary, validatedAt }

GET    /workbook/:workbookId/validation/results/latest
       Query: { folderPath? }
       Returns: latest result for the given scope

DELETE /workbook/:workbookId/validation/results/:resultId
```

#### Results Storage

```prisma
model ValidationResult {
  id            String   @id @default(uuid())
  workbookId    String
  scope         String   // 'file', 'folder', 'changed', 'all'
  scopePath     String?  // folder or file path if scoped
  status        String   // 'running', 'completed', 'failed'
  issues        Json     // ValidationIssue[]
  summary       Json     // { errors: number, warnings: number, byFolder: {...} }
  validatedAt   DateTime @default(now())

  workbook      Workbook @relation(fields: [workbookId], references: [id])

  @@index([workbookId, scopePath])
}
```

Results are ephemeral. Only the latest result per workbook + scope is kept.

#### Job vs Inline Execution

| Scope                          | Execution                   |
| ------------------------------ | --------------------------- |
| Single file                    | Inline (immediate response) |
| Single folder, < ~100 records  | Inline                      |
| Single folder, >= ~100 records | Bull job                    |
| Changed files across folders   | Bull job                    |
| Full workbook                  | Bull job                    |

### Data Flow

```
User clicks "Validate" (scoped)
         |
POST /validation/run { scope, folderPath? }
         |
ValidationService:
  1. Resolve affected folders + files from git (dirty branch)
  2. For each folder:
     a. Load tableSpec from .schema.json
     b. Load connector rules via connector.getValidationRules(tableSpec)
     c. Load user rules from .scratch/validation.json
     d. Merge rules, apply overrides
  3. Read record files from git (dirty branch)
  4. Pass rules + records to ValidationEngineService
         |
ValidationEngineService:
  For each rule:
    single-record rules -> run per record
    cross-record rules  -> run across all folder records
    cross-folder rules  -> load related folder data
  Collect ValidationIssue[]
         |
Store results in DB, return to client
```

Validation runs against the **dirty branch** — it checks what the user currently sees and is about to publish.

### Client UX

#### Entry Points

1. **Sidebar context menu** — Right-click a folder or file, select "Validate". Scoped to the target.
2. **Review toolbar** — "Validate Changes" button, scoped to changed files (dirty vs main diff).
3. **Publish modal** — "Validate First" link. Not blocking, just a nudge. If a recent validation has errors, shows a banner: "3 validation errors found — review before publishing?"

#### Validation Results Panel

```
Validation Results                   Ran 30s ago  Refresh
3 errors, 7 warnings

> /Webflow/Blog Posts (2 errors, 4 warnings)
  X my-first-post.json
    - fieldData.slug: Duplicate slug "hello"
    - fieldData.name: Contains newline
  ! another-post.json
    - fieldData.summary: Summary is empty
    - fieldData.post-body: Contains emdash

> /Webflow/Authors (1 error, 3 warnings)
  X author-3.json
    - fieldData.slug: Slug is empty
  ...
```

- Grouped by folder, then by file
- Errors sorted above warnings
- Each issue clickable — opens the file editor with the field focused
- Staleness indicator when records have changed since last run

#### Inline Annotations

- Error fields: red underline/highlight with message on hover
- Warning fields: yellow/amber treatment
- File tree badges: red dot for errors, yellow dot for warnings

#### Rules Configuration UI

A settings panel per folder:

- **Connector rules** section: shows built-in rules, allows severity override or disabling
- **Custom rules** section: "Add Rule" flow to pick a rule type and configure field + params
- "Save to repo" writes the updated `.scratch/validation.json` to git

#### Copy to Clipboard

A "Copy Issues" button produces AI-agent-friendly output:

```
Scratch Validation Results — 3 errors, 7 warnings
Workbook: My Website
Ran: 2026-03-03T14:30:00Z

## /Webflow/Blog Posts

my-first-post.json
  ERROR fieldData.slug: Duplicate slug "hello" (also in other-post.json)
  ERROR fieldData.name: Contains newline character

another-post.json
  WARNING fieldData.summary: Summary is empty
  WARNING fieldData.post-body: Contains emdash at position 142
```

Full file paths and field paths so CLI users can hand it to an AI agent for automated fixes. Also available as "Copy as JSON" for structured consumption.

---

## Appendix A: Full Catalog of Known Failure Modes

Failures observed across Whalesync and Scratch, organized by connector.

### Webflow

- **Newlines in single-line text fields.** Webflow PlainText fields reject records containing line breaks, but nothing warned the customer before they hit "Publish."
- **Duplicate slugs.** Webflow requires unique slugs per collection. The publish failed partway through, leaving records in an inconsistent state.
- **Missing slugs.** Records with null or empty slug fields were sent to Webflow, which requires them. Records failed silently or with unhelpful API errors.
- **Slug format violations.** Slugs containing spaces, uppercase letters, or leading hyphens were rejected. Webflow requires slugs to be alphanumeric with hyphens only.
- **Deleting records referenced by unlinked tables.** A customer deleted records from one collection, but other CMS collections (not linked as data folders in Scratch) still referenced those records. Scratch's publish planner clears references in folders it knows about, but it can't see or fix references in unlinked tables.
- **Images exceeding Webflow's 4MB limit.** Webflow has a 4MB limit on images in rich text fields. When one image is over the limit, Webflow rejects all updates to the entire rich text field — not just the oversized image.
- **Name field exceeding 256 characters.** Webflow's Name field has a hard 256-character limit that isn't obvious until the API rejects the record.
- **Required fields cleared.** Webflow allows marking fields as required. Syncing a record with an empty required field was rejected, but the error didn't clearly identify which field.
- **Field type mismatches.** URL fields rejecting non-URL strings, number fields rejecting text. Webflow's error: "Expected value to be..." without clear guidance.
- **Referenced items not found.** Webflow reference fields require the referenced item to be in a published state. Unpublished or deleted referenced items cause opaque failures.
- **Multi-line HTML in rich text fields.** Webflow rich text fields require HTML to be minified to a single line. Multi-line HTML breaks rendering in the Webflow UI. Whalesync had to add automatic minification to work around this.
- **Initial variant price required for products.** When creating a Webflow product, the "Initial Variant - Price" field must be provided because Webflow creates the first variant at product creation time. Missing it causes the create to fail.
- **CMS item plan limits.** Webflow limits total CMS items by subscription plan. Hitting the limit mid-batch leaves the publish partially completed. Catchable by comparing current item count + planned creates against the plan limit (queryable from Webflow's API or configurable as a user rule).
- **Site must be published to all domains.** Webflow rejects API updates if the site has been published to different domains at different times. The error is confusing and the fix (republish to all domains) is non-obvious.

### Notion

- **Text fields exceeding 2,000-character limit.** Notion enforces a hard 2,000-character limit on text properties. The API rejected or truncated the data without a clear warning.
- **Rich text with too many style elements.** Notion's API only accepts up to 100 style changes per rich text field. Heavily formatted content from other sources was silently rejected.
- **Reference fields with too many entries.** Relation fields with more entries than Notion's API accepts in a single update failed with a confusing error about request size.
- **Relation field truncation at 25 entries.** Notion's API only returns the first 25 related records per relation field. When a field has more than 25 relations, partial data is returned without warning, requiring separate API calls to fetch the rest. Updates can silently drop relations beyond the 25th.
- **Field type changes.** When a field type is changed in Notion (e.g., Select to Multi-Select), existing updates fail until the schema is refreshed. The error message doesn't explain the root cause.

### Postgres / Supabase

- **NULL characters in JSONB fields.** Data containing null bytes (U+0000) caused insert failures. The database error was difficult to trace back to the specific field and character.
- **NOT NULL constraint violations.** Publishing records with null values in `NOT NULL` columns. The error sometimes didn't clearly identify which column.
- **Unique constraint violations.** Inserting records with duplicate values in columns that have unique indexes. The error identifies the constraint but not always the specific value that conflicted.

### Shopify

- **Case-sensitive enum fields.** The Status field only accepts exactly `active`, `draft`, or `archived` — case-sensitive. A value like "Active" or "ACTIVE" is rejected.
- **Duplicate variant combinations.** Shopify doesn't allow two variants with the same option values. The error message was unclear about which variants conflicted.
- **Cannot delete all variants.** Shopify requires at least one default variant per product. Attempting to delete the last variant fails.
- **Product title required, 255-character limit.** Product title is required and cannot exceed 255 characters. The GraphQL API rejects the mutation but the error doesn't always clearly point to the title field.
- **Maximum 100 variants per product.** Hard limit — adding a 101st variant fails. This is easy to hit with products that have multiple option types (e.g., 5 sizes x 5 colors x 5 materials = 125 variants).
- **Maximum 3 option types per product.** Products can only have 3 option dimensions (e.g., Size, Color, Material). Attempting to add a 4th is rejected.
- **Maximum 250 images per product.** Exceeding this limit fails silently in some API versions.
- **Variant option values limited to 255 characters.** SKU also limited to 255 characters. Exceeding either causes a mutation failure.
- **Handle (slug) uniqueness.** Product handles must be unique across the entire store and follow URL-safe formatting. Duplicates are rejected.
- **Prices must be decimal strings, not numbers.** The GraphQL API expects `"19.99"` (string), not `19.99` (number). GraphQL's strict typing rejects the wrong type with a confusing schema validation error.
- **Compare-at price must exceed actual price.** Setting a compare-at (original) price lower than the sale price is rejected. Setting it equal is also rejected — it must be strictly higher, or null.
- **Negative prices rejected.** Prices cannot be negative values.
- **Metafield type strict validation.** Metafield values are validated against their declared type — `date` rejects non-ISO-8601 strings, `integer` rejects decimals, `json` validates against its JSON schema. The errors reference the metafield type system, which is unfamiliar to most users.
- **Metafield key/namespace format restrictions.** Keys must be lowercase alphanumeric + underscores (max 64 chars). Namespaces have the same restrictions (max 20 chars). Violations are rejected with a generic "invalid" error.
- **Single-line metafields reject newlines.** Same pattern as Webflow PlainText — newline characters in single-line text metafields cause the mutation to fail.
- **Tags: 250 max, 255 chars each, comma parsing issues.** Products are limited to 250 tags, each max 255 characters. Tags containing commas are split into multiple tags in some API contexts, causing unexpected behavior.
- **Inventory can't be set if tracking is disabled.** Attempting to set inventory quantities for a variant that doesn't have inventory tracking enabled is rejected.
- **Negative inventory requires "allow overselling" setting.** Setting inventory below zero fails unless the location has overselling enabled. The error doesn't explain the location-level setting.
- **Unsupported HTML tags silently stripped from descriptions.** Product descriptions accept HTML but only a subset of tags. Unsupported tags (e.g., `<script>`, `<iframe>`, certain CSS) are silently removed, which can break formatting without any error.

### HubSpot

- **Duplicate email contacts.** HubSpot enforces email uniqueness at the contact level. Syncing contacts with duplicate emails caused conflicts.

### Airtable

- **Unknown field names.** After a field was deleted in Airtable but remained mapped in Whalesync, updates to that field failed with "Unknown field name."
- **Single-line text fields with spurious newlines.** Data imported via CSV into Airtable sometimes has stray newlines at the start and end of single-line text fields. Whalesync had to add stripping logic to handle this.

### WordPress

- **Invalid usernames.** Usernames containing special characters, spaces, or formatted as email addresses were rejected by WordPress's API.

### Wix

- **Single-item collections rejecting new records.** Wix has "single item" collections that contain exactly one record. Attempting to create additional records in them fails.

### Cross-Connector Data Conversion Issues

These issues apply across connectors whenever data is converted between types:

- **Select/enum values must match exactly.** Values that don't match the destination's defined options are rejected. This is case-sensitive and whitespace-sensitive across most connectors.
- **Number fields rejecting NaN.** Non-numeric strings in number fields cause parse failures. The error often doesn't identify the specific value that failed.
- **Number fields with min/max range limits.** Values outside the allowed range for a numeric field are rejected. The limits vary by connector and field configuration.
- **Invalid JSON in JSON/JSONB fields.** Malformed JSON strings in structured fields cause parse failures with the raw JSON parser error, which is unhelpful to users.
- **Date fields requiring ISO 8601 format.** Dates in non-standard formats (e.g., "March 3, 2026" or "03/03/26") are rejected. The required format isn't obvious to users.
- **Boolean fields with unexpected values.** Most connectors accept `true`/`false`, `1`/`0`, `yes`/`no`, and `on`/`off`, but reject other truthy/falsy values like `"Y"` or `"enabled"`.
- **Integer truncation without warning.** When decimal values are published to integer fields, the decimal portion is silently truncated (not rounded). A value of `9.99` becomes `9` with no warning.
- **Single-value foreign keys silently dropping extras.** When a multi-value relation is published to a single-value foreign key field, only the first value is kept. The remaining values are silently dropped.

## Appendix B: Expected Failures for Future Connectors

Every new connector we build introduces its own set of constraints that will cause the same category of problems:

_Database connectors (Postgres, Supabase)_ — Non-null constraint violations, unique index conflicts, foreign key references to non-existent rows, type mismatches (strings in integer columns, malformed dates), values exceeding column length limits, check constraint violations, invalid characters in JSONB fields.

_E-commerce (Shopify)_ — Missing required product data (no images, no description), invalid variant combinations (duplicate option values, exceeding 100-variant or 3-option-type limits), inventory set to negative values, case-sensitive enum values, prices as wrong type (number vs string), compare-at price lower than actual price, handle uniqueness, metafield type validation, tag limits, unsupported HTML in descriptions.

_CMS platforms (Webflow, Wix)_ — Slug issues (duplicates, missing values, invalid characters), field format violations (newlines in single-line fields, invalid HTML in rich text), broken image URLs, content exceeding field size limits, image size limits in rich text, required field violations, CMS item plan limits.

_Productivity platforms (Notion)_ — Text properties exceeding 2,000-character limit, rich text with too many style elements, relation fields with too many entries, select/multi-select values not matching defined options.

_CRM systems (HubSpot, Salesforce)_ — Required field violations, picklist values that don't match the CRM's defined options, duplicate contacts by email, records assigned to inactive users.

_Marketing platforms (Mailchimp, Google Ads)_ — Malformed newsletter HTML (unclosed tags, unsupported CSS), ad headlines exceeding character limits, disallowed keywords that violate advertising policies, malformed landing page URLs.

_Git repositories_ — Changes that conflict with the target repo's expected file structure, modifications to files that have diverged since last pull.

## Appendix C: Additional User Scenarios

**Scenario 5: Shopify price update safety net**

An e-commerce team uses Scratch to manage product data across their Shopify store. They're running a seasonal sale and bulk-editing prices. Before publishing, they run validation. A custom rule flags 3 products where the discounted price would drop below cost, and 1 product where a decimal error set the price to $1.99 instead of $19.99. They catch a potentially costly mistake before it goes live to customers.

**Scenario 6: CRM data cleanup**

A sales ops team syncs HubSpot contact data through Scratch. Before publishing cleaned-up records back, they run validation. Built-in rules flag 12 contacts with duplicate email addresses, 8 with invalid phone number formats, and 3 with values that don't match HubSpot's picklist options. Custom rules flag contacts missing a "Lead Source" field, which the team requires for reporting. They clean everything up in Scratch and publish a consistent, high-quality dataset back to HubSpot.

**Scenario 7: Google Ads compliance**

A marketing agency manages Google Ads campaigns through Scratch. Before publishing new ad copy, they run validation. Built-in rules catch 2 headlines exceeding the 30-character limit. Custom rules flag ads containing phrases that violate Google's advertising policies. The team fixes the issues before submission, avoiding ad rejections and potential account flags.

**Scenario 8: Database migration safety**

A development team uses Scratch to manage data being published to a Postgres database. Before publishing, validation catches 5 records with null values in `NOT NULL` columns, 2 records with duplicate values in a uniquely-indexed column, and 1 record with a string value in an integer field. Without preflight validation, these would have failed mid-batch, leaving the database in a partially-updated state.
