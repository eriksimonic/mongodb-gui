# Architecture redesign handoff

Status as of 2026-10-14. Waves 0 and 1 are done (commits `48234b5` to `aa447f9`, on branch `architecture-redesign`). Waves 2 and 3 and the items under "Left over from waves 0 and 1" are open.

## Goal

The app is hard to follow because one feature is spread over many places, and the UI has no shared toolkit, so every feature writes its own loading, error, polling, dialog and table code. The aim is:

- One folder per feature in each layer, with the same name in every layer.
- Each feature folder has an `index.ts`. Code outside the folder imports only from it.
- Feature folders do not import each other. A helper with two or more users moves to a shared place.
- Fewer, less overlapping tests.

No new abstraction layers. The zod RPC contract in `core/src/rpc/contract.ts` is already the typed interface between UI and backend, and it stays as is. Do not add per-feature interfaces, adapter classes or dependency injection. A shared kit item is added only when it replaces code in two or more places, and the commit names those places.

## What is already sound (do not change)

- `core/src/rpc/contract.ts`: 188 calls in 29 namespaces, zod input and output schemas. The renderer client, the router and the browser mock are all typed against it.
- Package layers have no cycles. `ui` imports only `@mongo-gui/core`. `core` has no driver import. Only `mongo-adapter` (and `shell-runtime`, `docker`) use the `mongodb` driver.
- IPC is one channel, `rpc:invoke`, plus `rpc:event`. Preload is 21 lines.
- `mongo-adapter` exposes free functions per feature that take a `MongoClient`. Keep that.

## Target layout

```
packages/
├── core/src/
│   ├── rpc/                 unchanged
│   ├── ejson/               the only EJSON parse/stringify (today 5+ copies)
│   ├── domain/errors.ts     the only AppError helpers (validationError, redactAppError today exist twice)
│   └── <feature>/index.ts   types, schemas, pure logic
├── mongo-adapter/src/<feature>/index.ts   driver calls only
├── app/src/main/rpc/
│   ├── router.ts            combines feature files, target well under 500 lines
│   ├── operation.ts         entry, driverCall, Operation (done)
│   └── <feature>.ts         createXService(deps) → { operations(), stop hooks }
└── ui/src/
    ├── api/                 ui-api.ts, mock-rpc-client.ts (combines feature mocks), mock-support.ts
    ├── state/               app-wide store only
    ├── screens/             shell layout, tab host
    ├── theme/               plus monitor/palette.ts
    ├── kit/                 shared UI pieces, never imports a feature
    └── <feature>/
        ├── index.ts         public interface
        ├── mock.ts          feature mock, imported directly by api/mock-rpc-client.ts
        └── ...              components, model, store, tests
```

`ui/src/components/` disappears. Its subfolders become feature folders: backup, connections, generate, gridfs, management, security, settings, sharding, tools, transfers, updates. `components/editor` merges into `ui/src/editor`.

## Pattern, as done for profiler (copy this)

See `git show d471f76`.

App side:
- `rpc/profiler.ts` exports `createProfilerService({ port, getClient, emit })`. It returns `operations()` (the `entry(...)` list), `stopConnection(id)` and `stopAll()`. The state it owns (live tails) lives inside it.
- `router.ts` builds the service, spreads `...profiler.operations()` into the operations map, and calls the stop hooks from `rendererResets`, `onStatusChange` and `lockEvents`.
- The test-injected port type (`ProfilerPort`) lives in the feature file. `RouterDeps` imports the type.
- The client type is derived from an adapter function (`Parameters<typeof getProfilingLevel>[0]`), so the feature file never imports `router.ts`. No import cycles.
- Router tests for the feature are named `<feature>.test.ts`.

UI side:
- `profiler/index.ts` exports only what outside code uses.
- Two kinds of import may bypass the index. Lazy `import('../x/XPanel')` in `screens/ShellPanels.tsx` stays direct to keep code splitting. Mocks and fixtures are imported directly, so mock code is never part of the index the production app loads.
- Mocks moved from `api/mock-<feature>*.ts` to `<feature>/mock*.ts`.
- Split test files for one component (`X.test.tsx` plus `X.scenarios.test.tsx`) are merged. Identical helpers are removed and the test count must not change.

Existing helpers to build on: `router.ts` already has `managementOperations()`, `shardingOperations()`, `securityOperations()`, `diagnosticsOperations()` and a `managed()` helper. These lift out almost unchanged. `monitor-service.ts`, `transfer-service.ts`, `generate-service.ts` and `replication-plans.ts` already follow the service shape and should be renamed or folded into `<feature>.ts`.

## Remaining work

### Waves 0 and 1: done

| Commit | What |
|---|---|
| `48234b5` | Wave 0. Helpers move to `kit/` and `theme/`. `JsonEditor`, `ReadOnlyCode` and their Monaco files move to `kit/code/`. The mongosh tokenizer is split into `kit/code/mongosh-tokens.ts`, so the viewer no longer imports the editor. One `validationError` in core. The strict canonical EJSON helpers merge into adapter `ejson.ts`. The `killcursors` test now uses op `'other'`, which is what the normaliser returns. |
| `2636e2a` | Group A, monitor and diagnostics. `managed` and `readOnly` move to `operation.ts` as `connectionCalls(getClient, emit)`. `kit/use-polling.ts` replaces the interval effects in LogsTab, TopTab, OperationsPanel and ReplicationPanel. |
| `9857b40` | `DestructiveDialog` becomes `kit/ConfirmDialog.tsx`. It already had six users. |
| `538576a` | Groups B, C and D in one commit, because they ran in parallel and share edits in router.ts and mock-rpc-client.ts. Path checks shared by router, gridfs and transfers are in `rpc/picked-paths.ts`. |
| `aa447f9` | Groups E and F. `createAppServices`, the backup tools factory and `createRepos` move to `rpc/app-services.ts`. |

