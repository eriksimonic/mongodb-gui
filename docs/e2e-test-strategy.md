# End-to-end test strategy and execution plan

Status: phases 2 to 5 built. Written 2026-10-14.

## Problem

Wiring bugs, such as a click that does nothing, reach the owner only through manual testing. The mocked unit and component tests cannot see them, because the mock replaces the seam where these bugs live: UI, RPC contract (`packages/core/src/rpc/contract.ts`), main-process router (`packages/app/src/main/rpc/`), Mongo adapter. Before each release the owner clicks through the whole app by hand. The goal is that a green run is enough sign-off for a release.

## Decisions so far

- Keep the mocked unit and component tests. Remove a component test only when a journey covers the same path and the test only asserts "rpc was called with X".
- Keep the browser mock UI. The docs screenshots and the `run-app` skill use it.
- Everything above the unit tests runs against a real MongoDB started with Docker Compose.
- Cover about 80 percent of the common paths. No pixel matching. Assert data and state, not appearance.
- Profiling is switched on from the Profiler tab by the test, not pre-enabled in the seed.
- The suite becomes a blocking CI requirement after a trial period.

## Test layers

| Layer              | Runs                                                          | Real Mongo | Covers                                                                     |
| ------------------ | ------------------------------------------------------------- | ---------- | -------------------------------------------------------------------------- |
| Unit and component | Vitest                                                        | no         | Logic and rendering branches                                               |
| Router integration | Vitest, existing `*.integration.test.ts`                      | yes        | Each RPC method against Mongo                                              |
| Wiring journeys    | Playwright against the browser build and an in-process router | yes        | UI to router to Mongo, many short journeys                                 |
| Electron smoke     | Playwright against real Electron                              | yes        | IPC and preload, native dialogs, vault and master password, packaged build |

The wiring layer is the new part. It should hold most journeys because it starts in seconds, with no Electron launch. The Electron layer holds about three journeys, only for what the wiring layer cannot reach.

## Open question, answered by a spike first

The wiring layer works only if the router can run in a plain Node process behind a small HTTP or WebSocket transport, and the browser build can point at it. The UI side already has a swappable seam, since the mock UI uses it. The router side is unchecked. The router may need Electron APIs for dialogs and the vault.

Spike, about half a day. Run the real router in Node, serve it over a transport, point the browser build at it, start Mongo from Compose, and write one journey that connects, runs `find` on `shop.orders` and asserts the rows. The spike decides between this plan and a fallback of Electron-only journeys.

## Spike result

Go. The spike is in `e2e/spike/` and passes against Mongo 8.0.17, rerun and confirmed. Run it with `pnpm --filter @mongo-gui/app run build:shell-runtime` and then `pnpm exec playwright test -c e2e/spike/playwright.config.ts`. It needed no production code change.

- `server.ts` runs one Vite server in middleware mode. It loads `router.ts`, `app-services.ts` and `shell/child.ts` from source with `ssrLoadModule` and serves the unchanged renderer. `POST /__spike/rpc` calls `router.handle`, and events go out over SSE.
- `bridge.ts` defines `window.mongoGui` with Playwright `addInitScript`, over fetch and EventSource.
- The server creates the vault and a "Local dev" connection, so the UI boots unlocked. The master password and vault screens stay with the Electron layer.
- Electron stand-ins, all already injectable: dialogs return no pick, `openExternal`, `startup`, `updates` and `tools` are no-ops or left out, `versions` is static, the shell child uses `child_process.fork` in place of `utilityProcess`, and docker points at a missing socket.
- Timings: Mongo start and seed 3 to 4 s, router start under 3 s, journey about 5 s, whole run about 11 s.

Risks for scaling:

- The transport is JSON and Electron IPC uses structured clone. Date, Uint8Array, bigint and `undefined` would differ. The Electron smoke layer has to cover those shapes.
- Not covered here: the trusted-sender check in `isTrustedSender`, the CSP, the preload and native dialogs.
- One router, vault and shell per server. Parallel journeys need a server and user-data folder per worker, or a reset between tests.
- Vite's dependency optimizer can reload the page on a cold run. Pre-warm it or serve a built renderer.
- The page logs one 404 that the spike did not trace. Find the URL before adding an allowlist entry.
- The spill folder lands in `/tmp`, which is RAM-backed. Point it at a disk folder.
- Shell children run with `silent: true`. Drain their output on long runs.

