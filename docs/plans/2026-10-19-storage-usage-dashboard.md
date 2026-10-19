# Storage usage dashboard

Status: draft, waiting for user approval. Do not start any task before that.

## Goal and done check

Add a read-only dock panel, "Storage", that shows disk usage per database, per collection and per index, so a user can find where the space goes.

Done when all of these hold:

- `pnpm run check` passes with no new failures compared with the baseline (T0).
- `pnpm run test:integration` passes for the new adapter test against a real MongoDB.
- In the browser mock UI (`pnpm dev:ui`, 1536x1024, dark theme) a validator opens Storage from a connection, drills database to collection to indexes, and sees the treemap, the table and the insight cards filled.
- The Electron app is restarted and runs the new build (T11).
- Nothing is committed.

## Decisions already made (the user said "surprise me", so these are the planner's)

Panel behaviour:

- One panel per connection, id `storage:<connectionId>`, title `<name> storage`, opened from the connection context menu (Monitoring submenu, next to Diagnostics) and from a database row context menu ("Storage usage", opens the same panel focused on that database).
- Top bar: breadcrumb (`Server > shop > orders`), a metric toggle (Storage size, Data size, Index size), a name filter, a Refresh button, and a "Loaded at HH:MM:SS" label.
- Disk strip: when `fsTotalSize` is known, a bar shows used and free disk with the sum of database sizes inside it.
- Treemap: hand-rolled, squarified, plain divs. Level 1 shows databases, level 2 the collections of a database, level 3 one collection split into data, free (reclaimable) and each index. Click a tile to drill down, breadcrumb to go up. Tile label shows name and size. Tooltip shows all numbers.
- Table beside the treemap: AG Grid (already in `packages/ui`), sortable, columns depend on the level. Collection level columns: name, docs, avg doc, data size, storage size, free, index size, index share %, compression ratio (data / storage). Row click drills down. Index level columns: name, size, % of the collection, operations since start, last reset.
- Insight cards above the treemap (computed in the UI from loaded data, no extra server calls):
  - Biggest 5 collections.
  - Biggest 5 indexes.
  - Indexes with 0 operations since the server started, with their total size ("unused, candidates to drop"). Shown with the caveat text "counted since <date>".
  - Collections whose index size is larger than their data size.
  - Reclaimable space (sum of `freeStorageSize`), shown only when the server reports it.
- Loading is lazy and gentle (see Server load rules). Databases load first, collections load when the user opens a database (or when a database tile is clicked). Results are cached in the panel store until Refresh.
- Empty, loading, error and "no permission" states are explicit. A per-collection error shows the row greyed with the message, and never breaks the rest.

Server load rules (nice to the server):

- Only read commands. No writes, no `collMod`, no `compact`.
- `listDatabases` once. `dbStats` on `admin` once for `fsUsedSize` and `fsTotalSize`, failure ignored.
- Per database, only on demand: `listCollections` (skip views), then for each collection one aggregate `$collStats: { storageStats: { scale: 1 } }` and one aggregate `$indexStats`, each with `maxTimeMS: 5000`.
- At most 2 collections in flight at a time, per call. No parallel databases.
- A failure on one collection becomes an entry with `error` set and zeros. It never throws for the whole database.
- No auto refresh. No polling.

## Constraints and do-not-change

