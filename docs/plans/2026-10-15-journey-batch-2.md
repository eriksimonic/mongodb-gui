# Plan: wiring journeys, batch 2

## Goal and done check

Add standalone wiring journeys for the common paths the handoff names (editor and results, indexes, import and export, transfers). Each journey covers a group of RPC methods that `e2e/coverage-map.ts` currently marks `excluded: 'no journey planned yet'`.

Done check, all three must pass:

1. `E2E_PREBUILT=1 MONGO_GUI_RPC_TRACE=/tmp/mg-trace/standalone.jsonl pnpm test:wiring` passes with no failed spec.
2. `node e2e/coverage-check.ts /tmp/mg-trace` passes.
3. `pnpm vitest run --project unit tests/coverage-map.test.ts` passes.

Target is about 40 of the 112 placeholder exclusions flipped to `{ journey: ... }`. The 59 mapped methods before this batch stay mapped.

## Constraints and do-not-change list

- Add specs and flip map entries only. No production code edits. If a journey cannot reach a UI path without one (for example a missing label), the implementer stops and reports it. It does not edit the component.
- Do not edit `e2e/wiring/fixtures.ts`, `bridge.ts`, `server.ts`, `playwright.config.ts` or any existing spec.
- Methods whose reason is Electron-layer (17 of them: vault, updates, app, startup, native dialogs) stay excluded.
- Do not cover step down, initiate, add or remove member or `killAllSessionsByUser`. They break the shared replica set or the app's own sessions.
- A journey touches only a database it creates itself, named `wiring_<spec>_<random>`. It never writes to the seeded `shop` database, because other specs read it.
- Nothing goes to `docs/screenshots`. Images go to `e2e/output`.

## Baseline

- Unit suite: `pnpm test` passes (358 files, 6814 tests).
- Wiring standalone: 39 of 39 passed at the last handoff. Replica set 6 of 6. Docker 1 of 1.
- Coverage: 59 methods mapped, 129 excluded (17 Electron-layer, 112 "no journey planned yet"). Map and `rpcContract` agree on 188 methods.
- `format:check` fails on `docs/architecture-redesign.md` and `packages/ui/src/profiler/ProfilerPanel.test.tsx`. This was true before any work.
- Docker is not reachable on this machine, so the docker segment cannot run locally. This batch does not need it.

## Pattern to copy

- Minimal shape, `e2e/wiring/journeys/standalone/secured-connect.spec.ts` (13 lines).
- Fuller shape, `e2e/wiring/journeys/standalone/find.spec.ts` (53 lines) and `profiler-detail.spec.ts` for role-based locators.
- Map entry shape, `'connections.get': { journey: 'connection-crud.spec.ts' }`, basename only.
- Imports come from `e2e/wiring/fixtures.ts` and `e2e/support/mongo.ts`.

## Tasks

Methods are named `namespace.call`. The "reads" column always also includes the model spec above and `e2e/wiring/fixtures.ts`. Each journey task writes one new spec in `e2e/wiring/journeys/standalone/` and does not touch the map. It ends its report with the exact list of methods it called and verified.

| Id  | New file                            | Methods to cover                                                                                                                                     | Component folder to read                                               | Model  | Waits for          |
| --- | ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | ------ | ------------------ |
| J1  | `indexes.spec.ts`                   | management.createIndex, dropIndex, setIndexHidden, listIndexBuilds; collections.indexes, stats                                                       | `packages/ui/src/management` (index panel files)                       | Sonnet | none               |
| J2  | `documents-crud.spec.ts`            | management.insertDocument, replaceDocument, updateDocumentFields, deleteDocuments, deleteByFilter, countDocuments, findDocumentById, sampleDocuments | `packages/ui/src/management` (DocumentsPanel and siblings)             | Sonnet | none               |
| J3  | `collection-database-crud.spec.ts`  | management.createCollection, renameCollection, dropCollection, clearCollection, createDatabase, dropDatabase; databases.stats                        | `packages/ui/src/management`, `packages/ui/src/tree`                   | Sonnet | none               |
| J4  | `shell-results.spec.ts`             | shell.next, cancel, readDocument, releaseResult, complete                                                                                            | `packages/ui/src/editor`, results view folder                          | Sonnet | none               |
| J5  | `history-favourites.spec.ts`        | history.list, clear; favourites (all 3)                                                                                                              | `packages/ui/src/editor` and the history and favourites panels         | Sonnet | none               |
| J6  | `transfers.spec.ts`                 | transfer.startExport, cancel, status, list                                                                                                           | `packages/ui/src/transfers`                                            | Sonnet | none               |
| J7  | `connections-import-export.spec.ts` | connections.exportToFile, previewImport, importFromFile (use `wiring.setDialogPicks` for the file dialog)                                            | `packages/ui/src/connections`, `packages/app/src/main/dialog-picks.ts` | Sonnet | none               |
| M1  | `e2e/coverage-map.ts`               | Flips the methods each passing journey reported, from `excluded` to `{ journey: '<spec>' }`                                                          | the journey reports                                                    | Haiku  | J1 to J7 validated |
| F1  | none                                | Final run and the three done checks                                                                                                                  | none                                                                   | Opus   | M1                 |

