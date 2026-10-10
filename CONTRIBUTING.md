# Contributing

This file covers the setup, the commands and the rules for changes to Mongo GUI. For how the code
is organised, read [docs/architecture.md](docs/architecture.md).

## Prerequisites

- Node.js 24 or later. The `.nvmrc` file pins 24.
- pnpm 12. The `packageManager` field in `package.json` pins the version.
- Docker. The integration tests and the end-to-end tests start MongoDB containers with
  Testcontainers.
- On Linux, a display for the end-to-end tests. CI uses `xvfb-run`.

Install the dependencies with the lockfile:

```sh
pnpm install --frozen-lockfile
```

On Linux, run `ulimit -s unlimited` in the shell before you run the gates. Run it in the same shell
session as the gate commands.

## Scripts

| Script                  | What it does                                                                                                  |
| ----------------------- | ------------------------------------------------------------------------------------------------------------- |
| `pnpm dev`              | Starts the Electron app with hot reload.                                                                      |
| `pnpm dev:ui`           | Serves the UI in a browser against the mock client. Add `?preset=unlocked` to start with fixture connections. |
| `pnpm storybook`        | Opens the component stories for `packages/ui`.                                                                |
| `pnpm build`            | Builds the main, preload and renderer bundles into `packages/app/out`.                                        |
| `pnpm dist`             | Builds unsigned installers for the current platform into `packages/app/release`.                              |
| `pnpm lint`             | Runs ESLint over the repository.                                                                              |
| `pnpm typecheck`        | Builds every TypeScript project reference with `tsc -b`.                                                      |
| `pnpm test`             | Runs the unit tests.                                                                                          |
| `pnpm test:integration` | Runs the integration tests against MongoDB 4.4, 6.0 and 8.0 in Docker.                                        |
| `pnpm test:e2e`         | Runs the Playwright tests against the Electron app.                                                           |
| `pnpm check`            | Runs lint, typecheck and unit tests, in that order.                                                           |
| `pnpm format`           | Rewrites files with Prettier.                                                                                 |
| `pnpm format:check`     | Reports files that Prettier would change.                                                                     |

## Gates

Run these before you open a pull request:

```sh
pnpm check
pnpm format:check
```

Run `pnpm test:integration` when you change the adapter, the shell runtime, the Docker package or
the router. Run `pnpm test:e2e` when you change the app shell, the preload bridge or the unlock flow.

Integration tests need Docker. They never bind port 27017 on your machine. Testcontainers maps the
container port to a random host port, so a local MongoDB server does not conflict with the tests.

## Coding standards

- Use strict TypeScript. Do not use `any` outside test fixtures.
- Use `unknown` and zod at every process boundary. Parse input from the renderer, the Docker
  Engine, the server and files before you use it.
- Prefer functions to classes. Use a class only where it owns state, such as the connection
  manager, the vault and the sampler.
- Every public function in `packages/core` and `packages/storage` has a unit test.
- Use named exports only. Do not add default exports.
- Report failures as `AppError` values with a code from the union in `packages/core`. The UI shows
  the message, and the detail is optional.
- Keep `packages/core` free of Node, Electron and driver imports. The lint rules enforce this.
- Do not add a native Node module. The app uses only what Node 24 includes.
- Never log a URI with a password, a password or document contents. Pass log values through the
  redaction helpers.

## Commit messages

The history uses conventional commits. Add the task id from the plan when the change belongs to one.
Use the scope for the area. Recent examples are these:

```
feat(P8-7b): change streams panel with live events, pause, filter and resume from token
fix(P2-3,P2-4): insert at the cursor, track a reassigned db, replace picked export paths
docs(P8-4b): refresh the diagnostics screenshot
chore(release): v0.1.0 version, changelog and release notes
```

Write the summary in the imperative mood and in lower case. Keep it under about 72 characters.
Explain the reason in the body when the change is not obvious.

## Pull requests

Open the pull request against `main`. Describe what changed and how you tested it. List the gates
you ran, and note any gate you did not run.