- Read-only. No new write path, no new confirm dialog.
- `docs/screenshots` is pinned to six files. Do not add any. Do not refresh them in this work unless a validator shows an existing screenshot became wrong (it should not).
- Do not change existing RPC call names or schemas. Only add.
- No new runtime dependency. No treemap library.
- Match the surrounding code style. Functions over classes. Named exports only. No new abstraction layers (see the user's CLAUDE.md).
- Prose in docs and comments follows `~/.claude/skills/unslop/SKILL.md`.
- No commit. No `Co-Authored-By` lines anywhere.
- Test and script output images go to `e2e/output`.

## Contract (every task uses these exact names)

Two new calls under `rpcContract.diagnostics`, both read-only, both take `connectionParam`:

- `storageDatabases`: input `connectionParam`. Output `StorageDatabasesSchema`:
  - `databases: { name: string, sizeOnDisk: number, empty: boolean }[]`
  - `fsUsedSize: number | null`, `fsTotalSize: number | null`
- `storageCollections`: input `connectionParam.and(DatabaseTargetSchema)` (existing schema in `packages/core/src/diagnostics/calls.ts:52`). Output `StorageCollectionsSchema`:
  - `database: string`
  - `collections: StorageCollection[]`

`StorageCollection`:

- `name: string`
- `type: 'collection' | 'timeseries'`
- `count: number`
- `dataSize: number` (from `storageStats.size`)
- `avgObjSize: number`
- `storageSize: number`
- `freeStorageSize: number | null` (null when the server does not report it)
- `totalIndexSize: number`
- `indexes: { name: string, size: number, ops: number | null, since: string | null }[]` (`ops` and `since` are null when `$indexStats` failed or was denied; `since` is an ISO date)
- `error: string | null`

Names in code:

- Core schemas: `StorageDatabasesSchema`, `StorageCollectionsSchema`, `StorageCollectionSchema` in a new file `packages/core/src/diagnostics/storage.ts`, with inferred types `StorageDatabases`, `StorageCollections`, `StorageCollection`.
- Adapter functions: `getStorageDatabases(connection)` and `getStorageCollections(connection, database)`, in a new file `packages/mongo-adapter/src/diagnostics/storage.ts`.
- UI files live in a new folder `packages/ui/src/storage/`. The dock component is `StoragePanel` in `StoragePanel.tsx`. The dock kind and panel request kind is `'storage'`. The id helper is `storagePanelId(connectionId)` in `node-ids.ts`, returning `storage:<connectionId>`.

## Baseline (T0 writes the result here)

Commands: `pnpm run lint`, `pnpm run typecheck`, `pnpm test`, `pnpm run test:integration`.
Record which of them fail before any change, with the failing test names, in `docs/plans/storage-usage-dashboard.baseline.md`. No later agent blames a failure listed there on its own work.

## Pattern to copy

The dbStats/collStats path, end to end:

- `packages/core/src/rpc/contract.ts:469-479` (contract entry)
- `packages/core/src/diagnostics/calls.ts:52-55` (input schemas)
- `packages/core/src/schemas/catalog.ts:42-63` (output schema)
- `packages/core/src/security/data.ts:167-179` (command name list; only touch it if a command used here is missing, `collStats`, `dbStats`, `listDatabases`, `listCollections`, `aggregate` with `$collStats`/`$indexStats`)
- `packages/mongo-adapter/src/catalog.ts:228-272` (implementation)
- `packages/mongo-adapter/src/diagnostics/server.ts:29`, `packages/mongo-adapter/src/index.ts:6-7` (exports)
- `packages/app/src/main/rpc/diagnostics.ts:17-22` and `:87-92`, `packages/app/src/main/rpc/operation.ts:49-80` (`readOnly` wiring)
- `packages/ui/src/api/mock-rpc-client.ts:337-369`, `:599-606`, `packages/ui/src/diagnostics/mock.ts:30-31`, `:139-146` (mock)
- UI panel: `packages/ui/src/diagnostics/DiagnosticsPanel.tsx`, `diagnostics-store.ts:76-100` (`read(key, fetch)` store), `StatsPanels.tsx:15-20` (`useRead`)
- Panel registration: `ShellScreen.tsx:~82-107`, `:~293-315`, `:~541-546`, `ShellPanels.tsx:~222-232`, `:~686-688`, `packages/ui/src/state/panel-opener.ts`, `packages/ui/src/connections/ConnectionContextMenu.tsx:~118-147`
- Test patterns: `packages/mongo-adapter/src/diagnostics/diagnostics.integration.test.ts`, `packages/core/src/schemas/catalog.test.ts:38-86`, `packages/ui/src/diagnostics/DiagnosticsPanel.test.tsx`

## Tasks

Each task: edit only the listed files, read the listed files, run its check, report in at most 10 lines. Implementers are Haiku, validators are Opus. The coordinator is Sonnet.

### T0 baseline (Haiku, discover)

- Edits: `docs/plans/storage-usage-dashboard.baseline.md`
- Reads: root `package.json`
- Waits for: nothing
- Check: file lists each of the four commands with pass or fail and failing test names.

### T1 core schemas and contract (Haiku)

- Edits: `packages/core/src/diagnostics/storage.ts` (new), `packages/core/src/diagnostics/index.ts` (export, if an index exists, else the nearest barrel), `packages/core/src/rpc/contract.ts`, `packages/core/src/diagnostics/storage.test.ts` (new)
- Reads: pattern files for core listed above
- Waits for: T0
- Check: `pnpm --filter @mongo-gui/core exec vitest run storage` passes (parses a valid sample, rejects a negative size and a missing `name`).

### T2 pure UI helpers (Haiku)

- Edits (all new): `packages/ui/src/storage/squarify.ts`, `squarify.test.ts`, `insights.ts`, `insights.test.ts`, `format.ts`, `format.test.ts`
- Reads: `packages/ui/src/diagnostics/StatsPanels.tsx` (how sizes are formatted today, reuse its formatter if one exists instead of writing `format.ts`; then drop `format.*` from this task)
- Waits for: T0
- Spec:
  - `squarify(items: {id: string, value: number}[], width: number, height: number): {id, x, y, w, h}[]` implements the squarified treemap algorithm (Bruls, Huizing, van Wijk). Items sorted by value descending, zero or negative values dropped, output rectangles tile the box with no overlap and total area equals the box area within 1e-6.
  - `insights.ts` takes the loaded `StorageCollection[]` of one or more databases (each tagged with its database name) and returns: top 5 collections by `storageSize`, top 5 indexes by size, unused indexes (`ops === 0`, excluding `_id_`) with their summed size, collections where `totalIndexSize > dataSize`, and the sum of `freeStorageSize` (null when none report it). Types are plain TS objects.
  - Tests cover empty input, one item, equal values, a null `ops`, and the `_id_` exclusion.
- Check: `pnpm --filter @mongo-gui/ui exec vitest run storage` passes.

### T3 adapter implementation (Haiku)

- Edits: `packages/mongo-adapter/src/diagnostics/storage.ts` (new), `packages/mongo-adapter/src/diagnostics/server.ts` (re-export), `packages/mongo-adapter/src/index.ts` (export), `packages/mongo-adapter/src/diagnostics/storage.integration.test.ts` (new)
- Reads: `packages/mongo-adapter/src/catalog.ts:228-272`, `diagnostics.integration.test.ts`, T1 output `packages/core/src/diagnostics/storage.ts`
- Waits for: T1
- Spec: follow "Server load rules" above exactly. Concurrency limit of 2 is a tiny in-file loop, no library. `$collStats` on a timeseries collection: try the collection namespace, and if it errors, return the entry with `error` set.
- Integration test creates a database with two collections, a secondary index, one capped or timeseries collection, and a view. It asserts: the view is absent, counts are right, `indexes` contains `_id_` and the secondary index, a result parses with the core schema, and a nonexistent database returns an empty `collections` array.
- Check: `pnpm run test:integration -- storage` passes (needs Docker, see serial resources).

### T4 app wiring and coverage map (Haiku)

- Edits: `packages/app/src/main/rpc/diagnostics.ts`, `e2e/coverage-map.ts`, `packages/core/src/security/data.ts` (only if a needed command is missing)
- Reads: `packages/app/src/main/rpc/operation.ts:49-80`, `e2e/coverage-map.ts:105-118`
- Waits for: T1, T3
- Spec: register both calls with `readOnly('diagnostics.storageDatabases', ...)` and `readOnly('diagnostics.storageCollections', ...)`. In the coverage map, mark both calls `excluded` with the same wording the neighbouring diagnostics entries use.
- Check: `pnpm run typecheck` passes and `pnpm exec tsx e2e/coverage-check.ts` (or the script named in root `package.json`) passes.

### T5 mock client (Haiku)

- Edits: `packages/ui/src/storage/mock.ts` (new), `packages/ui/src/diagnostics/mock.ts`, `packages/ui/src/api/mock-rpc-client.ts`
- Reads: pattern files for the mock above, T1 output
- Waits for: T1
- Spec: the mock serves 3 databases (`shop`, `analytics`, `logs`) with 4 to 8 collections each, realistic spread (one collection with 10x the size of the others, one with an index bigger than its data, two indexes with `ops: 0`, one with `ops: null`, one collection with `error: 'not authorized'`, `freeStorageSize` set on some and null on others), plus `fsTotalSize` 512 GB and `fsUsedSize` 301 GB. Deterministic numbers, no `Math.random`. Latency follows the other mock calls.
- Check: `pnpm run typecheck` passes.

### T6 panel components (Haiku)

- Edits (all new): `packages/ui/src/storage/storage-store.ts`, `StoragePanel.tsx`, `Treemap.tsx`, `StorageTable.tsx`, `InsightCards.tsx`, `DiskStrip.tsx`
- Reads: `packages/ui/src/diagnostics/DiagnosticsPanel.tsx`, `diagnostics-store.ts`, `StatsPanels.tsx`, T2 outputs, T1 types, an existing AG Grid usage in `packages/ui/src` (grep `AgGridReact`) for theme and setup
- Waits for: T2, T5 (the panel must render against the mock)
- Spec: implement "Decisions already made, Panel behaviour". The store follows the `createDiagnosticsStore` shape and caches by key (`databases`, `collections:<db>`). Drill state is `{ database?: string, collection?: string }` kept in the component, not in the store. Colours come from Mantine theme tokens, no hex literals. Treemap tile colour encodes the metric share, index tiles use a second hue. Keyboard: Enter on a focused tile drills down, Backspace goes up. Each tile and row has a `data-testid` of the form `storage-tile-<id>` and `storage-row-<id>`.
- Check: `pnpm run typecheck` and `pnpm run lint` pass for these files.

### T7 registration and menus (Haiku)

- Edits: `packages/ui/src/screens/ShellScreen.tsx`, `packages/ui/src/screens/ShellPanels.tsx`, `packages/ui/src/state/panel-opener.ts`, `packages/ui/src/state/node-ids.ts`, `packages/ui/src/connections/ConnectionContextMenu.tsx`
- Reads: the registration line ranges listed under "Pattern to copy", T6 file `StoragePanel.tsx` (name and props only)
- Waits for: T6
- Spec: register component `storage` (lazy-loaded like `monitor`), icon `IconDatabase` or `IconChartTreemap` if the installed icon set has it, `openStoragePanel` placed next to `welcome` like diagnostics, menu item "Storage" in the Monitoring submenu, disabled unless connected. The database-row menu item "Storage usage" lives in the database context menu file; if that file is not in the list above the implementer reports its path and stops, and the coordinator adds it to this task.
- Check: `pnpm run typecheck` passes.

### T8 component test (Haiku)

- Edits: `packages/ui/src/storage/StoragePanel.test.tsx` (new)
- Reads: `packages/ui/src/diagnostics/DiagnosticsPanel.test.tsx`
- Waits for: T7
- Spec: render with `connectedMockApi`. Assert: database tiles appear; clicking `shop` shows its collections; clicking the big collection shows its indexes; the unused index card lists an index with 0 ops; the error collection shows its message; switching the metric changes the tile order or size label.
- Check: `pnpm --filter @mongo-gui/ui exec vitest run StoragePanel` passes.

### T9 docs (Haiku)

- Edits: `docs/user-guide.md`
- Reads: `docs/user-guide.md` (Diagnostics section for the style), this plan (Decisions section)
- Waits for: T7
- Spec: a short "Storage usage" section: how to open it, what each view shows, what the unused-index card means and its caveat, and what the server does (read-only commands, two collections at a time, nothing runs until a database is opened). Follow unslop. No new screenshot.
- Check: validator reads it against the shipped UI.

### V1 to V4 validators (Opus)

- V1 after T1 and T2: reruns their checks, reads the diff, checks the contract names match this plan.
- V2 after T3 and T4: reruns the integration test, reads the adapter diff for write commands (there must be none), the concurrency limit, `maxTimeMS` and per-collection error handling.
- V3 after T5 to T8: reruns the checks, then uses the browser mock UI (see serial resources) and walks the done check. Looks at a screenshot of each level (databases, collections, indexes). Screenshots go to `e2e/output`, not `docs/screenshots`. Reports visual defects with the level and what is wrong.
- V4 after T9 and T10: full `pnpm run check`, compares failures with the baseline, reads the whole diff once for unslop and for stray files (`git status` must show only the planned files, no staged changes, no new files in `docs/screenshots`).

### T10 e2e smoke (Haiku)

- Edits: `e2e/wiring/journeys/standalone/storage.spec.ts` (new)
- Reads: `e2e/wiring/journeys/standalone/diagnostics.spec.ts`
- Waits for: T7, V3
- Spec: open Storage on the standalone journey connection, expect a database tile, click it, expect a collection row. Remove the `excluded` entries for the two storage calls in `e2e/coverage-map.ts` and point them at this journey.
- Check: `pnpm run test:wiring -- storage` passes (needs Docker).

### T11 restart the app (Sonnet, coordinator)

- Edits: none
- Waits for: V4
- The run-app skill is written for Linux (`fuser`, `pkill`). On this Windows machine use PowerShell: stop the Electron processes started from this repo and the dev server on port 5173, then start `pnpm exec electron-vite dev` from `packages/app` in the background (see `.claude/skills/run-app/SKILL.md` line 23 for the flags), and confirm the log shows `shell state changed`. Run `pnpm --filter @mongo-gui/app run build:shell-runtime` first only if `packages/shell-runtime` changed (it should not).
- Check: the log shows a running dev app and no startup error. Report the log path to the user. Do not commit.

## Phases

| Phase | Tasks that run together | Notes |
| --- | --- | --- |
| 0 | T0 | |
| 1 | T1, T2 | disjoint files |
| 1v | V1 | |
| 2 | T3, T5 | T3 waits for T1, T5 waits for T1; disjoint files |
| 3 | T4, T6 | T4 waits for T3, T6 waits for T2 and T5; disjoint files |
| 3v | V2 | |
| 4 | T7 | |
| 5 | T8, T9 | disjoint files |
| 5v | V3 | |
| 6 | T10 | |
| 6v | V4 | |
| 7 | T11 | |

File overlap check: `e2e/coverage-map.ts` is touched by T4 (phase 3) and T10 (phase 6), never in the same phase. `packages/ui/src/diagnostics/mock.ts` and `mock-rpc-client.ts` belong to T5 only.

## Serial resources

- Docker (testcontainers): T3 and T10 and V2 use it. Run one at a time, the coordinator holds the lock. Never two Docker tasks in one phase (T3 in phase 2 and T10 in phase 6 are already apart; V2 runs after phase 3).
- `tsc -b` and `pnpm run typecheck`: two parallel runs corrupt the build output. Within a phase only one task runs a root typecheck. Implementers in the same phase run their package-scoped vitest command and leave the root typecheck to the coordinator, who runs it once after the phase and reports failures to the owner of the file.
- Browser and the mock UI dev server (`pnpm dev:ui`, port 5174): only V3 uses it, started and stopped by V3.
- Electron dev app and port 5173: only T11.

## Rework rule

A failed validation goes back to the same implementer with the failing output, at most two rounds. After that the coordinator rewrites the brief, and if it still fails, stops and reports to the user.

## Risks and open decisions

- `$collStats` on timeseries and on sharded clusters may behave differently. The plan treats it as a per-collection error, not a failure. Sharded totals are out of scope for this version (mongos returns per-shard data and the panel shows what the call returns).
- `freeStorageSize` is missing on old servers. The UI hides reclaimable space then. Integration runs against whatever image `mongo-container` defaults to, which covers one version only.
- `$indexStats` needs the `indexStats` privilege on some setups. A denial gives `ops: null` and the unused-index card says it could not check.
- A database with thousands of collections takes thousands of calls at 2 in flight. The panel shows progress and a Cancel button is not planned. If this matters, add a limit and a "load the next 200" button later.
- The Linux-only run-app skill steps are adapted by hand in T11. If the dev app does not start on Windows from PowerShell the coordinator stops and reports.
- T7 may need one more file (database context menu). The brief says to stop and report instead of guessing.
- Open decision for the user: whether "Storage usage" should also open from the database row menu (the plan says yes), or only from the connection menu.