Why Sonnet for the journeys. Each one needs the implementer to read a UI folder and choose locators and assertions. That is judgment, not a copy job, so Haiku is not used. The map edit in M1 is mechanical, so it is Haiku.

Each journey task has its own validator, V1 to V7, on Opus. A validator is never the agent that wrote the spec.

- Check for V<n>. Under the lock, run the new spec and confirm it passes. Then break one UI or RPC call the spec depends on, rebuild, confirm the spec fails, and restore the file with `git checkout -- <file>`. Run `git diff` on the touched file and confirm it is clean before releasing the lock.
- It also confirms that every method in the implementer's list appears in a trace of that spec alone (`MONGO_GUI_RPC_TRACE=/tmp/mg-trace-v<n>/s.jsonl`), and that the spec writes only to its own database.
- Delete any scratch spec it made. Check `git status` for names starting `zz-val-` or `tmp-probe`.

Acceptance check for J<n>, which the validator reruns:

`E2E_PREBUILT=1 flock /tmp/mongo-gui-wiring.lock pnpm exec playwright test -c e2e/wiring/playwright.config.ts <spec-file>`

Acceptance check for M1, `pnpm vitest run --project unit tests/coverage-map.test.ts` plus `git diff --stat` showing only `e2e/coverage-map.ts` changed.

## Phases

- Phase 1. J1 to J7 write their specs in parallel. Files do not overlap. Running a spec takes the lock, so runs are serial.
- Phase 2. V1 to V7 validate. They also take the lock one at a time. A validator starts when its journey finishes, so Phase 1 and Phase 2 overlap per task.
- Phase 3. M1 runs after every journey it covers has a passing validator. A journey that fails twice is dropped from the batch and its methods stay excluded.
- Phase 4. F1 runs the final checks.

Run `pnpm build` once before Phase 1 by the coordinator, then every agent sets `E2E_PREBUILT=1`. Nobody rebuilds, except a validator that breaks a call on purpose. That validator rebuilds and then rebuilds again after restoring the file.

## Serial resources

- One Playwright session at a time, held with `flock /tmp/mongo-gui-wiring.lock`. Every agent that runs a spec wraps the command in it. Holders are the implementers, validators and F1.
- The standalone MongoDB from `e2e/infra`. It is shared, which is why each journey uses its own database name.
- The built output in `out/`. Only the coordinator builds before Phase 1. A validator that rebuilds does so under the lock.
- `e2e/coverage-map.ts` is edited by M1 only.

## Commit policy

Commit on `architecture-redesign`. Do not push. No `Co-Authored-By` line or any tool attribution in the message (project and global CLAUDE.md rule). The coordinator commits, with plain subject and body:

- One commit per validated journey, adding only that spec. Subject example, `test(e2e): add indexes journey`.
- One commit for M1, `test(e2e): map the new journeys in the coverage map`.

The user reviews the commits afterward. No agent commits before its validator passes.

## Rework rule

A failed validation goes back to the same implementer with the failing output, at most two rounds. Then the coordinator rewrites the brief once. If it still fails, the journey is dropped and listed in the final report.

## Risks and open decisions

- Batch scope. This batch skips sharding (12 methods), security (13), gridfs (9), monitor (6), changes (5), docker (3), tools (4), saved backups and restores (8), shell state, restart, sampleSchema, generate, schema.analyse, settings.update and the `replication` calls. Some of these need a sharded or authenticated stack in `e2e/infra`. They belong to a batch 3. Say so if you want any of them in this one.
- Production edits. A journey may hit a missing label or role. The rule is to stop and report. Several such reports would justify a small production task before the batch, like the profiler pane label.
- Transfers and file dialogs. J6 and J7 depend on `wiring.setDialogPicks` and the bundled MongoDB tools (`pnpm --filter @mongo-gui/app fetch:mongo-tools`). The coordinator runs the fetch before Phase 1. If the network is blocked, J6 and J7 are dropped.
- Flaky specs. CI now requires the wiring jobs, so a flaky new spec blocks the branch. Validators should run each spec three times in a row. Any failure sends it back.
- A coordinator hands back early when its context fills. Keep reports to one status line per task. The coordinator writes `docs/plans/2026-10-15-journey-batch-2.status.md`, one line per task, format `- Id (agent): status, next action`.
- Task count is 17: seven journeys, seven validators, M1 and F1.
