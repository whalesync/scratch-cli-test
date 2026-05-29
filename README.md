# Scratch

Welcome to Scratch: an AI-powered editor for marketers. For more information regarding what the product is and who it's for, see the [one-pager](./one-pager.md).

# Project Structure

The Scratch project consists of 3 elements:

## 1. API Server (`/server`)

- NestJS application serving as the main backend
- Provides data functionality via REST API
- Modelled after the Whalesync Bottlenose server
- Runs locally on port 3010

Full [Documentation](./server/README.md)

## 2. Content Editor Client (`/client`)

- The AI powered content editor
- Next.js / React / Mantine
- Thin client that mainly interacts with the server
- Runs locally on port 3000

Full [Documentation](./client/README.md)

**Client-Specific Rules**: See [`client/.clauderules`](./client/.clauderules) for mandatory UI coding standards

## Development with Turborepo

This monorepo uses [Turborepo](https://turbo.build/) for unified build and dev orchestration across all packages. Run these commands from the **root directory**:

```bash
# Start all dev servers (client, server, shared-types watch)
yarn dev

# Build all packages with caching and correct dependency ordering
yarn build

# Run database migrations
yarn migrate

# Run linting across all packages
yarn lint

# Reformat code across all packages
yarn format

# Run tests across all packages
yarn test
yarn test:integration
```

**Key benefits:**

- **Dependency ordering**: Packages build in the correct order (e.g., `shared-types` builds before `server`)
- **Caching**: Build outputs are cached, so unchanged packages skip rebuilding
- **Parallel execution**: Independent tasks run in parallel for faster builds

**Workspaces included:**

- `client/` - Next.js web app
- `server/` - NestJS API server
- `scratch-git-2/` - Rust git microservice (ports 3100 API + 3101 HTTP backend)
- `packages/*` - Shared packages (e.g., `shared-types`)

You can still run commands in individual packages (e.g., `cd server && yarn test`), but the root commands are recommended for full-stack development.

### UI Component System

The client uses a standardized UI component library built on Mantine. **All developers and AI agents must follow the UI system guidelines** to maintain design consistency.

- 📚 **[UI System Guide](./client/src/app/components/UI_SYSTEM.md)** - Complete documentation for AI agents and developers
- 🎨 [**Component Gallery**](https://test.scratch.md/dev/gallery) - Visual reference for UI components and patterns

**Key Rules:**

- Use base components from `@/components/base/` instead of raw Mantine components
- Use semantic CSS variables for colors (`var(--fg-primary)`, `var(--bg-base)`)
- Always wrap Lucide icons with `StyledLucideIcon`
- Never use inline styles or hardcoded colors

# Devops Play Books

## Deployments

The client and server are automatically deployed to GCP from the `prod` branch.

A scheduled pipeline in Gitlab triggers the deployment by merging the current state of `master` into `prod`. The deployment happens ever day at 9:30 am PST, but can also be triggered manually.

[Gitlab Pipeline Schedules](https://gitlab.com/whalesync/spinner/-/pipeline_schedules)

### Manual Deployments

To manually trigger a new deployment, you must have **Maintainer** permissions on the repository. Then you need to do a merge from `master` to `prod` and push changes. First make sure your `master` and `prod` branches are up to date, then from the `prod` branch create a merge with the comment included below.

```bash
git checkout master
git pull
git checkout prod
git pull origin prod
git merge -m "(Auto) Merge branch 'master' into prod" --no-ff -X theirs master
git push origin prod
git checkout master
```

Once done, make sure to leave the `prod` branch immediately to avoid accidently branching from it or pushing new changes. The `prod` branch **must** always be equal or behind the `master` branch.

## Upgrading Node

Upgrading to a new version of Node.js requires several steps.

1. Update the CI/CD image used to builds in Gitlab

- This image is managed in the [whalesync Gitlab project](https://gitlab.com/whalesync/whalesync)
- Open the `Dockerfile` in the root of the 'whalesync' project and update the list of `nvm installs`:

```bash
# NOTE: Remove an older version after you add a new version.
RUN nvm install -b 22.19.0
RUN nvm install -b 22.20.0
RUN nvm install -b 22.22.0
```

- Remove the oldest version and add the new version at the end
- Create an MR and merge it. The Whalesync pipeline will generate a new docker image
- This takes ~30 minutes to build and deploy to Docker hub
- You can find the new image on [Docker Hub](https://hub.docker.com/r/unawareguitar/leaning-basket)

2. Update Gitlab pipeline to use the new image

[common.yml](gitlab-ci/common.yml) pins `unawareguitar/leaning-basket:latest`, so once the new image lands in Docker Hub the next pipeline picks it up automatically — no edit needed here.

3. Update `.nvmrc` files

Set the Node version in all the `.nvmrc` files in the project

4. Update `Dockerfile.monorepo` files

The client and server Docker files define the Node version used to build the application images

You need to update all of the `node:22.22.0-alpine` references to use the update Node version.

5. Update module `package.json` for the server project

Set the new version in the engines property:

```JSON
  "engines": {
    "node": "22.22.0"
  },
```

6. Test local builds

- Run `yarn install` and `yarn build` for both the client and server
