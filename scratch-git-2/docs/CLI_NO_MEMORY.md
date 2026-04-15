# CLI No-Memory Plan

This note sketches a follow-up refactor for the CLI reconciliation code.

## Goal

Keep the current correctness model, but stop loading full file contents for every relevant path up front.

Instead:

- keep path inventories in memory
- keep Git object IDs in memory where available
- read file contents only for paths that actually need content comparison or 3-way merge

## Why This Is A Follow-up

The current in-memory model is simpler and easier to validate.
It makes upload, download, and working-tree rebasing easy to reason about and easy to test.

Once that behavior is fully trusted, we can optimize the implementation without changing the model.

## Proposed Shape

Introduce a small content resolver abstraction.

Conceptually, the reconciliation code should work with:

- a list of candidate paths
- metadata for each source, such as existence and object ID when known
- a callback or trait like `get_content(path, source)`

Where `source` is something like:

- `merge-base`
- `local-dirty`
- `remote-dirty`
- `working-tree`
- `scratch`

For tests, this resolver can be backed by in-memory maps.
For real CLI usage, it can read from Git trees or from the local filesystem on demand.

## Incremental Plan

1. Separate path discovery from content loading.
   Build the union of paths first, without requiring file bytes for every path.

2. Introduce a small source abstraction.
   A source should answer:
   - does this path exist?
   - what is its object ID if known?
   - load bytes for this path if needed

3. Change merge classification to prefer metadata first.
   If object IDs or file hashes prove two sides are equal, skip loading content.

4. Load bytes only for paths that actually need them.
   This mainly means:
   - text merges
   - byte comparisons when IDs are unavailable
   - materialization writes

5. Keep the existing tests, but run them through the resolver interface.
   Unit tests can stay fully in memory.

6. After parity is proven, optimize batch loading.
   Git blobs can still be fetched in batches, just for a smaller selected set of paths.

## Expected Benefit

This should reduce peak memory usage and unnecessary blob reads, especially for:

- large workspaces
- single-record publish flows
- download/upload runs where only a small subset of files actually changed

## Important Constraint

This refactor should not change the correctness model.
The 3-way merge rules and the five-state mental model should stay exactly the same.
