# Architecture

This document is for contributors. It describes how the code is split, how a call travels from
the UI to the MongoDB driver, and how the tests are organised. [security.md](security.md) covers
the threat model and the encryption design. This document describes the code as it ships.

## Decisions

- TypeScript throughout. Electron 44 runs the app, with the Node 24 bundled in it. The UI is React
  with Mantine, dockview and Monaco. The result grid is AG Grid Community.
- Native Node modules are not used. SQLite comes from `node:sqlite`, and AES and scrypt come from
  `node:crypto`. The build has no `electron-rebuild` step and no per-platform binaries.
- Queries run through the official mongosh runtime packages (Apache 2.0), in a utility process per
  connection. A runaway script or driver crash ends only that process.
- The master password is the root of the key hierarchy. Device mode, which wraps the data key with
  Electron `safeStorage`, is a choice the user makes on first run or in Settings.
- The renderer runs with `contextIsolation: true`, `nodeIntegration: false` and `sandbox: true`,
  under a strict CSP. The preload exposes only the RPC client.
- The project is licensed under Apache 2.0 with the Commons Clause. MongoDB 4.4 and newer are
  supported.

## Processes

The app runs three kinds of process.

| Process                           | Code                                                      | Role                                                                                                                                      |
| --------------------------------- | --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Main (Electron)                   | `packages/app/src/main`                                   | Owns the window, the encrypted store, the vault, the Docker and update services, and the RPC router. It never imports the MongoDB driver. |
| Renderer                          | `packages/ui/src`, bundled by `packages/app/src/renderer` | React screens. It talks to the main process only through the preload bridge.                                                              |
| Utility (one per open connection) | `packages/shell-runtime`, built to `shell-runtime.cjs`    | Runs the mongosh runtime and the MongoDB driver for one connection.                                                                       |

The preload script, `packages/app/src/preload/index.ts`, exposes one object, `mongoGui`, through
`contextBridge`. The bridge carries calls over `rpc:invoke` and events over `rpc:event`. The
channel names are in `packages/core/src/rpc/channels.ts`.

The main process supervises the utility processes in `packages/app/src/main/shell/supervisor.ts`.
It forks them with `utilityProcess.fork` in `packages/app/src/main/shell/utility-fork.ts`. A crash
restarts the process up to three times within 60 seconds. Disconnecting kills the process after a
short grace period. The main process talks to a utility process over a MessagePort, never through
the driver.

## Packages

