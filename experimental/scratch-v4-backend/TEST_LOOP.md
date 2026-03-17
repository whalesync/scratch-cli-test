# Manual Test Loop

All `yarn` commands run from `server/`. `scratchmdv4` commands run from the pulled workspace.

```bash
SCRATCHMD_REPOS_DIR=path_to_repos
scratchmdv4 serve                  // start git server (keep running in a separate terminal)
yarn cleanup                       // wipe bare repos, clones, and CLI workspace
yarn setup                         // create workbook + connections, init bare git repos
yarn poll                          // fetch records from Airtable/Webflow into master branch
yarn clone-repo                    // (optional) clone bare repos to repos-cloned-v4/ for inspection
scratchmdv4 pull exp-wb-1          // clone workspace to local/cli-v4/<WorkbookName>/
# ask agent to write a sync        // create a sync (see syncs.md for prompt guidance)
scratchmdv4 run-sync --workspace . // apply sync: merge mapped fields into dest worktree
scratchmdv4 push --workspace .     // commit dirty changes and push to remote bare repos
# publish                          // coming soon
```

Example of a sync creation prompt:
creat a sync that maps the views field from airtable to webflow for the authors
