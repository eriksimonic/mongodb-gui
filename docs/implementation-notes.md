# Implementation notes

Notes from finished and planned work that the code does not show. The original plans and status
logs are in git history before commit `e85767f`.

## Machine encryption (2026-10-27)

- Both modes wrap the same random data key (DEK) and keep the same store format, so switching
  modes rewrites only `keyring.json`. Nothing is re-encrypted.
- Password keyrings keep the version 1 shape byte for byte, so older app versions still open
  password-mode data. A device-mode vault opened by an older version shows the reset prompt, so
  users switch back to password mode before they downgrade.
- `packages/storage` does not import `electron`. The app passes in a `DeviceKeyProvider`, which
  keeps the vault testable without Electron.
- `setPassword` must not zero the live DEK. `changePassword` does zero its copy, and copying that
  code into `setPassword` would lock the vault mid-session.
- A malformed keyring counts as password mode in `status()`. That keeps the unlock screen and its
  "Reset store" button reachable.
- The device-key blob is bounded at 4096 bytes, because the `safeStorage` output length varies by
  platform.
- The DEK passes through a base64 string on its way to and from `safeStorage`. JavaScript cannot
  zero that string. This is accepted because the threat model excludes malware running as the
  same user.
- On Linux, Electron fixes the secret store backend at startup, so "Check again" usually needs a
  restart to change the result.
- If device decryption fails (moved profile, copied data folder, changed backend), the app shows a
  recovery screen. It offers "Try again" and "Reset store" only, because no other key exists.
- Not built: manual lock in device mode. The app would unlock again at once, so the idle timer
  never arms and "Lock now", the shell Lock button and the lock hotkey are hidden. `lock()` still
  runs on quit, so the key is zeroed on exit.
- Verified by unit tests for the keyring and the vault, UI tests for the choice, unlock and
  settings flows, and an e2e first-run spec.

## Storage usage dashboard (2026-10-19)

- Read-only. The panel calls `listDatabases` once, then `dbStats` on `admin` for disk totals (a
  failure there is ignored). Collections load only when a database is opened.
- Per collection: one `$collStats` and one `$indexStats` aggregate, each with `maxTimeMS: 5000`.
  At most two collections run at a time, and databases run one after another.
- A failing collection becomes an entry with `error` set. It never fails the whole database.
- Insight cards are computed in the UI from the loaded data. They make no extra server calls.
- The unused-index card counts operations since the server started. It says "counted since <date>"
  and shows "could not check" when `$indexStats` is denied.
- Reclaimable space appears only when the server reports `freeStorageSize`. Old servers omit it.
- The treemap is hand-rolled (squarified, plain divs) to avoid a new dependency. The table beside
  it is AG Grid, which the UI already uses.
- Sharded clusters: `mongos` returns per-shard figures, and the panel shows what the call returns.
  Cluster-wide totals are out of scope.
- Verified by the adapter integration test, a component test and a browser walk in the mock UI.
  The integration test has not run on a machine with Docker (see Open work).

## Platform test tier (2026-10-15)

- Layers: unit tests run on all three OSes. Integration, wiring and coverage run on Linux only.
  The platform tier adds a small set of tests on Windows and macOS for code that touches the OS.
- Windows and macOS runners use a native `mongod` from the package manager, not a container. If
  that install proves unreliable, run only `persistence.spec.ts` there with `E2E_NO_MONGO=1`.
- `e2e/global-setup.ts` has two switches for this tier: `E2E_NO_MONGO=1` skips Mongo, and
  `E2E_MONGO_URI` uses an existing server.
- The packaged-app smoke reuses `persistence.spec.ts` through `E2E_PACKAGED_EXECUTABLE`. Its check
  is that the app reaches the master password prompt. The first run now shows a choice screen, so
  check that the smoke still matches the first-run flow before you change either one.
- Covered: CRLF and lone CR handling in transfers, Windows-style paths in picked paths and export
  files, and the absolute-path form.
- Not covered and still manual before a release: native dialogs, `shell.openExternal`, code
  signing and the installer itself.
- Verified by the CI platform job passing on Windows and macOS on `main`.

## E2E journey batch 2 (2026-10-15)

- Adds standalone wiring journeys for about 35 RPC methods that the coverage map marked "no journey
  planned yet".
- Journeys write only to databases named `wiring_<spec>_<random>`. Other specs read the seeded
  `shop` database, so no journey writes to it.
- Left excluded on purpose: the 17 Electron-layer methods, and the sharding, security, GridFS,
  monitor and replica-member calls. Some would break the shared replica set or the app's own
  sessions. Others need a stack that the standalone suite does not start.
