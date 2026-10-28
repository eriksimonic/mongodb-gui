# End-to-end test strategy

Status: wiring layer built and required in CI (segments `standalone`, `replset`, `docker`).

## Problem

Wiring bugs, such as a click that does nothing, reach the owner only through manual testing. The
mocked unit and component tests cannot see them, because the mock replaces the seam where these
bugs live: UI, RPC contract (`packages/core/src/rpc/contract.ts`), main-process router
(`packages/app/src/main/rpc/`), Mongo adapter. The goal is that a green run is enough sign-off for
a release.

## Test layers

| Layer              | Runs                                                          | Real Mongo | Covers                                                                     |
| ------------------ | ------------------------------------------------------------- | ---------- | -------------------------------------------------------------------------- |
| Unit and component | Vitest                                                        | no         | Logic and rendering branches                                               |
| Router integration | Vitest, existing `*.integration.test.ts`                      | yes        | Each RPC method against Mongo                                              |
| Wiring journeys    | Playwright against the browser build and an in-process router | yes        | UI to router to Mongo, many short journeys                                 |
| Electron smoke     | Playwright against real Electron (`e2e/tests/`)               | yes        | IPC and preload, native dialogs, vault and master password, packaged build |

The wiring layer holds most journeys. It starts in seconds and does not launch Electron. The Electron
layer covers only what the wiring layer cannot reach.

## Decisions

- Keep the mocked unit and component tests. Remove a component test only when a journey covers the
  same path and the test only asserts "rpc was called with X".
- Keep the browser mock UI. The docs screenshots and the `run-app` skill use it.
- Everything above the unit tests runs against a real MongoDB from Docker Compose (`e2e/infra/`).
- The wiring server runs the real router in Node behind a JSON HTTP and SSE transport, and serves
  the built renderer from `packages/app/out/renderer`.
- Each wiring journey gets its own router, vault, user-data folder and HTTP server on a free port.
- Assert data and state, not appearance. Each journey checks the visible result and the server
  state, read through a side-channel `MongoClient`.
- Journeys are short and independent. They share one seeded database. Anything a journey writes
  goes to a database it creates, named `wiring_<spec>_<random>`. Nothing writes to `shop`.
- The test switches profiling on from the Profiler tab. The seed does not pre-enable it.
- Cover about 80 percent of the common paths. No pixel matching.
- Each segment is required in CI.

## Running

- Build once with `pnpm build`, then set `E2E_PREBUILT=1` to skip the build.
- `pnpm test:wiring` runs the standalone segment. `E2E_SEGMENT=replset` and `E2E_SEGMENT=docker`
  run the other two. `E2E_SEGMENT` picks the Compose stack and the spec folder
  `e2e/wiring/journeys/<segment>/`.
- Coverage: set `MONGO_GUI_RPC_TRACE=<abs dir>/<segment>.jsonl` for each run, then run
  `node e2e/coverage-check.ts <dir>`.
- Backup and restore need `pnpm --filter @mongo-gui/app fetch:mongo-tools`.
- Run one wiring session at a time on a machine.

## Topologies

Compose stacks in `e2e/infra/`. Each CI segment has its own stack, trace file and artifact.

- Standalone (`standalone.yml`): root user. One stack serves the connect journeys, and the secured
  connect journey uses a saved connection without its password. Profiler, backup, restore and
  import run in this segment.
- Replica set (`replset.yml`): three members on host networking at `127.0.0.1:27031` to `27033`.
  Member 27031 has priority 2, so the primary is the same on every start.
- Docker (`docker.yml`): a container with no published port, for the docker-direct connect path.
  The test server has the host Docker socket through `test.use({ realDocker: true })`. The docker
  segment also starts the standalone stack, because the test server seeds its saved connections
  from that URI.

Not covered by journeys, because they would destabilise the shared replica set or kill the app's
own sessions: step down, initiate, add or remove member, and `killAllSessionsByUser`.

## Coverage map

`e2e/coverage-map.ts` lists every RPC method (about 188) as a journey or as an exclusion with a
reason. Seventeen exclusions are Electron-layer methods (vault, updates, app, startup, native
dialogs). A unit test fails when a contract method is missing from the map. After the segments
finish, CI merges the traces and fails when a mapped method was never called, or when a call failed
unexpectedly. The map is the list to measure journey coverage against.

## Stability rules

- `retries: 0`. A flaky test is a bug.
- Role and label locators. `data-testid` only for grids. No sleeps; wait on visible state.
- Error-log allowlist per topology, each entry with a reason. Replica set elections and deliberate
  auth failures log driver errors.
- Pinned Mongo and Electron versions.
- The router logs an unknown method and a rejected input as a warn, and a rejected output as an
  error. `ERROR_LINE` in `e2e/support/app.ts` matches those lines. The wiring server fails a journey
  on an `INTERNAL` result, an unknown method or a rejected input.
- Native open and save dialogs are driven by `MONGO_GUI_DIALOG_PICKS` in the wiring layer. The
  router reads it, and the RPC trace variable, only when the app is not packaged.
- Test images go to `e2e/output`, never to `docs/screenshots`.
- Before a release, run the Electron smoke against the packaged build on each shipped OS.

## Open items

- Secured connect: the password dialog saves the password on the profile after the server accepts
  it (`ConnectionPasswordDialog`). Decide whether to keep it for the session only instead.
- Backup and Restore dialogs wait up to 30 s on the tools feed when the network is blocked.
- `connections.status` has no journey and stays excluded in the coverage map.
- Coverage check on a single segment's trace fails, because the other segments' methods are
  missing. Decide how the check handles one segment (see "Open work" in `docs/architecture.md`).
- 78 RPC methods still say "no journey planned yet" in `e2e/coverage-map.ts`. Add journeys for
  them, starting with the remaining common paths.
- The wiring matrix has not been confirmed on GitHub Actions since the last local runs. Check the
  wiring jobs pass on the runner, and that the image pulls and Chrome setup work.
- `fetch:mongo-tools` runs only in the integration job (`.github/workflows/ci.yml`). The wiring
  backup and restore journeys need the tools, so add the step to the wiring job.
- Wiring tests cannot see structured-clone differences. The transport is JSON, and Electron IPC
  uses structured clone, so `Date`, `Uint8Array`, `bigint` and `undefined` can differ. The Electron
  smoke layer must cover those shapes.
- Not covered by the wiring layer: `isTrustedSender`, the CSP, the preload and the vault and master
  password screens.
- Waves 2 and 3 of the architecture redesign are still open. See [architecture.md](architecture.md), Open work.