| Package                  | Depends on          | May import                                | Purpose                                                                                                                                                                          |
| ------------------------ | ------------------- | ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/core`          | nothing             | `zod` only                                | Domain types, the RPC contract, the explain normaliser, the T-SQL to mongosh translator and pure helpers.                                                                        |
| `packages/mongo-adapter` | core                | `mongodb`, `bson`                         | Everything that touches the driver: connect, catalogue, indexes, explain, monitor, profiler, security, sharding, replication, diagnostics, GridFS, change streams and transfers. |
| `packages/shell-runtime` | core, mongo-adapter | `@mongosh/*`                              | Hosts the mongosh evaluator in the utility process. It also runs as a plain child process in tests.                                                                              |
| `packages/storage`       | core                | `node:sqlite`, `node:crypto`              | The vault (key derivation and wrapping), the encrypted store and its repositories.                                                                                               |
| `packages/docker`        | core                | Node built-ins                            | Talks to the Docker Engine over its socket and manages the forwarder containers.                                                                                                 |
| `packages/ui`            | core                | React, Mantine, dockview, Monaco, AG Grid | Every screen. It talks to an RPC client and ships a mock client for browser development and tests.                                                                               |
| `packages/app`           | all                 | Electron                                  | The main process, the preload script, the renderer entry, the RPC router and the updater.                                                                                        |

The import rules are enforced in `eslint.config.js`. Each package has a `no-restricted-imports`
rule. For example, `core` may not import `electron`, `mongodb`, `bson`, `react` or a Node built-in.
`tests/boundaries.test.ts` checks the packages against the boundary table in
`tests/support/boundaries.ts`.

The T-SQL translator lives in `packages/core/src/sql`. It takes SQL text and an optional field-type
lookup, and it returns mongosh text without touching a database. [sql.md](sql.md) describes the
supported subset and the refusals.

## The RPC contract

`packages/core/src/rpc/contract.ts` declares every call as a pair of zod schemas. The `rpcContract`
object groups the calls by namespace: `vault`, `generate`, `connections`, `databases`, `catalog`,
`collections`, `shell`, `explain`, `management`, `security`, `sharding`, `replication`,
`diagnostics`, `schema`, `settings`, `monitor`, `history`, `favourites`, `profiler`, `changes`,
`docker`, `gridfs`, `transfer`, `updates`, `layout`, `app`, `backup`, `savedBackups`,
`savedRestores` and `tools`.

`defineCall` in `packages/core/src/rpc/define.ts` builds one call from an input schema and an output
schema. Each side validates with these schemas. The main process validates the input before it runs
the handler. The renderer validates the output.

Events go the other way. `packages/core/src/schemas/events.ts` lists the event types, such as
`connection:status`, `shell:print`, `profiler:entries`, `changes:event`, `monitor:sample` and
`transfer:progress`.

BSON crosses the IPC boundary as canonical EJSON, so ObjectId, Decimal128, Long, dates and binary
survive intact. The helpers are in `packages/mongo-adapter/src/ejson.ts`. The UI shows each typed
value with its BSON type badge.

`packages/ui/src/api/mock-rpc-client.ts` assembles the mock client that `pnpm dev:ui`, Storybook
and the UI tests use. The preload bridge carries the real client.

## Query lifecycle

1. Ctrl+Enter in the editor calls `shell.evaluate` with the connection id, the database and the code.
2. The main process forwards the call to the connection's utility process.
3. `shell-runtime` evaluates the code with the mongosh runtime. The runtime keeps the cursor and
   returns the first batch as EJSON documents. A document that arrived only as a preview is
   fetched in full with `shell.readDocument`.
4. The results view pulls more batches with `shell.next`.
5. `shell.cancel` closes the cursor. `shell.releaseResult` frees a result the UI no longer shows.

Explain uses the `explain` namespace. It runs the statement through the connection's runtime or
driver. `core` normalises the raw plan. Explain writes nothing.

## Adding a call end to end

This example adds a call that returns the number of documents in a collection.

1. Add the input and output schemas to `packages/core/src/<area>/types.ts` or
   `packages/core/src/<area>/rpc-schemas.ts`. Export the inferred types. Keep the schemas strict.
2. Add the call to the namespace in `packages/core/src/rpc/contract.ts`, with `defineCall(input,
output)`. Add a test to `packages/core/src/rpc/contract.test.ts` if the call needs one.
3. If the call touches the driver, add the function to `packages/mongo-adapter/src/<area>/`. Export
   it from that folder's `index.ts`. Add an integration test beside it, named
   `<name>.integration.test.ts`.
4. Wire the call in `packages/app/src/main/rpc/router.ts`. Add an `entry('<ns>.<call>',
rpcContract.<ns>.<call>, handler)` line in the operations table. Errors are `AppError` values.
   Driver errors pass through `mapDriverError` in `packages/mongo-adapter/src/errors.ts`.
5. Add a unit test for the handler. The existing router tests show the pattern, for example
   `packages/app/src/main/rpc/router.updates.test.ts`.
6. Add the call to the dev mock in `packages/ui/src/api/mock-<area>.ts`. The mock client is
   assembled in `packages/ui/src/api/mock-rpc-client.ts`. Then the UI runs in a browser with
   `pnpm dev:ui`.
7. Call it from the UI through `useUiApi()` in `packages/ui/src/api/ui-api.ts`, or from a store in
   `packages/ui/src/state`. Add a story or a component test for the screen.
8. Run the gates. See [CONTRIBUTING.md](../CONTRIBUTING.md).

Long-running work follows the same pattern. A call starts it, such as `changes.start`. The main
process reports progress through events, such as `changes:event`. Another call stops it, such as
`changes.stop`.

## Renderer reset rule

The main process forgets the renderer's subscriptions and picks when the renderer goes away. It
calls `resetRenderer()` in `packages/app/src/main/rpc/router.ts` when:

- The main frame starts a navigation that is not in place. A reload is one such navigation.
- The render process exits.
- The window closes.

`resetRenderer()` clears the save paths, folder picks and opened files that the file dialogs
recorded. It then runs the listeners in `packages/app/src/main/rpc/router.ts`. These listeners clear
the replication plans, stop the profiler tails, stop the change streams, stop the monitor samplers,
cancel the transfers and stop the runtime processes. A new feature that holds state in the main
process for a page must register a listener with `onRendererReset`, or a reload leaves that state
behind.

Locking the app also disconnects every connection. Quitting locks first, then closes the store.

## Storage layer

`packages/storage` has three parts.

- `packages/storage/src/vault/vault.ts` holds the data key in memory. In password mode it also
  derives the key encryption key from the master password. It wraps and unwraps the data key with
  the keyring in `vault/keyring.ts`. The keyring has two versions. Version 1 wraps the data key
  under a password-derived key. Version 2 wraps it with a device key provider. The app implements
  that provider on Electron `safeStorage` in `packages/app/src/main/device-key.ts` and injects it
  through `VaultOptions.deviceKey`. The vault clears the key on lock. It locks after the idle
  timeout, which defaults to 30 minutes, in password mode only.
- `packages/storage/src/crypto` holds the scrypt derivation in `kdf.ts` and the AES-256-GCM
  seal and open in `aead.ts`. The additional data for each row is `table:id`.
- `packages/storage/src/store` holds `encrypted-store.ts` and the repositories for connections,
  history, favourites, settings and layout. `migrations.ts` holds the schema versions. Add a new
  migration for each schema change.

One setting lives outside the vault. `startup.json` in the app data folder holds options that
Electron reads before the vault can open, such as `disableGpu`. It holds no secrets.
`packages/app/src/main/startup-settings.ts` reads and writes it, and the `app.getStartupSettings`,
`app.setStartupSettings` and `app.restart` calls expose it to the Settings screen.

Repositories encrypt each payload before they write it, and they decrypt it after they read it.
They never store plaintext in a content column. See [security.md](security.md) for the columns.

## Testing layers

| Layer       | Tool and location                                                     | Runs in                 |
| ----------- | --------------------------------------------------------------------- | ----------------------- |
| Unit        | Vitest, `packages/*/src/**/*.test.{ts,tsx}` and `tests/**/*.test.ts`  | `pnpm test`             |
| Component   | Vitest with Testing Library, against the mock client                  | `pnpm test`             |
| Integration | Vitest with Testcontainers, `packages/*/src/**/*.integration.test.ts` | `pnpm test:integration` |
| End to end  | Playwright against the built Electron app, `e2e/tests`                | `pnpm test:e2e`         |
| Stories     | Storybook, `packages/ui/.storybook` and the `*.stories.tsx` files     | `pnpm storybook`        |
| Boundaries  | Vitest, `tests/boundaries.test.ts`                                    | `pnpm test`             |

The unit project is named `unit` in `vitest.config.ts`. It excludes the integration files. The
integration project builds the shell runtime bundles in its global setup before it runs.

The integration tests start MongoDB containers with Testcontainers. The helpers are in
`packages/mongo-adapter/src/test`. They cover a single server, a replica set and a sharded cluster.
The helpers map the container's port 27017 to a random port on the host.

The end-to-end tests start the app under Playwright. `e2e/global-setup.ts` prepares the run, and
`e2e/support/app.ts` starts the app with a temporary data directory. They need a display, so the CI
job runs them under `xvfb-run`.

## Gates

`pnpm check` runs lint, typecheck and unit tests in that order. CI also runs `pnpm format:check`.
The release workflow in `.github/workflows/release.yml` builds the installers. See
[CONTRIBUTING.md](../CONTRIBUTING.md) for the commands.

## Open work

- Container management on macOS is out of scope for this release. The engine sits behind one
  interface, so a Podman machine socket can be added later. No Podman-specific code exists yet.
- Container management does not write compose files, log in to registries other than
  `podman login` inside the WSL distro, translate Windows paths in bind mounts, run Windows
  containers, or manage Kubernetes. SSH tunnels are not built.
- Storage usage panel: the adapter integration test (`packages/mongo-adapter`) and the e2e smoke
  spec have never run, because Docker is not installed on the dev machine. Run
  `pnpm run test:integration` and the e2e smoke spec on a machine with Docker, then fix what fails.
- Storage usage panel: opening Storage for a database while the panel is already open ignores the
  new database focus. Make the open panel follow the requested database, with a test.
- Journey batch 2: the coverage check fails when run on the standalone trace alone, because the
  replica-set and Docker journeys are missing from it. Decide whether the check merges all segment
  traces or accepts one segment, then update `e2e/coverage-check.ts` to match.
- Machine encryption: the macOS Keychain prompt is untested. The builds are ad-hoc signed, so
  the prompt may return after each update. Test two consecutive signed builds on a Mac before the
  next release.
- Machine encryption: the owner has not chosen the keyring help URL. `KEYRING_HELP_URL` in
  `packages/ui/src/settings/links.ts` points at `docs/keyring-setup.md` on GitHub. Pick the final
  URL, keeping it on `github.com/eriksimonic/mongodb-gui`.
- Green CI plan: the CPD comparison (finishing step T8) has not been run. Run the
  `cpd-duplication` skill on `packages/ui` and `packages/app` and compare with the baseline in
  git history (`docs/plans/2026-10-17-green-ci.cpd-baseline.md` at `e85767f^`).

### Wave 2: tests

Rules:

- Pure logic is tested once, in `core`.
- Adapter tests run against a real MongoDB through testcontainers. Do not repeat their assertions
  with fakes elsewhere.
- Router tests check wiring and error mapping per feature, table-driven (`it.each`), not one
  hand-written test per error code.
- UI tests check panel behaviour. They do not re-check what core's model tests already check.

Candidates:

- `app/src/main/rpc/router.test.ts` (about 1,860 lines): split by feature to match the router
  split, then turn the error-mapping cases into tables.
- `core/src/sql`: `break-hostile-input.test.ts` and `break-hostile-input-2.test.ts` cover the same
  area. `translate.test.ts` has single-case `it`s that suit `it.each`.
- Explain is tested in core, the adapter, the app and the UI. Check which panel and model tests
  re-assert core's normalise output.
- `app/src/test/build-shell-runtime.ts` and `shell-runtime/src/test/build-global-setup.ts` may both
  build the shell-runtime bundle. Both run as globalSetup.
- Before deleting a test, confirm another test covers the same behaviour. A test with a unique
  assertion stays.

### Wave 3: needs investigation first

- `ui/src/state/app-store.ts` (about 1,380 lines) and `editor-actions.ts` (about 870): find which
  parts belong to a feature once wave 2 is done.
- `ui/src/api/explain-lab.ts` imports `../../../../dev/explain-lab/queries.js?raw`, from outside
  the package.
