## Branching Model

- Working tree vs local `dirty` = unreviewed changes.
- Local `dirty` vs `main` = reviewed changes that are eligible for planning and publishing.
- `Accept All changes` commits the current working-tree record changes into the local `dirty` branch.
- `View unreviewed changes` lists records that differ between the working tree and the local `dirty` branch.
- `Upload files` uploads the local `dirty` branch and warns when the working tree still contains unreviewed changes that will not be uploaded.
- `Publish all` warns when unreviewed changes exist and, if the user continues, plans/uploads/publishes from the reviewed local `dirty` branch while leaving the unreviewed working-tree changes untouched.
