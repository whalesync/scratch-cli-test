# tools/github

Scripts for managing GitHub releases of the Scratch apps published under the
`whalesync` org (`scratch-desktop`, `scratch-cli`).

## Authentication

Every script in this directory hits the GitHub REST API and needs a token with
`repo` scope on the relevant repo. Pass it explicitly with `--token` or export
it as `GITHUB_TOKEN`:

```bash
export GITHUB_TOKEN=ghp_xxx
```

## Scripts

### `cleanup_stale_releases.py`

Lists (and optionally deletes) draft or prerelease GitHub releases that have
been sitting around longer than expected — usually the residue of a release
pipeline that failed mid-flight or a test build that nobody promoted.

Releases are matched by tag shape so a published prod release is never
considered:

- `--variant prod` → tags like `v1.2.3`
- `--variant test` → tags like `v1.2.3-test`

Default age threshold is 3 days for `test`, 7 days for `prod`; override with
`--days`.

Defaults to **dry-run**. Pass `--apply` to actually delete.

#### Examples

Preview stale test releases of the desktop app:

```bash
./cleanup_stale_releases.py --app desktop --variant test
```

Delete stale prod releases of the CLI:

```bash
./cleanup_stale_releases.py --app cli --variant prod --apply
```

Override the age threshold (e.g. anything older than 12 hours):

```bash
./cleanup_stale_releases.py --app desktop --variant test --days 0.5
```

Run with an explicit token instead of `$GITHUB_TOKEN`:

```bash
./cleanup_stale_releases.py --app cli --variant test --token ghp_xxx --apply
```
