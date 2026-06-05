# shared-types — Local Development

This package is consumed in two places:

- **Inside this repo** (`spinner`) by `client` and `server` via the Yarn workspace at `packages/shared-types`. Nothing special — `yarn dev` from the repo root runs `tsc --watch` and the workspace packages see updates instantly.
- **Outside this repo** by `dusky` in the `whalesync` repo, which installs `@spinner/shared-types` from the GitLab Package Registry. See [CICD.md](./CICD.md) for how that's published.

This doc covers the second case: how to iterate on `shared-types` and a `dusky` consumer at the same time without round-tripping through CI.

## The 99% case: don't co-develop

Most of the time, you're only touching one side:

- Working in `spinner`? Just edit `shared-types` and rely on workspace resolution. When you push to master, CI publishes a new version (see [CICD.md](./CICD.md)) and the next `dusky` build picks it up automatically because dusky pins `latest`.
- Working in `dusky`? `yarn install` already pulled the latest published `@spinner/shared-types`. Edit dusky, ignore spinner.

The flow below is only needed when a single change has to land in both repos in lockstep — e.g. you're adding a new exported type in `shared-types` AND using it in `dusky` in the same afternoon.

## Co-development with `yarn link`

```bash
# In the spinner repo — register the package globally
cd ~/spinner/packages/shared-types
yarn link

# In the dusky repo — point its node_modules at your local copy
cd ~/whalesync/dusky
yarn link @spinner/shared-types

# Keep tsc running in spinner so dist/ rebuilds on every save
cd ~/spinner
yarn dev   # runs tsc --watch on shared-types alongside client/server

# Run dusky as usual
cd ~/whalesync/dusky
yarn dev
```

Edits in `~/spinner/packages/shared-types/src/**` will recompile to `dist/`, and the next time Next.js rebuilds (or you hot-reload) dusky picks them up.

### When you're done

Always undo the link before you stop, otherwise dusky will stay pointed at a local checkout that may drift:

```bash
cd ~/whalesync/dusky
yarn unlink @spinner/shared-types
yarn install   # restores the published version from the registry
```

## Next.js gotcha

`dusky/next.config.js` should include `@spinner/shared-types` in `transpilePackages`:

```js
module.exports = {
  // ...
  transpilePackages: ['@spinner/shared-types'],
};
```

This is needed for both the linked-local case and the normal installed-from-registry case — it tells Next.js to run the package through its build pipeline rather than expecting it to be pre-built ESM. Without it you may see "Cannot use import statement outside a module" or similar CJS/ESM interop errors.

## `reflect-metadata` reminder

`shared-types` depends on `class-transformer` / `class-validator`, which need `reflect-metadata` imported **exactly once** at app entry for decorators to work. The package itself does `import 'reflect-metadata'` at the top of `src/index.ts`, so as long as dusky imports anything from `@spinner/shared-types` early in its bootstrap, decorators will function. If you see "Reflect.getMetadata is not a function" or decorators silently no-op, that's the culprit.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| Dusky doesn't see my latest changes after editing in spinner | Make sure `yarn dev` is running in spinner so `dist/` rebuilds. The link points at `dist/`, not `src/`. |
| Dusky errors with "Module not found: @spinner/shared-types" after `yarn install` | You forgot to `yarn unlink` before installing. Run `yarn unlink @spinner/shared-types` in dusky, then `yarn install`. |
| TypeScript types don't match runtime behavior in dusky | `dist/` is stale. Delete `~/spinner/packages/shared-types/dist` and re-run `yarn build`. |
| Next.js build fails with CJS/ESM errors | Confirm `transpilePackages: ['@spinner/shared-types']` is set in `dusky/next.config.js`. |