- Transfer and file-dialog journeys need `wiring.setDialogPicks` and the bundled MongoDB tools
  (`fetch:mongo-tools`), which must be fetched before the run.
- The batch changes specs and coverage map entries only. A journey that hit a missing label
  stopped and reported it, so no component changed to make a journey pass.
- New specs ran three times in a row during validation, because CI blocks on a flaky wiring spec.

## Green CI and 0.4.0 release (2026-10-17)

- The failures were formatting in three UI files, an unhandled Mantine transition timer that fired
  after jsdom teardown in the unlock screen test, and a backup integration test that pulled
  `mongo:4.4` from Docker Hub while rate limited. Its `afterAll` threw and hid the real error.
  Coverage failed only because the wiring jobs had been skipped.
- The release tag must equal `v` plus the version in `packages/app/package.json`, and the
  CHANGELOG needs the matching entry.
- The Windows and macOS packaged-app smoke looked for the wrong executable names. The release
  check now looks for `mongo-gui.exe` and `mongo-gui.app`.
- Vitest sometimes crashes with a native SIGSEGV that is not app code. Rerun once before treating
  it as a failure.
- Three green runs came from one push and two reruns of the same commit. That catches flakes but
  is not three separate pushes.
- The first v0.4.0 release failed the Windows and macOS packaged-app smoke. The cause and fix are above.

## Copy collections and databases (2026-11-06)

- Drop and replace restores into `__copy_<jobId>_<target>` in the target database, then renames it
  over the target with `dropTarget`. A cancel or a failure drops the temporary collection, so the
  old data stays. The target part of the name is cut to keep `database.name` within 255 bytes
  (`packages/core/src/copy/temp-name.ts`).
- The pipe waits for both tool runs to settle before the caller drops the temporary collection.
  Otherwise the drop races the restore.
- Each tool run gets its own config FIFO pair, because a FIFO serves one reader.
- A filter needs its own dump per collection, because `mongodump --query` takes one collection.
  The service runs one pipe per item.
- The tools check has a 4.2 server minimum (`MIN_SERVER` in `compat.ts`). `assessCopy` blocks with
  `tools-too-old-for-server` when no installed or downloadable tools version fits both servers.
- Time series cannot be renamed. renameCollection fails on MongoDB 8.0.17
  (CommandNotSupportedOnView). A time series source or target is written in place with `--drop`.
  The source also gets a second `--nsFrom`/`--nsTo` pair for `system.buckets.<name>`. That bucket
  rename needs tools 100.16.0 or newer (`TIMESERIES_TOOLS` in
  `packages/core/src/copy/assess.ts`). Older tools get the `copy-timeseries-rename` warning.
- Time series counts are buckets. A time series source adds a note to the progress log.
- Merge does not use mongorestore, because mongorestore cannot upsert. The driver writer in
  `packages/mongo-adapter/src/copy/upsert-writer.ts` runs unordered batched `replaceOne` upserts by
  `_id`. Failed documents come from `MongoBulkWriteError.writeErrors`. The abort signal is checked
  between batches.
- Insert only passes `--noIndexRestore`. mongorestore exits 0 when it skips documents, so the
  skipped count comes from the "failed to restore" line. Duplicates print `continuing through error`
  and exit 0, with no `Failed:` line (confirmed on a real server).
- The same-server overlap block (`copy-overlap`) refuses a copy that writes to a collection it reads.
  A drop would delete data that the dump is still reading. "Same server" means the same hosts and
  replica set name, not the same profile.
- The production gate is enforced in the main process. `prepare` in
  `packages/app/src/main/copy/copy-service.ts` throws unless `confirmation` equals the target
  database name exactly, before any job, tool or temporary collection starts. The dialog checks it
  again. Restore checks the flag in `RestoreDialog` only. The backup service does not check it.
- A direct connection copies the `production` flag from its parent
  (`packages/app/src/main/rpc/connections.ts`).
- `serverIdentity` reads `hosts` from `hello`, which a replica set returns. A standalone server or
  `mongos` returns no hosts, so its identity is `serverStatus.host` (the hostname, no port) plus the
  port the client connected to. Two `mongod` processes on one machine differ by port. The limit: one
  server reached through two ports (for example a proxy) counts as two servers. If `serverStatus` is
  denied too, it falls back to the connected host list. Two connection strings for one server then
  look like two servers.
- Renderer reset, vault lock and connection loss cancel copy jobs (`router.ts`). Job ids are UUIDs
  from `crypto.randomUUID`.
- Blocking rules live in core: `assessCopy` in `assess.ts`, and `unresolvedCopyFindings` and
  `newestFittingTools` in `start-checks.ts`. The dialog and the service call the same functions, so
  their findings agree.
