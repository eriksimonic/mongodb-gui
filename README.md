# Mongo GUI

Mongo GUI is a desktop client for MongoDB. It runs mongosh-compatible queries in an
editor, shows results in a grid, and will draw explain plans, indexes, live monitoring
and the profiler. It runs on Linux, Windows and macOS and is released under the MIT
license.

This repository holds the pnpm workspace skeleton. It contains six packages under
`packages/`, the lint and test gates, and the import boundary rules between packages.

## Prerequisites

- Node.js 24 (see `.nvmrc`)
- pnpm 12

## Scripts

- `pnpm install` installs dependencies.
- `pnpm dev` starts the Electron app with hot reload (electron-vite in `packages/app`).
- `pnpm dev:ui` serves the UI in a browser. Electron APIs are absent there, so the ping button reports that it is not available.
- `pnpm build` builds the Electron main, preload and renderer bundles into `packages/app/out`.
- `pnpm lint` runs ESLint over the repository.
- `pnpm typecheck` builds all TypeScript project references with `tsc -b`.
- `pnpm test` runs the unit tests.
- `pnpm test:integration` runs the integration tests. There are none yet.
- `pnpm check` runs lint, typecheck and unit tests in that order.
- `pnpm format` rewrites files with Prettier. `pnpm format:check` only reports them.

## Documentation

The architecture, security model and task plan are in [docs/PLAN.md](docs/PLAN.md).

## License

MIT. See [LICENSE](LICENSE).
