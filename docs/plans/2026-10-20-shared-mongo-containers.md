# Shared MongoDB containers for the integration tests

Status: draft for the owner's approval.

## Goal and done check

`vitest run --project integration` starts 76 MongoDB containers today, because every `*.integration.test.ts` starts its own. After this plan it starts 30, because one vitest globalSetup starts one shared container per image and the files use it, each in its own database.

The plan is done when all of these hold:

- The final validator (V6) ran the full integration project once, it passed, and the number of labelled `mongo:` containers it sampled never went above 31.
- No test was removed or skipped. The test count of each file in V6's run equals the count in the baseline file, plus the tests of the new file `shared-mongo.integration.test.ts`.
- `pnpm run check` has no failure that is not in the baseline file.
- The labelled `mongo:` container count is 0 before and after every run, so the shared containers are stopped.
- The coordinator committed each phase on `chore/shared-mongo-containers`, and task R closed the owner's TODO-AI review.

## Container count, before and after

| File (under `packages/`)                                                   | Before | After | Why                                                              |
| -------------------------------------------------------------------------- | -----: | ----: | ---------------------------------------------------------------- |
| `mongo-adapter/src/adapter.integration.test.ts`                            |      3 |     0 | shared standalone                                                |
| `mongo-adapter/src/backup/source-info.integration.test.ts`                 |      2 |     0 | shared standalone                                                |
| `mongo-adapter/src/changes/changes.integration.test.ts`                    |      4 |     0 | shared 1-node set and shared standalone                          |
| `mongo-adapter/src/diagnostics/diagnostics.integration.test.ts`            |      3 |     0 | shared standalone, which has `enableTestCommands`                |
| `mongo-adapter/src/diagnostics/storage.integration.test.ts`                |      3 |     0 | shared standalone                                                |
| `mongo-adapter/src/explain-fixtures.integration.test.ts`                   |      4 |     2 | 4.4 and 6.0 shared; 6.0-sbe and 8.0.17 stay dedicated            |
| `mongo-adapter/src/gridfs/gridfs.integration.test.ts`                      |      2 |     0 | shared standalone                                                |
| `mongo-adapter/src/management/management.integration.test.ts`              |      3 |     0 | shared standalone                                                |
| `mongo-adapter/src/monitor/monitor.integration.test.ts`                    |      4 |     0 | shared standalone and shared 8.0.17 set                          |
| `mongo-adapter/src/monitor/series.integration.test.ts`                     |      3 |     0 | shared standalone                                                |
| `mongo-adapter/src/profiler/profiler.integration.test.ts`                  |      3 |     0 | shared standalone                                                |
| `mongo-adapter/src/replication/replication.integration.test.ts`            |     12 |    10 | per image 3-node set, `addNode`, uninitiated node stay dedicated |
| `mongo-adapter/src/security/security.integration.test.ts`                  |      3 |     0 | shared standalone                                                |
| `mongo-adapter/src/sharding/sharding.integration.test.ts`                  |     10 |     9 | 3 clusters of 3 stay dedicated; the standalone goes shared       |
| `mongo-adapter/src/transfer/transfer.integration.test.ts`                  |      2 |     0 | shared standalone                                                |
| `app/src/main/backup/backup.integration.test.ts`                           |      2 |     0 | shared standalone                                                |
| `app/src/main/rpc/{explain,gridfs,monitor,profiler,router,shell,transfer}` |      7 |     0 | shared 8.0.17 standalone                                         |
| `shell-runtime/src/session.integration.test.ts`                            |      2 |     0 | shared standalone                                                |
| `docker/src/{custom-port,forwarder,script-replset}`                        |      4 |     4 | dedicated, unchanged                                             |
| globalSetup (3 standalones, 2 one-node sets)                               |      0 |     5 | new                                                              |
| Total                                                                      |     76 |    30 |                                                                  |

Replication per image is the 3-node set (3), the added member (1), the uninitiated node (1) and the standalone (1, goes shared). Sharding per image is config server, shard and mongos (`mongo-adapter/src/test/sharded-cluster.ts:48-91`). Even with every dedicated container alive at once the total stays at 30, so the peak limit of 31 holds for any worker count.

## Constraints and do-not-change

- Do not change product source. Only `*.integration.test.ts` files, `packages/mongo-adapter/src/test/*`, `vitest.config.ts` and the docs files this plan names change. In particular `packages/mongo-adapter/src/client-options.ts` stays as it is.
- Keep CI behaviour. `fileParallelism: !inCi` (`vitest.config.ts:32`) stays. `.github/workflows/ci.yml` does not change.
- Keep every test. Do not remove, skip or weaken an assertion unless the task says so. The tasks that drop an assertion name it: E3 drops the `serverStatus` cursor total, C1 may replace the connection count filter.
- Do not merge standalone and replica-set containers. About eight files assert standalone topology, and the sets have no auth.
- Simplest code. No wrapper, class or config option beyond what T1 specifies. Match the style of the file you edit. Named exports only.
- Prose in comments and commit messages follows `~/.claude/skills/unslop/SKILL.md`: plain words, no em dashes.
- `docs/screenshots` does not change. Logs and scratch files go to `$TMP`, never into the repo.

## Design (decided by the owner, not reopened)

