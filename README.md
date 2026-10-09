# Mongo GUI

Mongo GUI is a desktop client for MongoDB. It runs mongosh-compatible queries in an
editor, shows results in a grid, and will draw explain plans, indexes, live monitoring
and the profiler. It runs on Linux, Windows and macOS and is released under the MIT
license.

Everything the app stores on disk (saved connections, query history, favourites,
settings) is encrypted with a key derived from a master password you type at launch.
See the security section of [docs/PLAN.md](docs/PLAN.md).

## Screenshots

Current state of the app. The set grows as screens land and gets a final refresh at
release.

| Unlock                                        | Shell                                                                            |
| --------------------------------------------- | -------------------------------------------------------------------------------- |
| ![Unlock screen](docs/screenshots/unlock.png) | ![Shell with connections, welcome and output panels](docs/screenshots/shell.png) |

| Connection tree                                                                                  | Connection dialog                                                             |
| ------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------- |
| ![Connection tree with databases and collections expanded](docs/screenshots/connection-tree.png) | ![New connection dialog in form mode](docs/screenshots/connection-dialog.png) |

| Docker node in the connection tree                                                |
| --------------------------------------------------------------------------------- |
| ![Docker node listing local MongoDB containers](docs/screenshots/docker-tree.png) |

## Prerequisites

- Node.js 24 (see `.nvmrc`)
- pnpm 12

## Scripts

- `pnpm install` installs dependencies.
- `pnpm dev` starts the Electron app with hot reload (electron-vite in `packages/app`).
- `pnpm dev:ui` serves the UI in a browser against an in-memory mock backend. Add `?preset=unlocked` to the URL to start with fixture connections.
- `pnpm build` builds the Electron main, preload and renderer bundles into `packages/app/out`.
- `pnpm lint` runs ESLint over the repository.
- `pnpm typecheck` builds all TypeScript project references with `tsc -b`.
- `pnpm test` runs the unit tests.
- `pnpm test:integration` runs the integration tests against MongoDB 4.4, 6.0 and 8.0 in Docker through Testcontainers.
- `pnpm check` runs lint, typecheck and unit tests in that order.
- `pnpm storybook` opens the component stories for `packages/ui`.
- `pnpm format` rewrites files with Prettier. `pnpm format:check` only reports them.

## Documentation

The architecture, security model and task plan are in [docs/PLAN.md](docs/PLAN.md).

## License

MIT. See [LICENSE](LICENSE).
