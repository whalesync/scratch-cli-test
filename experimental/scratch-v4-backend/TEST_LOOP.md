# Manual Test Loop

## First-time setup

Build the Rust binary and symlink it into your PATH (re-run after code changes):

```bash
cd experimental/scratch-v4-backend/scratch-git
cargo build --release
sudo ln -sf "$(pwd)/target/release/scratchmdv4" /usr/local/bin/scratchmdv4
```

---

## Test loop

All `yarn` commands run from `server/`. `scratchmdv4` commands run from anywhere inside the pulled workspace.

```bash
scratchmdv4 serve                  // start git server (keep running in a separate terminal)
yarn test:reset                    // clean + setup + poll + clone-repo (or run steps individually)
scratchmdv4 pull exp-wb-1          // clone workspace to local/cli-v4/<WorkbookName>/
# ask agent to write a sync        // create a sync (see syncs.md for prompt guidance)
scratchmdv4 run-sync               // apply sync: merge mapped fields into dest worktree
scratchmdv4 push                   // commit dirty changes and push to remote bare repos
# publish                          // coming soon
```

Individual steps: `yarn test:clean` · `yarn test:setup` · `yarn test:poll` · `yarn test:clone`
