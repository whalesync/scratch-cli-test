# shared-types — CI/CD Integration

How `@spinner/shared-types` is published from this repo and consumed by `dusky` in the `whalesync` repo.

For local cross-repo iteration (without going through CI), see [LOCAL_DEV.md](./LOCAL_DEV.md).

## At a glance

- Two channels, one per long-lived branch:
  - **`test`** — published from spinner `master`. Versions look like `0.0.0-master-<sha>`.
  - **`prod`** — published from spinner `prod`. Versions look like `0.0.0-prod-<sha>`.
- `dusky` pins `"@spinner/shared-types": "test"` in `package.json`. Local dev, MR builds, and whalesync master/staging all resolve from the `test` channel.
- On whalesync's `prod` branch, CI rewrites the pin to `"prod"` before install, so production whalesync builds pull the `prod`-channel version.
- If a `shared-types` change breaks `dusky`, the whalesync pipeline fails. We accept this — the repos are tightly coupled and we'd rather find out at build time.

## How updates flow

### Test channel

1. PR merges to spinner `master` with a change under `packages/shared-types/`.
2. `publish shared-types (test)` runs: builds, rewrites the `0.0.0-dev` sentinel to `0.0.0-master-<sha>`, publishes to the spinner registry tagged `test`.
3. Next whalesync pipeline run resolves `test` to the new version. Whalesync master/staging deploys pick it up automatically.

### Prod channel

1. Promote spinner `master` → spinner `prod` (PR / fast-forward — your normal release process).
2. `publish shared-types (prod)` runs on the spinner `prod` pipeline: builds, rewrites the sentinel to `0.0.0-prod-<sha>`, publishes tagged `prod`.
3. Next whalesync `prod` pipeline run rewrites dusky's pin from `"test"` to `"prod"`, then installs. Whalesync production deploys pick it up.

There is no automated PR back to whalesync. Each whalesync build cycle surfaces any incompatibility on its own.

## What's where

### Spinner side

- **`packages/shared-types/package.json`** — publishable: not private, scoped `@spinner/shared-types`, `files: ["dist"]`, `sideEffects: false`, version is the sentinel `0.0.0-dev` (CI rewrites it per-publish; don't bump it by hand).
- **`gitlab-ci/stages/01-publish-shared-types.yml`** — two jobs (`test`, `prod`) sharing a `.publish-shared-types-base` template via `extends`. Each is gated on its own branch + non-MR + non-schedule, and only fires when `packages/shared-types/**` (or the job file) has changed. Authenticates with the built-in `CI_JOB_TOKEN`.
- **`.gitlab-ci.yml`** — includes the file above alongside the other stage files.

### Dusky side (in the `whalesync` repo)

- **`whalesync/.npmrc`** — maps the `@spinner` scope to the spinner project's GitLab npm registry and reads its auth token from `GITLAB_NPM_TOKEN`.
- **`dusky/package.json`** — pins `"@spinner/shared-types": "test"`.
- **`dusky/next.config.js`** — includes `@spinner/shared-types` in `transpilePackages` so Next.js compiles it through its own pipeline (avoids CJS/ESM interop errors).
- **`gitlab-ci/common.yml`** — `.dusky_shared_types_channel_override` rewrites the pin from `test` to `prod` on the `prod` branch before `yarn install`. Drops `--immutable` for prod since `package.json` is mutated.

### Auth tokens

- **Spinner CI** uses `CI_JOB_TOKEN` (automatic, no setup) to publish.
- **Whalesync CI** uses a CI/CD variable `GITLAB_NPM_TOKEN`. It's a group access token on the parent group containing both projects, role **Reporter** (Guest can't download packages), scope `read_api`. Set on whalesync as Masked, Unprotected (so it's available on feature-branch MR pipelines).
- **Local devs** need a personal access token with `read_api` scope, exported as `GITLAB_NPM_TOKEN` in `~/.zshenv`. See [whalesync/docs/shared-types-setup.md](https://gitlab.com/whalesync/whalesync/-/blob/master/docs/shared-types-setup.md).

## Pinning to a specific version

If you need to temporarily pin dusky to an explicit version (e.g. while preparing a coordinated change or pinning prod to an older test version), swap the tag for a SHA-version in `dusky/package.json`:

```json
"@spinner/shared-types": "0.0.0-master-a1b2c3d4"
```

All published versions are visible in the spinner project under **Packages and registries → Package Registry**. Pinning bypasses both channels — make sure to revert to `"test"` before merging back to master.

## Operations

- **Yanking a bad version**: delete the version via the GitLab UI (Packages → Package Registry → version → Delete), then push a fix to the relevant branch (master for `test`, prod for `prod`) to publish a new tag.
- **Storage**: GitLab keeps every published version. Since we publish per-commit-that-touches-shared-types on both branches, this accumulates. Configure a cleanup policy in the spinner project's Package Registry settings (e.g. keep last 50 versions per tag) if/when the list gets noisy.
- **Tag mutability**: `test` and `prod` are dist-tags and therefore mutable. Two consecutive whalesync builds on the same branch can resolve to different versions if a spinner publish landed in between. This is the trade-off for low-friction publishing. For reproducible builds at a specific moment, pin (see above).
- **No `latest` tag**: we deliberately don't use `latest`, so `yarn add @spinner/shared-types` without a tag will fail with "no matching version." Always specify `@test` or `@prod`.