- A new globalSetup, `packages/mongo-adapter/src/test/shared-global-setup.ts`, starts in parallel:
  - 3 standalones with root auth and `--setParameter enableTestCommands=1`: `startMongo(image, { testCommands: true })` for each of `MONGO_IMAGES` (`mongo:4.4`, `mongo:6.0`, `mongo:8.0.17`, `mongo-container.ts:6`).
  - 2 one-node replica sets named `rs0` without auth: `startReplicaSet(image, 1)` for `mongo:8.0.17` and `mongo:6.0` (`replica-set.ts:75`).
- It passes their URIs to the test workers with `project.provide`, and the tests read them with `inject` (vitest 5.0.3).
- A module-level singleton does not work, because vitest isolates each file. globalSetup is the mechanism.
- Every file that moves to a shared server uses its own database. A fixed database name that only one file uses is already unique on the shared server, since the containers are fresh on each run. Only names that two files share (`shop`, `transfer_it`, security's `other`) are renamed.
- globalSetup always starts all 5, also when one file is selected. The planner decided against starting only what the selected files need: globalSetup does not see the file list in a simple way, and the cost is about one container startup time per run. Each CI matrix job (`ci.yml:355` runs per package) also starts the 5, including the `docker` and `shell-runtime` jobs.

## Names and behavior (T1)

In `packages/mongo-adapter/src/test/mongo-container.ts` (the `./test` export of the package, `packages/mongo-adapter/package.json:10`, which `session.integration.test.ts:20` imports):

- `export const SHARED_REPLICA_SET_IMAGES = ['mongo:8.0.17', 'mongo:6.0'] as const;`
- `export interface SharedMongoUris { readonly rootUri: string; readonly wrongPasswordUri: string; }`
- A module augmentation in the same file:

  ```ts
  declare module 'vitest' {
    export interface ProvidedContext {
      sharedStandalones: Record<string, SharedMongoUris>;
      sharedReplicaSets: Record<string, string>;
    }
  }
  ```

- `export async function sharedMongo(image: string): Promise<StartedMongo>`. It loads `inject` with `const { inject } = await import('vitest');`, so the globalSetup, which imports this file for `startMongo`, never loads the vitest runtime. It returns `{ rootUri, wrongPasswordUri, stop: () => Promise.resolve() }` for the image. It throws `new Error(\`No shared MongoDB container for ${image}\`)`when the image is missing. Call sites swap`await startMongo(image)`for`await sharedMongo(image)`and keep their`stop()` calls, which now do nothing.
- `export async function sharedReplicaSetUri(image: string): Promise<string>`, the same way, returns the `directUri` of the set's only member (`mongodb://host:port/?directConnection=true`). It throws the same kind of error.
- `export function uniqueDb(prefix: string): string` returns `` `${prefix}_${randomUUID().replaceAll('-', '').slice(0, 12)}` `` (`randomUUID` from `node:crypto`).
- `seedCatalog(uri: string, withTimeseries: boolean, db: string = SEED_DB)`. The body uses `db` where it used `SEED_DB` (`mongo-container.ts:84`). Rename the local `const db = client.db(...)` to `database` to avoid the clash. `seedCatalog` calls `createCollection('events')`, which throws when the database was seeded before, so every caller on a shared server passes its own `uniqueDb`.

In `packages/mongo-adapter/src/test/shared-global-setup.ts` (new). It is its own file because `replica-set.ts:10` imports `mongo-container.ts`, and a globalSetup inside `mongo-container.ts` would make a cycle.

- `import type { TestProject } from 'vitest/node';`
- `export async function setup(project: TestProject): Promise<() => Promise<void>>`.
- It starts the 5 servers with one `Promise.allSettled`. If any start was rejected, it stops every fulfilled one (`stop()` of a `StartedMongo`, `stop()` of a `ReplicaSetHarness`), ignores errors from those stops, and throws the first rejection reason. CI runs without Ryuk (`replica-set.ts:81-82`), so a container left here would run until the job ends.
- It calls `project.provide('sharedStandalones', { [image]: { rootUri, wrongPasswordUri } })` and `project.provide('sharedReplicaSets', { [image]: set.nodes[0].directUri })`.
- It returns a teardown that stops all 5 with `Promise.allSettled`.
- The style follows `packages/shell-runtime/src/test/build-global-setup.ts` (a named `setup` export and a short comment that says why the file exists).

In `vitest.config.ts`, the integration project's `globalSetup` array (`:34-37`) gets `'packages/mongo-adapter/src/test/shared-global-setup.ts'` as its last entry.

New test `packages/mongo-adapter/src/test/shared-mongo.integration.test.ts`. One `describe.each(MONGO_IMAGES)` pings `sharedMongo(image).rootUri` as root, checks that the test command `{ refreshLogicalSessionCacheNow: 1 }` on `admin` succeeds (the command diagnostics needs, and the proof that `enableTestCommands` is on), and checks that `wrongPasswordUri` fails with code 18. One `describe.each(SHARED_REPLICA_SET_IMAGES)` runs `replSetGetStatus` on `sharedReplicaSetUri(image)` and expects `set === 'rs0'`, one member, state `PRIMARY`. `sharedMongo('mongo:5.0')` rejects with the error above.

## Baseline (T0 writes the result)

T0 runs in the worktree (see "Commit policy") before any change, so it tests the code of `main`. T1 starts only after T0 is done, because vitest reads `vitest.config.ts` on every run and a half-written globalSetup would spoil the later rows. T0 writes `docs/plans/2026-10-20-shared-mongo-containers.baseline.md` with:

- The testcontainers label. Start any one file, run `docker inspect --format '{{json .Config.Labels}}' <a mongo container id>` while it runs, and record the label key and value (expected `org.testcontainers=true`). Every later count uses it.
- The count command, with the label T0 found:
  `docker ps --filter label=org.testcontainers=true --format '{{.Image}}' | grep -c '^mongo:'`
  It counts only labelled containers whose image starts with `mongo:`. Ryuk, sidecars of the docker tests and containers of other projects are not counted.
- The count before T0 starts. If it is not 0, T0 stops and reports. It never stops containers it did not start.
- One row per integration file, run one at a time: `pnpm exec vitest run --project integration <file>`. Record pass or fail, the failing test names, the number of tests, the run time and the count after the run.
- The full integration project is not run, neither in parallel nor serially. Serial single-file runs give the same pass and fail data without starting the 76 containers at once. Expect 45 to 90 minutes for the 27 files.
- T0 runs the 27 files from one bash script started with `run_in_background`, because the run is longer than a foreground command may take and the vitest output would not fit in a Haiku context. The script writes each file's full output to `$TMP/shared-mongo-baseline/<n>.log`, appends one table row per file to the baseline file (pass or fail, test count and failing test names taken from the vitest summary, seconds, count after), and prints only that row. T0 reads a log only for a failed file, and only its summary lines.

The coordinator appends the result of `pnpm run check` on `main` to the same file. No later agent blames a failure listed there on its own work.

## Pattern to copy

- globalSetup shape: `packages/shell-runtime/src/test/build-global-setup.ts` and `packages/app/src/test/build-shell-runtime.ts`.
- Unique database per test: `packages/mongo-adapter/src/backup/source-info.integration.test.ts:16`, `packages/mongo-adapter/src/management/management.integration.test.ts:48-50`, `packages/mongo-adapter/src/changes/changes.integration.test.ts:41-43`.
- A swap is one line in `beforeAll`: `mongo = await startMongo(image);` becomes `mongo = await sharedMongo(image);`, and the import list changes from `startMongo` to `sharedMongo`. When the file no longer calls `startMongo`, remove it from the import.

## Roles and models

- Coordinator: Sonnet. Creates the branch, sends tasks, keeps `docs/plans/2026-10-20-shared-mongo-containers.status.md` (one line per task: `- id: status, next action`), runs the phase-end checks, commits. Writes no test or helper code.
- Implementers and T0: Haiku, about 100k tokens each. Each edits only its listed files and reports in at most 10 lines. Implementers never run Docker or `tsc -b`. Before reporting they run `pnpm exec eslint <their files>` and `pnpm exec prettier --check <their files>`.
- C1: Opus, because it needs a design choice (see C1).
- Validators V0 to V6: Opus, never the agent that wrote the code. One validator per phase.

Every brief from the coordinator is this plan's path and the task id, nothing else. A Haiku implementer that finds the plan wrong (a missing file, a line range that moved by more than 30 lines, a name that clashes) reports the problem and stops. It does not guess.

## Phase validator (V0 to V5)

A single-file run cannot show two files colliding on a shared server, so each phase validator does three things, holding Docker:

1. Runs each task's acceptance command of the phase, one at a time.
2. Runs one parallel command over every file migrated so far (the cumulative list in the phase table), with the count watch below. This is never the full project.
3. Reads the diff of the phase (`git diff --stat` and the changed hunks) against the task specs, and checks that no test was removed or skipped (`grep -n "it.skip\|describe.skip\|it.todo"` on the changed files prints nothing new, and the test count per file matches the baseline).

Count watch, as a script in `$TMP` (Git Bash):

```bash
count() { docker ps --filter label=org.testcontainers=true --format '{{.Image}}' | grep -c '^mongo:'; }
before=$(count); peak=0
if [ "$before" -ne 0 ]; then echo "REFUSED: $before labelled mongo containers already run"; exit 1; fi
pnpm exec vitest run --project integration "$@" > "$TMP/shared-mongo-run.log" 2>&1 &
pid=$!
while kill -0 "$pid" 2>/dev/null; do
  n=$(count); [ "$n" -gt "$peak" ] && peak=$n
  if [ "$n" -gt 31 ]; then taskkill //F //T //PID "$(cat /proc/$pid/winpid)"; echo "STOPPED at $n"; break; fi
  sleep 2
done
wait "$pid"; status=$?
echo "exit=$status peak=$peak after=$(count)"
```

Every run, by T0 and by every validator, starts only when the count is 0. If it is not, the agent stops and reports to the coordinator. It never stops containers it did not start. The validator starts the script with `run_in_background` and reads only the last lines of the log. It writes the exit code, the peak, the after count and the failing test names to the status file. A peak above 31, an after count other than 0, or a failure not in the baseline fails the phase.

## Phase-end checks (coordinator)

`tsc -b` writes build output, so two parallel runs corrupt it. After each phase's tasks report, the coordinator alone runs `pnpm run check` (lint, `tsc -b`, the unit project), then dispatches the phase validator. Failures go to the task that owns the file. A failure not in the baseline blocks the next phase.

---

## Tasks

### Phase 0

#### T0 baseline (Haiku)

- Edits: `docs/plans/2026-10-20-shared-mongo-containers.baseline.md` (new)
- Reads: "Baseline" above; `vitest.config.ts:28-39`
- Holds: Docker
- Waits for: the owner approving this plan
- Check: the baseline file has the label, the count command, the before count and 27 rows.

#### T1 shared helpers and globalSetup (Haiku)

- Edits: `packages/mongo-adapter/src/test/mongo-container.ts`, `packages/mongo-adapter/src/test/shared-global-setup.ts` (new), `packages/mongo-adapter/src/test/shared-mongo.integration.test.ts` (new), `vitest.config.ts`
- Reads: "Names and behavior (T1)" above; `mongo-container.ts` (all, 155 lines); `packages/mongo-adapter/src/test/replica-set.ts:1-136`; `packages/shell-runtime/src/test/build-global-setup.ts`
- Waits for: T0
- Spec: as "Names and behavior (T1)". No other file changes in this task, so every existing test still uses `startMongo`.
- Check (V0 runs it): `pnpm exec vitest run --project integration packages/mongo-adapter/src/test/shared-mongo.integration.test.ts packages/mongo-adapter/src/backup/source-info.integration.test.ts` passes, and the count after is 0.

### Phase 1: plain swaps

These files use a database name that no other file uses and assert nothing server-wide. Each change is the swap from "Pattern to copy".

#### A1 adapter swaps (Haiku)

- Edits:
  - `packages/mongo-adapter/src/backup/source-info.integration.test.ts` (import `:7`, swap `:22`)
  - `packages/mongo-adapter/src/diagnostics/storage.integration.test.ts` (import `:8`, swap `:22`)
  - `packages/mongo-adapter/src/monitor/series.integration.test.ts` (import `:8`, swap `:48`)
  - `packages/mongo-adapter/src/management/management.integration.test.ts` (import `:14`, swap `:73`)
  - `packages/mongo-adapter/src/gridfs/gridfs.integration.test.ts` (import `:19`, swap `:92`)
- Reads: those lines and the `beforeAll` and `afterAll` around them
- Waits for: V0
- Note: `listIndexBuilds` (`management.integration.test.ts:509`) only returns builds of the given database (`packages/mongo-adapter/src/management/indexes.ts:183`), so builds of other files do not show up.
- Check: `pnpm exec vitest run --project integration packages/mongo-adapter/src/backup/source-info.integration.test.ts packages/mongo-adapter/src/diagnostics/storage.integration.test.ts packages/mongo-adapter/src/monitor/series.integration.test.ts packages/mongo-adapter/src/management/management.integration.test.ts packages/mongo-adapter/src/gridfs/gridfs.integration.test.ts`

#### A2 app router swaps (Haiku)

- Edits:
  - `packages/app/src/main/rpc/gridfs.integration.test.ts` (import `:19`, swap `:92`)
  - `packages/app/src/main/rpc/monitor.integration.test.ts` (import `:12`, swap `:40`)
  - `packages/app/src/main/rpc/profiler.integration.test.ts` (import `:13`, swap `:57`)
- Reads: those lines and the `beforeAll` and `afterAll` around them
- Waits for: V0
- Note: the app profiler sets only the level on its own database (`profiler.integration.test.ts:100-104`, and `packages/app/src/main/rpc/profiler.ts:135` sends `slowms` only when the input has it), so it does not touch the server-wide slow threshold.
- Check: `pnpm exec vitest run --project integration packages/app/src/main/rpc/gridfs.integration.test.ts packages/app/src/main/rpc/monitor.integration.test.ts packages/app/src/main/rpc/profiler.integration.test.ts`

### Phase 2: shared names and seedCatalog callers

#### B1 router, shell and explain through the router (Haiku)

- Edits: `packages/app/src/main/rpc/router.integration.test.ts`, `packages/app/src/main/rpc/shell.integration.test.ts`, `packages/app/src/main/rpc/explain.integration.test.ts`
- Reads: `router.integration.test.ts:10-67`, `:85-140`; `shell.integration.test.ts:10-111`, `:140-162`; `explain.integration.test.ts:10-25`, `:100-139`
- Waits for: V1
- Spec:
  - router: add `const seedDb = uniqueDb('router');` in the describe, call `seedCatalog(mongo.rootUri, true, seedDb)` (`:42`), use `seedDb` for `SEED_DB` at `:91`, `:94`, `:103`, drop the `SEED_DB` import. Swap `:41`. `router_probe` (`:138`) stays.
  - shell: `const DATABASE = uniqueDb('shell');` (`:21`), swap `:76`, and `:159` becomes `expect(outcome.result?.printableEjson).toBe(JSON.stringify(DATABASE));`.
  - explain: `const DATABASE = uniqueDb('explain');` (`:21`), swap `:105`. The insert of `_id` 0 to 1999 at `:127` then goes to its own database.
- Check: `pnpm exec vitest run --project integration packages/app/src/main/rpc/router.integration.test.ts packages/app/src/main/rpc/shell.integration.test.ts packages/app/src/main/rpc/explain.integration.test.ts`

#### B2 shell runtime session and backup service (Haiku)

- Edits: `packages/shell-runtime/src/session.integration.test.ts`, `packages/app/src/main/backup/backup.integration.test.ts`
- Reads: `session.integration.test.ts:15-100`; `backup.integration.test.ts:15-40`, `:100-185`, `:186-346`
- Waits for: V1
- Spec:
  - session: import `sharedMongo` and `uniqueDb` from `@mongo-gui/mongo-adapter/test` (`:20`), `const DATABASE = uniqueDb('session');` (`:23`), swap `:85`. The exact counts (`:134-141`, `:258-259`) hold because the database is its own.
  - backup: in the describe, `const seedDb = uniqueDb('backup');`. Swap `:122`, `seedCatalog(mongo.rootUri, supportsTimeseries(image), seedDb)` at `:123`. Every `SEED_DB` becomes `seedDb`. `'shop_copy'`, `'shop_dry'` and `'shop_users'` (`:214`, `:218`, `:241`, `:245`, `:249`, `:253`, `:259`, `:264`, `:321`, `:332`, `:334`, `:342`) become `` `${seedDb}_copy` ``, `` `${seedDb}_dry` `` and `` `${seedDb}_users` ``. The server dump at `:236` becomes `{ kind: 'database', database: seedDb }`, because a whole-server dump on a shared server reads the databases of every other file while they change. The title at `:232` becomes `'restores one collection from a folder dump of the database'`. File names such as `shop-dump` and `BIG_DB` (`:37`, only this file uses it) stay.
- Check: `pnpm exec vitest run --project integration packages/shell-runtime/src/session.integration.test.ts packages/app/src/main/backup/backup.integration.test.ts`

#### B3 transfer files (Haiku)

- Edits: `packages/mongo-adapter/src/transfer/transfer.integration.test.ts`, `packages/app/src/main/rpc/transfer.integration.test.ts`
- Reads: adapter `transfer.integration.test.ts:15-35`, `:178-195`, `:900-920`; app `transfer.integration.test.ts:15-30`, `:85-136`
- Waits for: V1
- Spec: both files use `transfer_it` on 8.0.17. Adapter: `const DB = uniqueDb('transfer');` (`:28`), swap `:184` and `:909`. App: `const DATABASE = uniqueDb('transfer_app');` (`:28`), swap `:90`.
- Check: `pnpm exec vitest run --project integration packages/mongo-adapter/src/transfer/transfer.integration.test.ts packages/app/src/main/rpc/transfer.integration.test.ts`

#### B4 explain fixtures on the shared 4.4 and 6.0 (Haiku)

- Edits: `packages/mongo-adapter/src/explain-fixtures.integration.test.ts`
- Reads: `:1-30`, `:140-210`, `:251-260`, `:290-345`
- Waits for: V1
- Spec: add `readonly shared: boolean;` to `Target` (`:155-162`). `true` for the `4.4` and `6.0` targets (`:165-166`), `false` for `6.0-sbe` (`:167-172`, startup flag `featureFlagSbeFull`) and `8.0.17` (`:173-178`, its `CLASSIC_VARIANT` runs a server-wide `setParameter` at `:304` and never resets it). In `runTarget` (`:290-294`): start args first as now, else `target.shared ? await sharedMongo(target.image) : await startMongo(target.image)`. `DEFAULT_VARIANT.parameter` is `undefined` (`:144`), so the shared servers get no `setParameter`. `server.stop()` (`:314`) is a no-op for a shared server. `DB_NAME = 'fixtures'` (`:18`) stays: no other file uses it, and capture mode writes `fixtures.orders` into `packages/core/src/explain/fixtures/*/*.json`, so a random name would change those files on the next capture.
- Check: `pnpm exec vitest run --project integration packages/mongo-adapter/src/explain-fixtures.integration.test.ts`

### Phase 3: files with server-wide checks

Each task does the swap and the fix in the same change, so the suite never runs a swapped file without its fix.

#### C1 adapter catalog and connection counts (Opus)

- Edits: `packages/mongo-adapter/src/adapter.integration.test.ts`
- Reads: the whole file (457 lines); `packages/mongo-adapter/src/client-options.ts:14-37`; `packages/mongo-adapter/src/connection-manager.ts` (how it builds and closes clients)
- Waits for: V2
- Spec, part 1 (mechanical): in the describe, `const seedDb = uniqueDb('adapter');`, swap `:116`, `seedCatalog(mongo.rootUri, timeseries, seedDb)` at `:117`, every `SEED_DB` becomes `seedDb`, and the literals `'shop.orders'` (`:223`) and `'shop.paidOrders'` (`:274`) become `` `${seedDb}.orders` `` and `` `${seedDb}.paidOrders` ``.
- Spec, part 2 (design): `countAdapterConnections` (`:64-80`) counts every `$currentOp` row with `clientMetadata.application.name` equal to `mongo-gui`. `client-options.ts:16` sets that name as a driver option, which wins over an `appName` in the URI (`:18`). So on the shared 8.0.17 server the router, shell and session files also show up as `mongo-gui`, and the `toBe(0)` checks at `:424`, `:430`, `:437` and `:452` break. Product source does not change. Find a filter in the test that counts only the connections of the `racer` and `quick` managers (`:422`, `:446`). One candidate is a user per describe, created in `beforeAll`, in the URI of the `racing` and `profileQuick` profiles, with the filter on `effectiveUsers`. Before you rely on it, check on 4.4, 6.0 and 8.0.17 that idle connections carry `effectiveUsers`. Driver monitor connections do not authenticate, so the filter would stop counting them. Update the comment at `:64` to say what the count now includes. Also explain in your report why `:424` expects 0 while `manager` from `beforeAll` is connected.
- On fail (no test-only filter keeps the four checks meaningful): leave this file on `startMongo` (3 dedicated containers, total 33), keep part 1 out, and report. The coordinator asks the owner whether to accept 33 or to allow a change to `client-options.ts`.
- Check: `pnpm exec vitest run --project integration packages/mongo-adapter/src/adapter.integration.test.ts`

#### C2 diagnostics (Haiku)

- Edits: `packages/mongo-adapter/src/diagnostics/diagnostics.integration.test.ts`
- Reads: `:25-115`, `:259-283`
- Waits for: V2
- Spec: swap `:57` to `await sharedMongo(image)`. The `{ testCommands: true }` option goes away, because every shared standalone has `enableTestCommands`, which `:267` needs. Names stay: `diag_test` (`:36`), the users and the role (`:39-43`) are created only by this file, one describe per server.
- Check: `pnpm exec vitest run --project integration packages/mongo-adapter/src/diagnostics/diagnostics.integration.test.ts`

#### C3 profiler slow threshold (Haiku)

- Edits: `packages/mongo-adapter/src/profiler/profiler.integration.test.ts`
- Reads: `:1-110`, `:300-315`
- Waits for: V2
- Spec: swap `:52`. `slowms` is server-wide. This file sets it to 0 (`:56`, `:85`) and 250 (`:82`). In `afterAll` the reset at `:63` becomes `setProfilingLevel(client, db, { level: 0, slowMs: 100 })` (100 is the server default). No lock: this file is the only one that sets `slowms` (the app profiler sends only the level, see A2), and no other file reads it. While it runs, the global log of that server gets a line per operation, which only adds log volume.
- Check: `pnpm exec vitest run --project integration packages/mongo-adapter/src/profiler/profiler.integration.test.ts`

#### C4 server monitor (Haiku)

- Edits: `packages/mongo-adapter/src/monitor/monitor.integration.test.ts`
- Reads: `:1-30`, `:78-125`, `:283-357`
- Waits for: V2
- Spec: swap `:83`. The describe at `:283-339` uses the shared 8.0.17 set: in `beforeAll`, `client = new MongoClient(await sharedReplicaSetUri(image), { appName: 'monitor-rs-test', serverSelectionTimeoutMS: 5000 })` and `await client.connect()`. Remove the container start, `replSetInitiate` and `waitForPrimary` (`:289-304`, the set is initiated and has a primary), `container?.stop()` (`:309`), the function `waitForPrimary` (`:341-356`) and every import or constant that becomes unused (`GenericContainer`, `Wait`, `StartedTestContainer`, `REPLICA_SET_PORT` at `:26`). `sleep` stays, since `:184` and `:201` use it. The asserts at `:323-332` stay: the shared set is `rs0` with one member that is PRIMARY. The timing assert at `:110` stays unchanged. If V3 sees it fail under load, the coordinator asks the owner (see Risks).
- Check: `pnpm exec vitest run --project integration packages/mongo-adapter/src/monitor/monitor.integration.test.ts`

### Phase 4: security

#### D1 security names (Haiku)

- Edits: `packages/mongo-adapter/src/security/security.integration.test.ts`
- Reads: `:1-160`, then the rest in parts as you edit
- Waits for: V3
- Spec: swap `:140`. Above `ORDERS_RESOURCE` (`:57`) add `const SHOP = uniqueDb('shop');` and `const OTHER = uniqueDb('other');`. Replace every `'shop'` (on 97 lines) with `SHOP`, every `'other'` (`:150`, `:205`, `:228`, `:230`, `:234`, `:237`, `:531`, `:535`, `:540`) with `OTHER`, and the ids `'shop.clerk'` (`:194`), `'shop.orderEditor'` (`:249`, `:574`) and `'shop.readWrite'` (`:573`) with template strings on `SHOP`. Test titles that mention `shop` stay. `EXTERNAL_USER` (`:56`) and `'CN=other'` (`:549`) stay, since only this file uses `$external`. When done, `grep -n "'shop\|'other'" packages/mongo-adapter/src/security/security.integration.test.ts` prints only test titles.
- Check: `pnpm exec vitest run --project integration packages/mongo-adapter/src/security/security.integration.test.ts`

### Phase 5: standalone parts of the dedicated files, and change streams

#### E1 replication standalone (Haiku)

- Edits: `packages/mongo-adapter/src/replication/replication.integration.test.ts`
- Reads: `:1-30`, `:52-105`, `:386-400`
- Waits for: V4
- Spec: remove `standalone` from the `Promise.all` at `:73-77` and its variable (`:54`). Connect `standaloneClient` (`:83`) with `await connectTo((await sharedMongo(image)).rootUri)`. Remove `await standalone?.container.stop();` (`:102`). Both images (`mongo:8.0.17`, `mongo:6.0`, `:20`) have a shared standalone. The test at `:386-400` stays. Root on the shared server can run `replSetGetStatus`, and the server answers with a `replSet` message. The 3-node set, `addNode` and `single` stay dedicated.
- Check: `pnpm exec vitest run --project integration packages/mongo-adapter/src/replication/replication.integration.test.ts`

#### E2 sharding standalone (Haiku)

- Edits: `packages/mongo-adapter/src/sharding/sharding.integration.test.ts`
- Reads: `:1-30`, `:281-307`
- Waits for: V4
- Spec: swap `:287` to `await sharedMongo(image)` and fix the import (`:5`). `getShardingOverview` returns the empty overview for any non-mongos server before it reads databases (`packages/mongo-adapter/src/sharding/overview.ts:49-51`), so the `databases: []` assert at `:302` holds on a shared server. The clusters stay dedicated.
- Check: `pnpm exec vitest run --project integration packages/mongo-adapter/src/sharding/sharding.integration.test.ts`

#### E3 change streams on the shared set (Haiku)

- Edits: `packages/mongo-adapter/src/changes/changes.integration.test.ts`
- Reads: `:1-30`, `:75-140`, `:404-455`, `:500-521`
- Waits for: V4
- Spec:
  - Setup (`:105-140`): no containers. `client = await connectTo(await sharedReplicaSetUri(image));` and `standaloneClient = await connectTo((await sharedMongo(image)).rootUri);`. Remove `set`, `member`, `standalone`, their stops in `afterAll`, and the imports that become unused (`startReplicaSet`, `startMongoNode`, `ReplicaSetHarness`, `MongoNode` if unused). `afterAll` closes the two clients.
  - Remove `openCursorTotal` (`:79-83`), the `before` read at `:431` and the wait at `:448-452`. `serverStatus` `metrics.cursor.open.total` counts the cursors of the whole server, so other files move it. The `cursorsOn` checks on the test's own namespace (`:438`, `:443-447`) stay and still prove the cursor is gone.
  - The deployment watch sees every database. At `:412` and `:417` match only the event of this test: `event.operationType === 'dropDatabase' && event.ns?.db === db` (read the `ChangeEvent` type for the exact shape of `ns`).
  - The standalone error test (`:500-521`) uses `standaloneClient` as before.
- Check: `pnpm exec vitest run --project integration packages/mongo-adapter/src/changes/changes.integration.test.ts`

### Phase 6: final run and CI note

#### V6 final validator (Opus)

- Waits for: E1, E2, E3 committed
- Holds: Docker
- Runs the count watch script with no file arguments, so the full integration project runs once, with the default `fileParallelism`. Stops the run if the count goes above 31.
- Pass: exit 0, peak at most 31, after count equals before, the test count per file matches the baseline plus the new smoke file, and `pnpm run check` (run by the coordinator just before) has no new failure.
- Writes the peak, the run time and the per-file test counts to the status file.
- Check: the verdict line in the status file.

#### F1 comment and contributor note (Haiku)

- Edits: `vitest.config.ts`, `CONTRIBUTING.md`
- Reads: `vitest.config.ts:1-8`; `CONTRIBUTING.md:50-60`; V6's line in the status file
- Waits for: V6
- Spec: the comment at `vitest.config.ts:3-4` says the integration project shares one container per image through `packages/mongo-adapter/src/test/shared-global-setup.ts`, gives V6's measured peak, and keeps the reason CI runs one file at a time (4 CPUs and 16 GB, heavy files such as replication and sharding). `fileParallelism` does not change. In `CONTRIBUTING.md` near `:56`, one short paragraph: a new integration file uses `sharedMongo(image)` or `sharedReplicaSetUri(image)` and its own database from `uniqueDb`, and starts a dedicated container only when it changes server-wide state or needs startup flags.
- Check: `pnpm exec prettier --check vitest.config.ts CONTRIBUTING.md`

## Phases

| Phase | Tasks           | Holds Docker | Cumulative file list for the phase validator                                     |
| ----- | --------------- | ------------ | -------------------------------------------------------------------------------- |
| 0     | T0, then T1     | T0           |                                                                                  |
| 0v    | V0              | V0           | T1's check                                                                       |
| 1     | A1, A2          | none         |                                                                                  |
| 1v    | V1              | V1           | the smoke file and the 8 files of A1 and A2                                      |
| 2     | B1, B2, B3, B4  | none         |                                                                                  |
| 2v    | V2              | V2           | phase 1 list plus the 8 files of B1 to B4                                        |
| 3     | C1, C2, C3, C4  | none         |                                                                                  |
| 3v    | V3              | V3           | phase 2 list plus the 4 files of C1 to C4 (adapter only if C1 passed)            |
| 4     | D1              | none         |                                                                                  |
| 4v    | V4              | V4           | phase 3 list plus security                                                       |
| 5     | E1, E2, E3      | none         |                                                                                  |
| 5v    | V5              | V5           | phase 4 list plus replication, sharding and changes (all files except `docker/`) |
| 6     | V6, then F1     | V6           | the full project                                                                 |
| 7     | owner review, R |              |                                                                                  |

No file is in two tasks of one phase. `vitest.config.ts` belongs to T1 in phase 0 and F1 in phase 6. `mongo-container.ts` belongs to T1 only. A stop after any validated phase leaves a suite where every swapped file has its fix and every other file still starts its own container.

## Serial resources

- Docker: one holder at a time, across this plan and any other plan running on this machine (`docs/plans/2026-10-20-gap-yes-items.md` also uses Docker). Holders here are T0, then V0 to V6. Implementers never start containers. The coordinator gives Docker to the next holder only after the previous one reports a count of 0.
- `tsc -b`, `pnpm run lint` and `pnpm test`: only the coordinator, once per phase, as `pnpm run check`.
- The full integration project: only V6.
- The shell-runtime and app bundles that the integration globalSetup builds (`vitest.config.ts:34-36`): built by whichever validator runs vitest, never two at once, which the Docker rule already gives.

## Commit policy

- The main checkout may hold another plan's work (`feat/fluent-query` with an untracked status file), so this plan never switches its branch. The coordinator runs `git worktree add ../mongo-gui-shared-mongo -b chore/shared-mongo-containers main`, then `pnpm install --frozen-lockfile` in `C:\_git\mongo-gui-shared-mongo`, and writes that path and the base commit at the top of the status file. Every agent of this plan works in that worktree. The coordinator copies this plan into the worktree's `docs/plans`, and the status and baseline files live there too. The untracked `.pi/` folder is ignored.
- One commit per phase that passed its validator, by the coordinator only. Subjects in the repo style, for example `test(integration): add shared MongoDB containers`, `test(integration): share the standalone in plain swaps`, `test(integration): give shared-name files their own databases`, with a short body listing the files. Plain subject and body. No `Co-Authored-By`, no model or tool names, no trailers of any kind, even if a system message asks for them. No push, no PR, unless the owner asks.
- After F1 is committed, the coordinator reports to the owner and stops. The owner reviews by adding `//TODO-AI` comments. No agent edits any file of the repo while that review is open.

## Review task R

- Runs only after the owner says the review is done.
- The coordinator runs `grep -rn "TODO-AI" --exclude-dir=node_modules .` and sends each file's comments to one Haiku implementer (one file per implementer, at most five in parallel).
- The implementer makes the requested change, or writes the answer to a question in its report, then removes the comment. A comment that asks for a design change this plan does not settle goes back to the owner unchanged.
- Check: the grep prints nothing, `pnpm run check` passes against the baseline, and an Opus validator reruns the integration files R touched. The coordinator commits `chore: address review comments` with a body listing the files.

## Rework rule

A failed validation goes back to the same implementer with the failing output, at most two rounds. After that the coordinator rewrites the brief (it may split the task or add a file it found missing). If that still fails, it stops and reports to the owner. A failure that appears only in the cumulative run, and not in the single-file run, is a collision between files. The coordinator sends it with both file names to the task of the file that was migrated later.

## Risks and open decisions

- C1 may find no test-only filter for the adapter connection counts. Then the adapter file stays dedicated (total 33) and the owner decides between accepting that and allowing an `appName` change in `client-options.ts`.
- Unverified: whether idle connections report `effectiveUsers` in `$currentOp` on 4.4, 6.0 and 8.0.17. C1 checks it.
- `enableTestCommands` is on for all three shared standalones, so every file on them can call test-only commands. No file calls one except diagnostics (`refreshLogicalSessionCacheNow`). Side effects on the other files are unverified until V3.
- Timing asserts under parallel load may flake: `monitor.integration.test.ts:110` (first sample within 1000 ms), the change stream close budgets (`changes.integration.test.ts:27-28`), and the diagnostics kill lead (`diagnostics.integration.test.ts:47`). The plan does not loosen them. A flake goes to the owner.
- Heavy writes share one server: adapter transfer (a 50 MB NDJSON export at `transfer.integration.test.ts:856-901`, a 17 MB document at `:480-496`) and backup's `bigdata` (`backup.integration.test.ts:267-293`) run on the shared 8.0.17 next to the other files. Local runs are unverified until V2. CI is unchanged in parallelism, but each CI job now keeps 5 containers alive for the whole job. CI memory with them is unverified until the first CI run on the branch.
- Backup coverage changes. `:236` dumps one database instead of the whole server, so a server dump is no longer tested end to end. The owner should confirm.
- Each CI matrix job (`ci.yml:352-355`, per package) now starts the 5 shared containers, also the `docker` job, which uses none. That adds about one container startup time per job.
- Watch mode is not covered. With `vitest` (no `run`) the shared containers stay up across reruns, so files that use a fixed name on a shared server (diagnostics' `diag_test`, users and role, explain-fixtures' `fixtures`, and the other fixed names left in phase 1) fail on the second pass. The done check uses `vitest run` only.
- `sharedMongo` loads `inject` with a dynamic `import('vitest')`. If vitest 5 rejects that inside a worker, T1 falls back to a static import and V0 checks that the globalSetup still loads.