## Journeys

Each journey is short, a few steps, and independent. Journeys share one seeded database and use their own database names for anything they write. A long single journey stops at its first failure and hides the rest, so the plan avoids it.

First set:

- Connect to a standalone server and list databases.
- Connect to a secured server. The app prompts for the password, then shows the tree. This fails today.
- Run `find`, assert the documents.
- Explain, assert the winning plan stage.
- Profiler, enable it from the tab, run a query, assert the entry appears.
- Backup, restore and import, each checked by reading the data back with a separate Mongo client.

Each journey asserts the visible result and the server state, read through a side-channel `MongoClient`. A journey that only checks the UI can pass while the data is wrong.

## Topologies

Compose stacks in `e2e/infra/`, one project per segment so jobs do not share state.

- Standalone with a root user.
- Secured standalone, for the password prompt.
- Three-member replica set `rs0`, derived from `dev/replica-set/docker-compose.yml` without the 1M-document seed. Members advertise `rs1` to `rs3`, so this job adds them to `/etc/hosts`. It runs in its own job so the edit does not leak.
- A container with no published port, for the docker-direct connect path. `packages/docker/src/forwarder.integration.test.ts` already covers the forwarder, so the journey only checks the UI wiring.

## Coverage map

The RPC contract has about 188 methods. It is the list of user actions to measure against.

1. An env flag, `MONGO_GUI_RPC_TRACE=<file>`, makes the router append the method and outcome of each call. The flag is never set in production.
2. `e2e/coverage-map.ts` lists every method as a journey or as an exclusion with a reason.
3. A unit test fails when a contract method is missing from the map.
4. After the segments finish, a CI step merges the traces. It fails when a mapped method was never called, or when a call failed unexpectedly.

The map doubles as the release checklist the owner now keeps in their head.

## Loud failures

Two changes make wiring bugs fail a test instead of passing silently.

- The router logs an input the schema rejects as a warn, and `expectCleanLogs` in `e2e/support/app.ts` ignores warns. Extend `ERROR_LINE` to match those warns, and assert zero `INTERNAL` outcomes per journey.
- Import, backup and restore use native open and save dialogs. A dev-only `MONGO_GUI_DIALOG_PICKS` queue of scripted paths lets journeys drive them.

## Stability rules

- `retries: 0`. A flaky test is a bug.
- Role and label locators. `data-testid` only for grids. No sleeps; wait on visible state.
- Error-log allowlist per topology, each entry with a reason. Replica set elections and deliberate auth failures log driver errors.
- Pinned Mongo and Electron versions.
- Build once in CI and share the artifact. `e2e/global-setup.ts` builds inside each run today.
- Fetch mongo-tools in the backup job. Only the app integration job fetches them now.
- Each segment is required in CI from the start. The planned two-week non-blocking trial was skipped.
- Before a release, run the Electron smoke against the packaged build on each shipped OS.

## Execution model

Opus coordinates and validates. Haiku agents implement. The split keeps the checker independent of the builder.

### Roles

Opus coordinator. Owns the plan and the task list, writes each task brief, assigns file ownership, sequences the work, and merges. Writes no feature code.

Opus validator. Reviews each finished task against its brief and runs the checks. A task is done only when the validator accepts it. The validator is a separate agent from the one that wrote the code.

Haiku implementers. Each gets one narrow task, a list of files it may edit, and an acceptance check. Many run in parallel. Examples of separate concerns:

- Compose stack and seed script for one topology.
- RPC trace hook in the router.
- Coverage map and completeness test.
- Stricter error gate in `e2e/support/app.ts`.
- Dialog picks hook.
- One journey spec per feature.
- CI job and matrix entry.

### Rules

- One owner per file. Two agents never edit the same file. The coordinator splits tasks along file boundaries and reserves shared files, such as `ci.yml` and `e2e/support/app.ts`, for one agent at a time.
- An implementer reads the code it touches, writes the change, runs its own acceptance check, and reports. It does not review its own work and does not edit files outside its list.
- The brief states the expected behavior and the check. It does not give the implementer room to redefine the goal.
- The validator does not trust the implementer's report. It reruns the check and reads the diff.
- The validator confirms a journey is not vacuous. It breaks the wiring on purpose, for example by renaming an RPC method name in the UI call, and confirms the journey fails.
- A failed validation goes back to the same implementer with the failing output, up to two rounds. After that the coordinator rewrites the brief or takes the task to a stronger agent.
- Haiku handles mechanical, well-specified work. Anything that needs a design choice, such as the router transport in the spike, goes to the coordinator first.

