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
- `pnpm dist` builds unsigned installers for the current platform into `packages/app/release`.

## Packaging and releases

`pnpm dist` builds the app and writes installers for the current platform to
`packages/app/release/`. It publishes nothing. Linux builds an AppImage and a `.deb`,
Windows builds an NSIS installer, and macOS builds a DMG and a ZIP for both x64 and arm64.

Releases come from CI. To release a version:

1. Bump `version` in `packages/app/package.json`, commit, and push.
2. Tag the commit and push the tag:

   ```sh
   git tag v0.1.0
   git push origin v0.1.0
   ```

The tag must match the version in `packages/app/package.json`. The `prepare` job stops the
release before any build starts if they differ.

The `prepare` job creates a draft GitHub Release for the tag. The builds on Ubuntu,
Windows and macOS then run in parallel and upload their installers to that draft. When all
three builds succeed, a final job marks the release public. If one build fails, the
release stays a draft, so users never see a partial set of files. Fix the failure and
re-run the failed job from the Actions page. The re-run adds its files to the same draft.

A manual run of the workflow from a branch builds the installers and keeps them as
workflow artifacts for seven days. A manual run from a tag ref behaves like a tag push: it
validates the version, publishes to the draft release, and marks it public.

The builds are unsigned for now. On Windows, SmartScreen shows "Windows protected your PC"
on the first run. Choose "More info", then "Run anyway". On macOS, the builds use ad-hoc
signing, which needs no certificate. Gatekeeper still refuses the first launch with a
"cannot verify the developer" dialog. Open System Settings, go to Privacy and Security,
and choose "Open Anyway". On Linux, no signature check applies. Run `chmod +x` on the
AppImage, or install the `.deb` with `apt install ./<file>.deb`.

Downloads appear on the [Releases page](https://github.com/eriksimonic/mongodb-mager/releases).
The app does not check for updates yet. Install each new version by hand until the
updater lands.

## Documentation

The architecture, security model and task plan are in [docs/PLAN.md](docs/PLAN.md).

## License

MIT. See [LICENSE](LICENSE).
