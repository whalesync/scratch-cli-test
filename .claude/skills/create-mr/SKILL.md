---
name: create-mr
description: Create a GitLab merge request with AI-generated title and description, and open it in the browser.
user-invocable: true
allowed-tools: Bash(git:*), Bash(glab mr:*), Bash(glab auth status:*)
argument-hint: "[base-branch]"
---

# Create GitLab Merge Request

Create a GitLab MR for the current branch with an auto-generated title and change description, and open it in the browser.

## Steps

1. **Validate state**: Confirm the current branch is not the base branch (default: `master`, or the argument if provided). Abort with an error if on the base branch.

2. **Check glab authentication**: Run `glab auth status`. If it reports a `401 Unauthorized`, `No token found`, or otherwise fails to authenticate, do NOT attempt to create the MR (an unauthenticated `glab mr create` fails with a misleading `404 Not Found` on the project). Instead, stop and tell the user that glab is not authenticated and they need to run `glab auth login` (interactive) or `glab auth login --token <gitlab-PAT>` themselves, then ask you to retry. Only continue once `glab auth status` reports it is logged in.

3. **Get the diff**: Run `git diff origin/<base-branch>...HEAD` to get the full diff. Abort if there are no differences. DO NOT use a compount command like `cd directory && git ...`

4. **Get changed files**: Run `git diff --name-only origin/<base-branch>...HEAD`. DO NOT use a compount command like `cd directory && git ...`

5. **Get Linear issue**: If the user has the Linear MCP server available AND the branch name starts with a linear issue id such as `dev-10001`, use the MCP to lookup the linear issue to use for additional information for the description.

6. **Generate MR title**: Based on the changed files, generate a short MR title in the format `[tag] Short description`:
   - Use the top-level directory where most changes occurred:
     - `[server]`
     - `[client]`
     - `[terraform]`
     - for `/scratch-git-2` use the `[scratch-git]` tag
     - for `/scratch-desktop` use the `[desktop]` tag
   - If changes are mostly `.md` files, use `[docs]`
     - this may also be used as a secondary tag
   - If changes mostly involve gitlab yml files, use `[ci]`
   - Output ONLY the title string
   - You MAY use ONE secondary tag to further describe the change in these scenarios: 
     - secondary tags are added to the list with a comma, for example: `[server, tests]`
     - if the changes are mostly in the Scratch CLI add `cli` as a secondary tag
     - DO NOT format the tags like this `[server] [client]`
     - if the changes are mostly in a unit or integration test suite, add `tests` as a secondary tag
   - DO NOT add the Linear issue ID to the title unless there is nothing else to work with
   - Try to keep the title concise

7. **Generate change description**: Based on the full diff, write a 2-3 sentence summary in Markdown list format focusing on key changes and their purpose. Be concise and technical.

- IF there is a Linear issue related to the change, add a link to it in the **Motivation** section

8. **Create the MR body** using this template:

```
## Motivation

...

## Change description

<generated description>

## Checklists

- [ ] Security impact of change has been considered
- Data Incident Risk: 
    - [ ] None
    - [ ] Low
    - [ ] High


/assign me
/assign_reviewer me
```

9. **Create or find the MR**: Run `glab mr create --push -b <base-branch> -s <current-branch> -t "<title>" -d "<body>"`.
   - If the MR already exists, extract its number from `glab mr list --source-branch=<current-branch> --all`.
   - Otherwise extract the MR number from the creation output URL.

10. **Open in browser**: Derive the GitLab URL from `git config --get remote.origin.url` and run `open <url>/-/merge_requests/<mr-number>`.

11. **Report**: Print the MR number and URL to the user.