### Phases

1. Spike. The coordinator runs it with one or two implementers. Output is a go or no-go on the wiring layer.
2. Foundation, in parallel. Compose stacks, trace hook, coverage map and its test, error gate, dialog hook. Each is an independent task with its own validation.
3. First journeys. Connect, secured connect as `test.fail()`, `find`, explain. One agent per spec.
4. CI. Matrix jobs, build-once artifact, trace merge step. One agent, since it edits `ci.yml`.
5. Remaining segments. Profiler, backup, restore, import, replica set, docker-direct. Each adds a matrix entry and moves its methods in the map from excluded to covered.
6. Fix the password prompt, then flip its journey from `test.fail()` to a normal test.
7. Trial period, then make the segments required.

### Validator checklist per task

- The acceptance check from the brief passes when the validator runs it.
- `pnpm run check` passes.
- The diff touches only the files on the task's list.
- A journey fails when the wiring it covers is broken.
- No sleeps, no retries added, no new broad error-log allowlist entry without a reason.
- Test images go to `e2e/output`, never to `docs/screenshots`.

## Decisions changed during the work

Recorded while phases 2 to 5 were built.

- The spike moved to `e2e/wiring/` and `e2e/spike/` is gone. Run the layer with `pnpm test:wiring`. Set `E2E_PREBUILT=1` to skip the build.
- The wiring layer serves the built renderer from `packages/app/out/renderer`, not the Vite dev server. This removes the optimizer reloads on a cold run. Vite only loads the router source.
- Each journey gets its own router, vault, user-data folder and HTTP server on a free port. One Vite loader is shared per worker. This answers the isolation risk from the spike.
- The user-data and spill folder is under `e2e/output/wiring-data/`, on disk. The shell child output is drained.
- The spike's 404 was `/favicon.ico`. The server now answers it with the app icon.
- The router did not log schema rejections, so extending `ERROR_LINE` alone caught nothing. The router now logs `rpc method unknown` and `rpc input rejected` as warns and `rpc output rejected` as an error, and `ERROR_LINE` matches the two warns. The wiring server checks every result directly and fails a journey on `INTERNAL`, an unknown method or a rejected input.
- One standalone Compose stack serves both connect journeys. The secured case is a saved connection without the password, so a second stack added nothing.
- The Electron layer stays on testcontainers for now. Only the wiring layer uses Compose.
- `MONGO_GUI_RPC_TRACE` and `MONGO_GUI_DIALOG_PICKS` are read in `index.ts` only when the app is not packaged, like `MONGO_GUI_USER_DATA`.
- The secured connect journey targets a dialog with a "Password" field and a "Connect" button, the labels of `DockerCredentialsDialog`. Today the tree shows "Authentication failed" and no dialog opens.
- `E2E_SEGMENT` (`standalone`, `replset`, `docker`) picks the Compose stack and the spec folder `e2e/wiring/journeys/<segment>/`. Profiler, backup, restore and import run in the standalone segment, so there are three CI matrix entries, not six.
- The replica set members use host networking on `127.0.0.1:27031` to `27033` and advertise those addresses, so no job edits `/etc/hosts`. Member 27031 has priority 2, so the primary is the same on every start.
- The docker segment also starts the standalone stack, because the test server seeds its saved connections from that URI.
- The test server has the bundled MongoDB tools and a per-test `wiring.setDialogPicks` for the native dialogs. `test.use({ realDocker: true })` gives it the host Docker socket.
- CI requires the wiring segments and the coverage step.

## Estimate

About 1.5 to 2 weeks of active work for the full set, plus about two weeks of calendar time for each segment to stay green before it blocks. The first slice runs in CI in a couple of days. These numbers are estimates and the spike may change them.

## Risks

- The router may not run outside Electron without changes. The spike answers this.
- CI stability for Compose, the virtual display and image pulls usually needs several rounds of debugging.
- Replica set hostname resolution inside Electron may surprise.
- A blocking suite that flakes will be bypassed. The trial period and the no-retry rule exist for this reason.
- The trace and dialog hooks add small env-gated code to production. They stay off unless the variable is set.
