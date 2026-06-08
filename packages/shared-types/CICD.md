# shared-types — CI/CD Integration

How `@spinner/shared-types` is published from this repo and consumed by `dusky` in the `whalesync` repo.

For local cross-repo iteration (without going through CI), see [LOCAL_DEV.md](./LOCAL_DEV.md).

## At a glance

- One channel: spinner `master` publishes `0.0.0-master-<sha>`, tagged `latest`.
- `dusky` pins `"@spinner/shared-types": "latest"` in `package.json`. Local dev, MR builds, and all whalesync branches resolve from the same `latest` channel.
- If a `shared-types` change breaks `dusky`, the whalesync pipeline fails. We accept this — the repos are tightly coupled and we'd rather find out at build time.

## How updates flow

1. PR merges to spinner `master` with a change under `packages/shared-types/`.
2. `publish shared-types` runs: builds, rewrites the `0.0.0-dev` sentinel to `0.0.0-master-<sha>`, publishes to the spinner registry tagged `latest`.
3. Next whalesync pipeline run resolves `latest` to the new version. Whalesync deploys pick it up automatically.

There is no automated PR back to whalesync. Each whalesync build cycle surfaces any incompatibility on its own.

## What's where

### Spinner side

- **`packages/shared-types/package.json`** — publishable: not private, scoped `@spinner/shared-types`, `files: ["dist"]`, `sideEffects: false`, version is the sentinel `0.0.0-dev` (CI rewrites it per-publish; don't bump it by hand).
- **`gitlab-ci/stages/01-publish-shared-types.yml`** — one job (`publish shared-types`), gated on `master` + non-MR + non-schedule, firing only when `packages/shared-types/**` (or the job file) has changed. Authenticates with the built-in `CI_JOB_TOKEN`.
- **`.gitlab-ci.yml`** — includes the file above alongside the other stage files.

### Dusky side (in the `whalesync` repo)

- **`whalesync/.npmrc`** — maps the `@spinner` scope to the spinner project's GitLab npm registry and reads its auth token from `GITLAB_NPM_TOKEN`.
- **`dusky/package.json`** — pins `"@spinner/shared-types": "latest"`.
- **`dusky/next.config.js`** — includes `@spinner/shared-types` in `transpilePackages` so Next.js compiles it through its own pipeline (avoids CJS/ESM interop errors).

### Auth tokens

- **Spinner CI** uses `CI_JOB_TOKEN` (automatic, no setup) to publish.
- **Whalesync CI** uses a CI/CD variable `GITLAB_NPM_TOKEN`. It's a group access token on the parent group containing both projects, role **Reporter** (Guest can't download packages), scope `read_api`. Set on whalesync as Masked, Unprotected (so it's available on feature-branch MR pipelines).
- **Local devs** need a personal access token with `read_api` scope, exported as `GITLAB_NPM_TOKEN` in `~/.zshenv`. See [whalesync/docs/shared-types-setup.md](https://gitlab.com/whalesync/whalesync/-/blob/master/docs/shared-types-setup.md).

## Pinning to a specific version

If you need to temporarily pin dusky to an explicit version (e.g. while preparing a coordinated change or holding back from a broken publish), swap the tag for a SHA-version in `dusky/package.json`:

```json
"@spinner/shared-types": "0.0.0-master-a1b2c3d4"
```

All published versions are visible in the spinner project under **Packages and registries → Package Registry**. Pinning bypasses the `latest` channel — make sure to revert to `"latest"` before merging back to master.

## Operations

- **Yanking a bad version**: delete the version via the GitLab UI (Packages → Package Registry → version → Delete), then push a fix to `master` to publish a new `latest`.
- **Storage**: GitLab keeps every published version. Since we publish per-commit-that-touches-shared-types, this accumulates. Configure a cleanup policy in the spinner project's Package Registry settings (e.g. keep last 50 versions) if/when the list gets noisy.
- **Tag mutability**: `latest` is a dist-tag and therefore mutable. Two consecutive whalesync builds can resolve to different versions if a spinner publish landed in between. This is the trade-off for low-friction publishing. For reproducible builds at a specific moment, pin (see above).
