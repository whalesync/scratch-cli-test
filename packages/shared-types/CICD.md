# shared-types — CI/CD Integration

How `@spinner/shared-types` is published from this repo and consumed by `dusky` in the `whalesync` repo.

For local cross-repo iteration (without going through CI), see [LOCAL_DEV.md](./LOCAL_DEV.md).

## At a glance

- Every push to `spinner` master that touches `packages/shared-types/**` publishes a new version of `@spinner/shared-types` to the **spinner project's GitLab Package Registry**.
- The published version is `0.0.0-master-<short-sha>` and is also tagged `latest`.
- `dusky` pins `"@spinner/shared-types": "latest"`, so the next `dusky` build after a publish picks up the new code.
- If a `shared-types` change breaks `dusky`, the whalesync pipeline fails. We accept this — the repos are tightly coupled and we'd rather find out at build time than carry a manual upgrade burden.

## How updates flow

1. PR merges to spinner master with a change under `packages/shared-types/`.
2. The `publish shared-types` job runs in the spinner pipeline. It builds the package, rewrites the `0.0.0-dev` sentinel version in `package.json` to `0.0.0-master-<short-sha>`, and publishes to the spinner project's registry tagged `latest`.
3. The next whalesync pipeline run (PR build, scheduled build, or manual) runs `yarn install` in `dusky`, which resolves `latest` to the new version.
4. If the new types are compatible with `dusky`, the build passes. If not, the build fails — fix dusky, push, re-run.

There is no automated PR back to whalesync. We rely on the next whalesync build cycle to surface breaks.

## What's where

### Spinner side

- **`packages/shared-types/package.json`** — publishable: not private, scoped `@spinner/shared-types`, `files: ["dist"]`, `sideEffects: false`, version is the sentinel `0.0.0-dev` (CI rewrites it per-publish; don't bump it by hand).
- **`gitlab-ci/stages/01-publish-shared-types.yml`** — the publish job. Gated on master + non-MR + non-schedule, and only fires when files under `packages/shared-types/**` (or the job itself) have changed. Authenticates to the registry with the built-in `CI_JOB_TOKEN` — no secrets to manage.
- **`.gitlab-ci.yml`** — includes the file above alongside the other stage files, under the same `RELEASE_*_ONLY` skip rule.

### Dusky side (in the `whalesync` repo)

- **`dusky/.npmrc`** — maps the `@spinner` scope to the spinner project's GitLab npm registry and reads its auth token from `GITLAB_NPM_TOKEN`.
- **`dusky/package.json`** — has `"@spinner/shared-types": "latest"`.
- **`dusky/next.config.js`** — includes `@spinner/shared-types` in `transpilePackages` so Next.js compiles it through its own pipeline (avoids CJS/ESM interop errors).

### Auth tokens

- **Spinner CI** uses `CI_JOB_TOKEN` (automatic, no setup) to publish.
- **Whalesync CI** uses a CI/CD variable `GITLAB_NPM_TOKEN` to install. It's a group deploy token with `read_package_registry` scope, set on the whalesync project as Masked + Protected.
- **Local devs** need a personal access token with `read_api` scope in their `~/.npmrc` to install dusky locally:
  ```
  //gitlab.com/api/v4/projects/<SPINNER_PROJECT_ID>/packages/npm/:_authToken=<your-PAT>
  ```

## Pinning to a specific version

If you need to temporarily pin dusky to an older `shared-types` (e.g. while preparing a coordinated change), swap `latest` for a SHA-version in `dusky/package.json`:

```json
"@spinner/shared-types": "0.0.0-master-a1b2c3d4"
```

All published versions are visible in the spinner project under **Packages and registries → Package Registry**.

## Operations

- **Yanking a bad version**: delete the version via the GitLab UI (Packages → Package Registry → version → Delete), then push a fix to spinner master to publish a new `latest`.
- **Storage**: GitLab keeps every published version. Since we publish per-master-commit-that-touches-shared-types, this accumulates over time. If it ever matters, configure a cleanup policy in the spinner project's Package Registry settings (e.g. keep last 50 versions).
- **`latest` is mutable**, so two consecutive `yarn install` runs in dusky can resolve to different versions. This is the trade-off for low-friction publishing. For reproducible builds at a specific moment, pin (see above).
