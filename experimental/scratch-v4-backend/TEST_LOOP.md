# Manual Test Loop

All `yarn` commands run from `server/`. `scratchmdv4` commands run from anywhere inside the pulled workspace.

```bash
scratchmdv4 serve                  // start git server (keep running in a separate terminal)
yarn test:reset                    // clean + setup + poll + clone-repo (or run steps individually)
scratchmdv4 pullexp-wb-1           // clone workspace to local/cli-v4/<WorkbookName>/
# ask agent to write a sync        // create a sync (see syncs.md for prompt guidance)
scratchmdv4 run-sync               // apply sync: merge mapped fields into dest worktree
scratchmdv4 push                   // commit dirty changes and push to remote bare repos
# publish                          // coming soon
```

Individual steps: `yarn test:clean` · `yarn test:setup` · `yarn test:poll` · `yarn test:clone`