Results:
- `router.ts` is 588 lines (was 2,562). Each namespace has its own `rpc/<feature>.ts`. Stateless features export `<feature>Operations(deps)`. Features with state export `create<Feature>Service(deps)` with `operations()` and stop hooks.
- `ui/src/components/` is gone. Every feature folder has an `index.ts`, and its mocks are in the folder.
- Router tests are named `<feature>.test.ts`. Split test files were merged with the same test counts: top-sort, IndexesPanel, replication plans, ConnectionTree and tree-model.

Deviations from the plan:
- The monitor service names its RPC list `rpcOperations()`, because `operations()` is already the `monitor.operations` call.
- The two `redactAppError` copies stay. The security one redacts passwords from a secrets list. The shell one also redacts URIs in the message.
- The relaxed EJSON parse in adapter `changes/helpers.ts` and the lenient parse in `explain/run-explain.ts` do different jobs from the strict one, so they stay.
- `use-loadable.ts` was not added. Diagnostics already has a `Loadable` store, and no two components share one loading pattern.
- `ErrorAlert`, `EmptyState` and `DataTable` were not added.

### Left over from waves 0 and 1

- `formatBytes` has six copies, with slightly different output: diagnostics, monitor, `kit/input-rules`, sharding, gridfs and profiler. Merging them changes the displayed text, so pick one format first and update the tests.
- Cross-feature imports that remain all go through the other folder's `index.ts`. Check them with grep and decide which ones should move to `kit/`: transfers → monitor (formatBytes), tools/settings → diagnostics (formatBytes), changes → results (TreeView), results → schema, results → management (DocumentEditorDialog), schema → management, explain → profiler, backup → tools and transfers, connections → several features, settings → `screens/` files.
- `api/` still holds the mocks shared by several features: mock-catalog, mock-support, mock-fixtures, mock-bson-fixtures, mock-picks and connected-mock. It also holds explain-lab.ts and explain-fixture-panels.ts.
- `ErrorAlert` (about 40 files render `<Alert>` for errors) and `EmptyState`: check first whether the markup is really the same, because the screenshots must not change.
- `RouterDeps` and the other router interfaces are still in `router.ts`. Feature files declare small structural types instead of importing them.
- The `explain-target` typecheck error is fixed. Typecheck now reports 0 errors.

### Wave 2: tests (parallel, after wave 1 per area)

Facts from the scan: 409 test files, about 6,790 tests at runtime (6,734 pass, 55 skipped), about 84k test lines against about 100k source lines. Most packages have 1.0 to 1.5 test lines per source line. UI has 0.44. e2e has 3 tests.

Rules:
- Pure logic is tested once, in `core`.
- Adapter tests run against a real MongoDB (they already do, via testcontainers). Do not repeat their assertions with fakes elsewhere.
- Router tests check wiring and error mapping per feature, table-driven (`it.each`), not one hand-written test per error code.
- UI tests check panel behaviour. They do not re-check what core's model tests already check.

Candidates:
- `app/src/main/rpc/router.test.ts` (1,863 lines, 76 cases): split by feature to match the router split, then turn the error-mapping cases into tables.
- `core/src/sql`: 13.2k test lines. `break-hostile-input.test.ts` and `break-hostile-input-2.test.ts` cover the same area. `translate.test.ts` (3,065 lines, 246 cases) has single-case `it`s that suit `it.each`.
- Explain is tested in core (normalise, rewrite), adapter (`run-explain.test.ts`), app (`explain.integration.test.ts`), ui model and ui panel. Check which panel and model tests re-assert core normalise output.
- `app/src/test/build-shell-runtime.ts` and `shell-runtime/src/test/build-global-setup.ts` may both build the shell-runtime bundle. Both run as globalSetup.
- Before deleting a test, confirm another test covers the same behaviour. A test with a unique assertion stays.

### Wave 3: later, needs investigation first

- `ui/src/state/app-store.ts` (1,380 lines) and `editor-actions.ts` (866): find which parts belong to a feature, after wave 1 shows what is left.
- `ui/src/api/explain-lab.ts` imports `../../../../dev/explain-lab/queries.js?raw`, from outside the package.

## Running agents

- Haiku agents do the mechanical work: moves, import rewrites, test merges. The coordinator gives exact file lists and line references, reviews each diff, and runs the checks.
- Agents must not commit. The coordinator commits on main, one commit per group. No `Co-Authored-By` or tool attribution lines.
- Agents use `git mv` for moves so history follows the files.

## Checks and known baseline

Run from the repo root: `pnpm typecheck`, `pnpm lint`, `pnpm vitest run --project unit`.

Baseline at `aa447f9`:
- Typecheck: 0 errors.
- Lint: 0 errors, 9 warnings (react-hooks `incompatible-library` on `useVirtualizer`).
- Unit: 6,786 pass, 10 skipped, with 3 load-related failures in the full run. `management/DocumentsPanel.test.tsx` "loads up to 200 documents when Load more is pressed", and the Monaco suites `editor/language-tokens.test.ts` and `editor/MongoshMonaco.test.tsx` (beforeAll timeout loading Monaco), sometimes fail under load. All pass when run alone. Re-run them alone before blaming a change.
- The skipped count went from 55 at `d471f76` to 10. The cause was not investigated. No `.skip` was added, so check whether the old figure counted something else before trusting either number.
- Integration: the app rpc integration tests pass (7 files, 42 tests). The other packages' integration tests were not run.
- Integration tests (`pnpm test:integration`) need Docker. Run the integration tests of the area you change before committing.
- If a group changes what `docs/screenshots` shows, refresh them as `CLAUDE.md` describes.
