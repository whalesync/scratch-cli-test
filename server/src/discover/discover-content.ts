export function generateDiscoverContent(options?: { workbookId?: string; apiBaseUrl?: string }): string {
  const base = options?.apiBaseUrl ?? 'https://api.scratch.md';

  return `# Scratch API

Scratch is a content management platform that syncs data between external services (Airtable, Notion, Webflow, Shopify, and more) and a workspace called a Workbook. You can use this API to read, create, edit, and publish content programmatically.

## What can you do with this?

- **Bulk edit content** — update titles, descriptions, or formatting across hundreds of files at once
- **Review and improve copy** — check your blog posts for SEO, fix inconsistent tone, or rewrite product descriptions
- **Create new content** — draft blog posts, product listings, or pages based on your existing content themes
- **Pull in the latest data** — sync fresh content from Airtable, Webflow, Notion, or Shopify and review what changed
- **Download your content** — save all your files to your local computer for backup, offline use, or bulk editing
- **Review your changes** — see what's changed since your last publish, and discard any edits you haven't published yet

## Authentication

All requests require an API token passed via the \`Authorization\` header:

\`\`\`
Authorization: API-Token <your-api-token>
\`\`\`

API tokens can be generated from the [Scratch settings page](https://app.scratch.md/settings/integrations) or downloaded as a \`scratch-api-key.txt\` file during onboarding.

## Quick Start

### 1. List your workbooks

\`\`\`bash
curl -s -H "Authorization: API-Token $(cat ~/Downloads/scratch-api-key.txt)" \\
  ${base}/workbook | jq .
\`\`\`

### 2. List files in a workbook

\`\`\`bash
curl -s -H "Authorization: API-Token $(cat ~/Downloads/scratch-api-key.txt)" \\
  "${base}/workbooks/{workbookId}/files/list/by-folder?folderId={folderId}" | jq .
\`\`\`

### 3. Read a file by path

\`\`\`bash
curl -s -H "Authorization: API-Token $(cat ~/Downloads/scratch-api-key.txt)" \\
  "${base}/workbooks/{workbookId}/files/by-path?path=/folder/file.md" | jq .
\`\`\`

### 4. Edit a file

\`\`\`bash
curl -s -X PATCH -H "Authorization: API-Token $(cat ~/Downloads/scratch-api-key.txt)" \\
  -H "Content-Type: application/json" \\
  -d '{"content": "updated content here"}' \\
  "${base}/workbooks/{workbookId}/files/by-path?path=/folder/file.md"
\`\`\`

### 5. Publish changes

After editing files, publish your changes back to the connected external service:

\`\`\`bash
curl -s -X POST -H "Authorization: API-Token $(cat ~/Downloads/scratch-api-key.txt)" \\
  -H "Content-Type: application/json" \\
  -d '{"dataFolderIds": ["{folderId}"]}' \\
  "${base}/workbook/{workbookId}/publish-v2/plan-job" | jq .
\`\`\`

## How Scratch organizes content

- A **Workbook** is a workspace — think of it as a project that holds all of your content.
- A **Folder** (DataFolder in the API) is a collection of related content. Each folder typically maps to a table or collection in a connected service like Airtable or Webflow.
- A **File** is a single piece of content inside a folder — like a blog post, product listing, or page. Files are usually Markdown or JSON.
- Files have a **path** (e.g., \`/blog-posts/my-article.md\`) and content.
- A **Connection** links your workbook to an external service (Airtable, Webflow, Shopify, etc.).
- A **Sync** keeps a folder's content in sync with a connected service.

## API Reference

### Workbooks

#### List workbooks
\`\`\`bash
curl -s -H "Authorization: API-Token $(cat ~/Downloads/scratch-api-key.txt)" \\
  ${base}/workbook | jq .
\`\`\`
Returns an array of workbooks you have access to.

#### Get workbook
\`\`\`bash
curl -s -H "Authorization: API-Token $(cat ~/Downloads/scratch-api-key.txt)" \\
  ${base}/workbook/{workbookId} | jq .
\`\`\`

#### List data folders in a workbook
\`\`\`bash
curl -s -H "Authorization: API-Token $(cat ~/Downloads/scratch-api-key.txt)" \\
  "${base}/workbook/{workbookId}/data-folders/list" | jq .
\`\`\`
Returns all folders in the workbook. Each folder has an \`id\` and \`path\`.

### Files

#### List files in a folder
\`\`\`bash
curl -s -H "Authorization: API-Token $(cat ~/Downloads/scratch-api-key.txt)" \\
  "${base}/workbooks/{workbookId}/files/list/by-folder?folderId={folderId}" | jq .
\`\`\`

#### Get file by path
\`\`\`bash
curl -s -H "Authorization: API-Token $(cat ~/Downloads/scratch-api-key.txt)" \\
  "${base}/workbooks/{workbookId}/files/by-path?path={filePath}" | jq .
\`\`\`
Returns the file's metadata and content.

#### Create a new file
\`\`\`bash
curl -s -X POST -H "Authorization: API-Token $(cat ~/Downloads/scratch-api-key.txt)" \\
  -H "Content-Type: application/json" \\
  -d '{"dataFolderId": "{folderId}", "filename": "new-file.md", "content": "# New File\\n\\nContent here."}' \\
  "${base}/workbooks/{workbookId}/files" | jq .
\`\`\`

#### Update a file by path
\`\`\`bash
curl -s -X PATCH -H "Authorization: API-Token $(cat ~/Downloads/scratch-api-key.txt)" \\
  -H "Content-Type: application/json" \\
  -d '{"content": "updated content"}' \\
  "${base}/workbooks/{workbookId}/files/by-path?path={filePath}"
\`\`\`

#### Delete a file by path
\`\`\`bash
curl -s -X DELETE -H "Authorization: API-Token $(cat ~/Downloads/scratch-api-key.txt)" \\
  "${base}/workbooks/{workbookId}/files/by-path?path={filePath}"
\`\`\`

### Folders

#### Get folder details
\`\`\`bash
curl -s -H "Authorization: API-Token $(cat ~/Downloads/scratch-api-key.txt)" \\
  ${base}/data-folder/{folderId} | jq .
\`\`\`

#### Get folder schema
\`\`\`bash
curl -s -H "Authorization: API-Token $(cat ~/Downloads/scratch-api-key.txt)" \\
  ${base}/data-folder/{folderId}/schema | jq .
\`\`\`
Returns the schema (field definitions) for records in this folder. Useful for understanding what fields are available when you create or edit files.

#### Create a new folder
\`\`\`bash
curl -s -X POST -H "Authorization: API-Token $(cat ~/Downloads/scratch-api-key.txt)" \\
  -H "Content-Type: application/json" \\
  -d '{"workbookId": "{workbookId}", "path": "/new-folder"}' \\
  ${base}/data-folder/create | jq .
\`\`\`

### Connections

#### List connections
\`\`\`bash
curl -s -H "Authorization: API-Token $(cat ~/Downloads/scratch-api-key.txt)" \\
  ${base}/workbooks/{workbookId}/connections | jq .
\`\`\`

### Syncs

#### List syncs
\`\`\`bash
curl -s -H "Authorization: API-Token $(cat ~/Downloads/scratch-api-key.txt)" \\
  ${base}/workbooks/{workbookId}/syncs | jq .
\`\`\`

#### Run a sync (pull data from external service)
\`\`\`bash
curl -s -X POST -H "Authorization: API-Token $(cat ~/Downloads/scratch-api-key.txt)" \\
  ${base}/workbooks/{workbookId}/syncs/{syncId}/run | jq .
\`\`\`

### Publishing

Publishing sends your edits back to the connected external service.

#### Create a publish plan
\`\`\`bash
curl -s -X POST -H "Authorization: API-Token $(cat ~/Downloads/scratch-api-key.txt)" \\
  -H "Content-Type: application/json" \\
  -d '{"dataFolderIds": ["{folderId}"]}' \\
  "${base}/workbook/{workbookId}/publish-v2/plan-job" | jq .
\`\`\`
This returns a job. Poll for completion, then run the publish job.

#### Run a publish job
\`\`\`bash
curl -s -X POST -H "Authorization: API-Token $(cat ~/Downloads/scratch-api-key.txt)" \\
  -H "Content-Type: application/json" \\
  -d '{"pipelineId": "{pipelineId}"}' \\
  "${base}/workbook/{workbookId}/publish-v2/run-job" | jq .
\`\`\`

### Jobs

#### Check job progress
\`\`\`bash
curl -s -H "Authorization: API-Token $(cat ~/Downloads/scratch-api-key.txt)" \\
  ${base}/jobs/{jobId}/progress | jq .
\`\`\`

### Change Tracking

Scratch tracks all changes to your content. You can check what's changed, view differences, and discard edits you haven't published yet.

#### Check for unsaved changes
\`\`\`bash
curl -s -H "Authorization: API-Token $(cat ~/Downloads/scratch-api-key.txt)" \\
  ${base}/scratch-git/{workbookId}/git-has-dirty | jq .
\`\`\`

#### View what changed in a file
\`\`\`bash
curl -s -H "Authorization: API-Token $(cat ~/Downloads/scratch-api-key.txt)" \\
  "${base}/scratch-git/{workbookId}/git-diff?path=/folder/file.md" | jq .
\`\`\`

### Pulling Data

#### Pull all files from external sources
\`\`\`bash
curl -s -X POST -H "Authorization: API-Token $(cat ~/Downloads/scratch-api-key.txt)" \\
  ${base}/workbook/{workbookId}/pull-files | jq .
\`\`\`

#### Discard all unsaved changes
\`\`\`bash
curl -s -X POST -H "Authorization: API-Token $(cat ~/Downloads/scratch-api-key.txt)" \\
  ${base}/workbook/{workbookId}/discard-changes
\`\`\`

## Common Workflows

### Bulk edit content (most common)
1. List your folders: \`GET /workbook/{workbookId}/data-folders/list\`
2. List files in the target folder: \`GET /workbooks/{workbookId}/files/list/by-folder?folderId={id}\`
3. Read each file, make your changes, and update via \`PATCH /workbooks/{workbookId}/files/by-path\`
4. Review your changes in the Scratch web app, then publish

### Pull in the latest content from your connected services
1. Pull: \`POST /workbook/{workbookId}/pull-files\`
2. Poll the returned job: \`GET /jobs/{jobId}/progress\` until complete
3. Check what changed: \`GET /scratch-git/{workbookId}/git-has-dirty\`
4. Review differences: \`GET /scratch-git/{workbookId}/git-diff?path=...\`

### Create new content
1. Get the folder schema to understand available fields: \`GET /data-folder/{folderId}/schema\`
2. Create files with the right structure: \`POST /workbooks/{workbookId}/files\`
3. Publish to push your new content to the connected service

### Discard unpublished edits
1. Discard everything you've changed since your last publish: \`POST /workbook/{workbookId}/discard-changes\`

## Tips

- **Your edits stay local until you publish** — review them in the Scratch web app first, and discard any you don't want before publishing.
- Use \`jq\` to parse JSON responses for easier reading.
- The \`path\` parameter for file operations uses POSIX format starting with \`/\`.
- After editing files, you need to publish to push changes back to the connected service.
- Pull operations are asynchronous — poll job progress to know when they complete.

## Full API Reference

For a complete list of all API endpoints with detailed request/response schemas, fetch: ${base}/discover/api-reference

---

# AI Agent Guidance

If you are an AI assistant reading this document, the following instructions are for you.

## Handling the API key

The user's API key is saved in a file called \`scratch-api-key.txt\`. Look for it in \`~/Downloads\`, \`~/Desktop\`, or the current working directory.

**Never paste or store the API key directly in conversation.** Instead, read it dynamically:
\`\`\`bash
curl -s -H "Authorization: API-Token $(cat ~/Downloads/scratch-api-key.txt)" ...
\`\`\`

## What to do first

1. **Find the API key** using the instructions above.
2. **List the user's workbooks** to see what content they have.
3. **Explore one workbook** — list its folders and files so you can describe what's in it.
4. **Tell the user what you found** and suggest things you can help with (see examples below).

Do NOT just summarize this document back to the user. Instead, **immediately start exploring their data** and offer to help.

When you present your findings, start with a brief (1-2 sentence) explanation of what Scratch is for the user. Something like: "Scratch is your content hub — it pulls in your data from services like Airtable, Webflow, and Notion into one place where you (and I) can read, edit, and manage it all together." Then show what you found.

## Example things you can offer to do

Once you've explored the user's workbooks, suggest concrete actions like:

- "I can see you have 47 blog posts in your /posts folder. Want me to review them for SEO improvements and update the titles and meta descriptions?"
- "Your /products folder has 120 items from Shopify. I can bulk-update product descriptions to be more compelling."
- "I notice some of your files have inconsistent formatting. Want me to standardize them?"
- "I can create new content for you — for example, draft 10 new blog post outlines based on your existing content themes."
- "Want me to pull the latest data from your connected services, review what changed, and summarize the differences?"
- "I can download all your content to your computer as local files — great for backups, working offline, or bulk AI editing."
- "I can show you everything that's changed since your last publish, and discard any edits you haven't published yet."

The key insight: Scratch gives you read/write access to the user's content. You can read files, edit them, create new ones, and publish changes back to the user's connected services. Think of yourself as a content editor with superpowers.

## Never publish automatically

Do NOT call the publish endpoints unless the user explicitly asks you to. After you make edits, the user will review the changes in the Scratch web app and publish them manually. Simply let the user know their changes are ready to review.

If the user specifically asks you to publish, confirm with them before doing so.

## Tone

The user is likely NOT a developer. When talking to them, avoid technical jargon like "git", "CRUD", "API", "endpoint", "repository", "commit", etc. Instead, use plain language:
- Say "your content" or "your files", not "the repository"
- Say "pull in the latest" not "trigger a sync"
- Say "publish your changes" not "run a publish job"
- Say "discard your unpublished edits" not "revert" or "reset"
- Say "folder" not "data folder" or "directory"
- Keep your language friendly, approachable, and focused on what the user's content looks like — not how the system works internally.
`;
}