- The dialog hides views and `system.*` (`isCopyable`). It does not list the target connections
  that are not connected. The "Copy to…" menu entries are disabled while the connection is not
  connected.
- Progress events go out every 250 ms (`COPY_PROGRESS_INTERVAL_MS`).
- Verified by the copy service unit tests and `packages/app/src/main/copy/copy.integration.test.ts`.
  The integration test runs each mode, cancel, the overlap refusal and the production gate against
  two real servers.

## Compare and sync (design, not built)

### Not built

- Compare merge-joins both sides sorted by the match key, with simple collation. Equality ignores
  field order and counts array order. Replica sets on MongoDB 5.0 or later use snapshot reads, and
  `SnapshotTooOld` offers a retry. The target is collections under about 1M documents.
- Sync is one way. Insert, replace and delete start unticked. It re-reads each source document at
  apply time and is not transactional, so a cancelled run leaves the target partly synced. Unique
  indexes are created before any data write, and a failure there stops the sync.
- Replace removes `_id` from the replacement when the match key is not `_id`, so MongoDB does not
  reject the change.
- Views are compare-only, and sync updates their definition. Time series are copy-only. Capped
  collections allow insert only. `system.*` is always skipped.
- Sync writes to a production connection need a typed target database name, as copy and restore do.
- Run log: each run writes a JSON log with the header, counts and failed keys, encrypted like the rest of the app data. Up to 100 per source-target pair, oldest deleted first.
- Retry failed: re-reads only the failed keys from the source at that moment.
- Per-failure resolutions: overwrite or skip for unique index conflicts, skip or edit and retry for validator rejections. They run as one more batched sync into the same log.
- Open question: a custom match key needs a unique index on both sides. `_id` always works.

## CPD duplication removal (not started)

### Not built

- Shared logic moves into `packages/core`. Each new helper goes into a module that `index.ts`
  already re-exports, so no change to `index.ts` is needed.
- `storage/src/store/migrations.ts` stays as it is. Applied migration SQL is history, and a shared
  builder would change fresh installs but not existing ones. Open decision: leave it, or wrap it in
  CPD-OFF and CPD-ON comments if PMD honours them for TypeScript.
- Repeated cases inside one test file stay. Extracting them hides each case's arrange step.
- Mocks import the real logic. Open decision: the management mock's collection options switch to
  the server's shape, which changes what Storybook shows.
- Compare CPD runs with one PMD version on both sides. The stored baseline file skipped one
  untracked file, so it is not a fair comparison.
- Left alone: the SQL scan-loop tails in `core/src/sql/tokens.ts` and `ui/src/editor/sql-format.ts`. Each loop pushes different token kinds, so sharing needs a callback per kind.
- Left alone: the `monitor` interfaces in `app/src/main/rpc/monitor.ts` and `ui/src/monitor/mock.ts`. A shared interface would tie the app type to the mock.
- Left alone: the 11 `storage/src/store` repo test clusters (import blocks and `afterEach`). A shared hook would hide the store lifecycle.
- Left alone: the "goto, right-click Local dev, Connect" steps in 17 wiring specs. Each batch needs a serial Docker and Playwright run.
- Left alone: vault creation in the `editor`, `smoke` and `persistence` e2e tests. Proving a change needs Electron runs with a Mongo container.
- Open decision: batch the 17 wiring specs onto a shared `connectLocalDev` step later. Default is no.
- Risk: helpers in `src/test/` need `src/test/**` in the package `tsconfig.json` exclude. Without it, typed ESLint rules fail on the new files.
- Risk: the `isPlainObject` to `isPlainRecord` rename touches callers across core. A caller in `canonical.ts` that uses the old name breaks at typecheck, not at runtime.

## Gap "yes" items: fluent queries, syntax check, binary viewer (not started)

### Not built

- Fluent queries: a mongosh prelude evaluated in `open()` after `use()` adds
  `coll.where(field)`, with `equals`, `gt`, `gte`, `lt`, `lte`, `in`, `nin`, `regex` and `exists`.
  `and` and `or` build the filter. Two operators on one field become `$and`, and `equals` with
  another operator on the same field uses `$eq`. Open question: the prelude may be unable to add
  `where()` to collections, which the first spike decides.
- Syntax check: acorn parses the editor text with top-level `await` allowed. Lines starting with
  `use`, `show`, `it`, `exit`, `quit` or `help` are blanked first, keeping offsets. Checks run 400 ms
  after a change. Only syntax is checked, not collection or field names. SQL tabs are untouched.
- Binary viewer: read-only. Images are shown as `data:` URLs, which the renderer CSP already allows.
  Hex and text views stop at 1 MB. Entry points are the cell menu and a tree row action.
- The browser mock shell does not run `where()`, so the mock shows its unsupported message.
