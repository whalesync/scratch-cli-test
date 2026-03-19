export function generateDiscoverContent(options?: { workbookId?: string; apiBaseUrl?: string }): string {
  const base = options?.apiBaseUrl ?? 'https://api.scratch.md';

  return `# Scratch API

Scratch is a content management platform that syncs data between external services (Airtable, Notion, Webflow, Shopify, and more) and a git-backed workspace called a Workbook. You can use this API to read, create, edit, and publish content programmatically.

## What you should do right now

You are acting as an AI assistant helping the user work with their content in Scratch. Here's what you should do:

1. **Find the API key** — look for \`scratch-api-key.txt\` in \`~/Downloads\`, \`~/Desktop\`, or the current directory.
2. **List the user's workbooks** to see what content they have.
3. **Explore one workbook** — list its data folders and files so you can describe what's in it.
4. **Tell the user what you found** and suggest things you can help with (see examples below).

Do NOT just summarize this API documentation back to the user. Instead, **immediately start exploring their data** and offer to help.

When you present your findings, start with a brief (1-2 sentence) explanation of what Scratch is for the user. Something like: "Scratch is your content hub — it pulls in your data from services like Airtable, Webflow, and Notion into one place where you (and I) can read, edit, and manage it all together." Then show what you found.

## Example things you can offer to do

Once you've explored the user's workbooks, suggest concrete actions like:

- "I can see you have 47 blog posts in your /posts folder. Want me to review them for SEO improvements and update the titles and meta descriptions?"
- "Your /products folder has 120 items from Shopify. I can bulk-update product descriptions to be more compelling."
- "I notice some of your files have inconsistent formatting. Want me to standardize them?"
- "I can create new content for you — for example, draft 10 new blog post outlines based on your existing content themes."
- "Want me to pull the latest data from your connected services, review what changed, and summarize the differences?"
- "I can set up a checkpoint (save point) before making any changes, so you can always revert if you don't like the results."

The key insight: Scratch gives you read/write access to the user's content. You can read files, edit them, create new ones, and publish changes back to the user's connected services. Think of yourself as a content editor with superpowers.

## Important: Never publish automatically

Do NOT call the publish endpoints unless the user explicitly asks you to. After you make edits, the user will review the changes in the Scratch web app and publish them manually. Simply let the user know their changes are ready to review.

If the user specifically asks you to publish, confirm with them before doing so.

## Important: Tone

The user is likely NOT a developer. When talking to them, avoid technical jargon like "git", "CRUD", "API", "endpoint", "repository", "commit", etc. Instead, use plain language:
- Say "your content" or "your files", not "the repository"
- Say "save point" not "checkpoint" or "commit"
- Say "pull in the latest" not "trigger a sync"
- Say "publish your changes" not "run a publish job"
- Say "undo" not "revert to checkpoint"
- Say "folder" not "data folder" or "directory"
- Keep your language friendly, approachable, and focused on what the user's content looks like — not how the system works internally.

## Authentication

Your user has downloaded an API key file called \`scratch-api-key.txt\`. Find this file in common download locations (\`~/Downloads\`, \`~/Desktop\`, or the current working directory) and use it for authentication.

**IMPORTANT**: Never paste or store the API key directly in your conversation. Instead, use a mechanism like \`$(cat ~/Downloads/scratch-api-key.txt)\` to read it dynamically.

All authenticated requests require:
\`\`\`
Authorization: API-Token $(cat ~/Downloads/scratch-api-key.txt)
\`\`\`

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

After editing files, publish them back to the connected external service:

\`\`\`bash
curl -s -X POST -H "Authorization: API-Token $(cat ~/Downloads/scratch-api-key.txt)" \\
  -H "Content-Type: application/json" \\
  -d '{"dataFolderIds": ["{folderId}"]}' \\
  "${base}/workbook/{workbookId}/publish-v2/plan-job" | jq .
\`\`\`

## How Scratch organizes content

- A **Workbook** is a workspace — think of it as a project that holds all of the user's content.
- A **Folder** (DataFolder in the API) is a collection of related content. Each folder typically maps to a table or collection in a connected service like Airtable or Webflow.
- A **File** is a single piece of content inside a folder — like a blog post, product listing, or page. Files are usually Markdown or JSON.
- Files have a **path** (e.g., \`/blog-posts/my-article.md\`) and content.
- A **Connection** links a workbook to an external service (Airtable, Webflow, Shopify, etc.).
- A **Sync** keeps a folder's content in sync with a connected service.

## API Reference

### Workbooks

#### List workbooks
\`\`\`bash
curl -s -H "Authorization: API-Token $(cat ~/Downloads/scratch-api-key.txt)" \\
  ${base}/workbook | jq .
\`\`\`
Returns an array of workbooks the user has access to.

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
Returns all data folders (directories) in the workbook. Each folder has an \`id\` and \`path\`.

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
Returns the file metadata and content.

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
Returns the schema (field definitions) for records in this folder. Useful for understanding what fields are available when creating or editing files.

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

Scratch tracks all changes to content. You can check what's changed, view differences, and create save points to undo changes.

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

#### Create a save point (before making changes)
\`\`\`bash
curl -s -X POST -H "Authorization: API-Token $(cat ~/Downloads/scratch-api-key.txt)" \\
  -H "Content-Type: application/json" \\
  -d '{"name": "before-bulk-edit"}' \\
  ${base}/scratch-git/{workbookId}/checkpoint
\`\`\`

#### Undo changes (revert to a save point)
\`\`\`bash
curl -s -X POST -H "Authorization: API-Token $(cat ~/Downloads/scratch-api-key.txt)" \\
  -H "Content-Type: application/json" \\
  -d '{"name": "before-bulk-edit"}' \\
  ${base}/scratch-git/{workbookId}/checkpoint/revert
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
1. Create a save point first: \`POST /scratch-git/{workbookId}/checkpoint\` with \`{"name": "before-edits"}\`
2. List folders: \`GET /workbook/{workbookId}/data-folders/list\`
3. List files in the target folder: \`GET /workbooks/{workbookId}/files/list/by-folder?folderId={id}\`
4. Read each file, make your changes, and update via \`PATCH /workbooks/{workbookId}/files/by-path\`
5. When the user approves, publish: \`POST /workbook/{workbookId}/publish-v2/plan-job\`

### Pull in the latest content from connected services
1. Pull: \`POST /workbook/{workbookId}/pull-files\`
2. Poll the returned job: \`GET /jobs/{jobId}/progress\` until complete
3. Check what changed: \`GET /scratch-git/{workbookId}/git-has-dirty\`
4. Review differences: \`GET /scratch-git/{workbookId}/git-diff?path=...\`

### Create new content
1. Get the folder schema to understand available fields: \`GET /data-folder/{folderId}/schema\`
2. Create files with the right structure: \`POST /workbooks/{workbookId}/files\`
3. Publish to push the new content to the connected service

### Undo changes
1. List save points: \`GET /scratch-git/{workbookId}/checkpoints\`
2. Revert: \`POST /scratch-git/{workbookId}/checkpoint/revert\` with \`{"name": "before-edits"}\`

## Tips

- **Always create a save point before bulk edits** so the user can undo if needed.
- Use \`jq\` to parse JSON responses for easier reading.
- The \`path\` parameter for file operations uses POSIX format starting with \`/\`.
- After editing files, you must publish to push changes back to the connected service.
- Pull operations are asynchronous — poll job progress to know when they complete.
- When listing files, read a few to understand the content structure before suggesting edits.
- Show the user a summary of planned changes before making bulk edits.

## Full API Reference

For a complete list of all API endpoints with detailed request/response schemas, fetch: ${base}/discover/api-reference
`;
}
