> This is the original build plan, kept for history. The guides in this folder and CONTRIBUTING.md at the root describe the shipped app.

# Mongo GUI implementation plan

A desktop MongoDB client in the spirit of NoSQLBooster: mongosh-compatible editor with
autocomplete, result grid, visual explain, collection and index management, live
monitoring, and a profiler. Cross-platform (Linux, Windows, macOS), MIT licensed.

## 1. Decisions

| Topic | Decision |
|---|---|
| Language | TypeScript everywhere |
| Shell | Electron 44 (bundles Node 24 and Chromium 152) |
| UI | React 19, Mantine 8 for components, dockview for panels and tabs, Monaco for the editor |
| Query language | mongosh JavaScript, evaluated by the official mongosh runtime packages (Apache-2.0) |
| Driver | official `mongodb` Node driver 7.x |
| Result grid | AG Grid Community for table view, custom tree view, Monaco read-only for JSON |
| Persistence | SQLite through the built-in `node:sqlite`, every content column encrypted |
| Encryption root | A master password the user types every time the app starts |
| Tests | Vitest, Testcontainers (MongoDB 4.4, 6.0, 8.0), Playwright for Electron, Storybook |
| Build | electron-vite for dev and bundling, electron-builder for installers, GitHub Releases for updates |
| MongoDB support | 4.4 and newer; standalone, replica set, sharded, Atlas SRV; user/password and TLS in v1, X.509 next |
| License | MIT |
| Package manager | pnpm 12 workspace, Node 24 for development (same major as Electron's bundled Node) |

Native Node modules are banned. Everything the main process needs (SQLite, AES, scrypt)
ships inside Node 24, so there is no `electron-rebuild` step and no per-platform binary pain.

## 2. Architecture

### 2.1 Processes

```
+--------------------+   typed RPC over IPC    +------------------------+
| renderer (React)   | <---------------------> | main (Electron)        |
| packages/ui        |                         | packages/app           |
+--------------------+                         |  - RPC router          |
                                               |  - storage (encrypted) |
                                               |  - connection registry |
                                               +-----------+------------+
                                                           | MessagePort per connection
                                               +-----------v------------+
                                               | utility process        |
                                               | packages/shell-runtime |
                                               |  - mongosh runtime     |
                                               |  - mongodb driver      |
                                               |  - autocomplete        |
                                               +------------------------+
```

One utility process per open connection. A runaway user script or a driver crash kills
only that process, and the UI reports it and offers reconnect. The main process never
imports the driver directly; it talks to the utility process over a MessagePort.

### 2.2 Packages (pnpm workspace)

| Package | Depends on | May import | Purpose |
|---|---|---|---|
| `packages/core` | nothing | `zod` only | Domain types, RPC contract, explain plan normaliser, pure helpers. No Node or Electron APIs. |
| `packages/mongo-adapter` | core | `mongodb`, `bson` | Everything that touches the driver: connect, list, stats, indexes, explain, serverStatus, profiler reads. |
| `packages/shell-runtime` | core, mongo-adapter | `@mongosh/*` | Hosts the mongosh evaluator. Runs as an Electron utility process. Also runnable as a plain child process for tests. |
| `packages/storage` | core | `node:sqlite`, `node:crypto` | Encrypted store for connections, history, favourites, settings, layout. Key management. |
| `packages/docker` | core | Node built-ins (`http` over the Docker socket) | Discovers MongoDB containers and manages the throwaway socat forwarders. No dockerode, no native code. |
| `packages/ui` | core | React, Mantine, dockview, Monaco, AG Grid | All screens. Talks to an `RpcClient` interface from core. Ships a `MockRpcClient` so it runs in a browser with no Electron. |
| `packages/app` | all | Electron | Main process, preload, window, RPC router, utility process supervisor, auto-update. |

Dependency direction is enforced by eslint `no-restricted-imports` rules and a `pnpm
depcheck`-style test that fails if `core` or `ui` import Electron, `mongodb`, or Node
built-ins.

### 2.3 RPC contract

`packages/core/src/rpc/contract.ts` declares every call as `{ input: zod schema, output:
zod schema }` grouped by namespace: `connections`, `databases`, `collections`, `shell`,
`explain`, `indexes`, `documents`, `monitor`, `profiler`, `history`, `settings`, `updates`, `app`.
Streaming calls (query results, monitor samples, profiler tail) are modelled as
subscriptions with `subscribe(input) -> AsyncIterable<event>` and an explicit `cancel`.

Three implementations of the same `RpcClient` type:

1. `ElectronRpcClient` in the preload, over `ipcRenderer.invoke` and `MessagePort`.
2. `MockRpcClient` in `ui`, with fixtures, for Storybook, browser dev, and UI tests.
3. `DirectRpcClient` in tests, which calls the router in-process with a real adapter.

BSON crosses the IPC boundary as canonical EJSON (`bson.EJSON.stringify(x, { relaxed: false })`)
so ObjectId, Decimal128, Long, dates and binary survive intact. The UI renders typed
values with their BSON type badge.

### 2.4 Query lifecycle

1. User presses Ctrl+Enter in the editor on `db.orders.find({status: "paid"}).limit(50)`.
2. UI calls `shell.evaluate({ connectionId, db, code, batchSize: 50 })`.
3. Main forwards to the connection's utility process.
4. `shell-runtime` evaluates with the mongosh `ElectronRuntime`. Cursor results are not
   drained; the runtime holds the cursor and emits batches of EJSON documents.
5. UI shows the first batch in the selected view, with "next page" pulling the next batch.
6. Cancel closes the cursor and, if needed, runs `killOp` on the server operation id.

Explain reuses the same path with `mode: "explain"`: the runtime rewrites the final
cursor call into `.explain(verbosity)` and returns the raw plan, which `core` normalises.

## 3. Security and data at rest

### 3.1 Threat model

Protect saved connection strings, credentials, query history (which can contain
customer data) and favourites from anyone who copies the user's profile directory or
reads a backup. Not in scope: an attacker with code running as the logged-in user while
the app is unlocked.

User code in the runtime process shares that process with the runtime's own state, so a
script can change what later results show until the process restarts. That is the same
trust as the user's own script, and the runtime process holds no secrets beyond the URI
it was given.

### 3.2 Key hierarchy

```
master password  --scrypt(N=2^17, r=8, p=1, salt 32B)-->  KEK (32B)
KEK  --AES-256-GCM unwrap-->  DEK (32B, random, generated once)
DEK  --AES-256-GCM-->  every content column in the SQLite store
```

- First launch: user sets a master password (minimum 10 characters, strength meter,
  confirmation). The app generates a random DEK, wraps it under the KEK, and writes
  `keyring.json` containing `{ version, kdf: {salt, N, r, p}, wrappedDek }`. The AES-GCM
  tag on the wrapped DEK is the password verifier; there is no separate verifier field.
- Every launch: the app shows the unlock screen before any window content. Wrong
  password yields a generic error with a 500 ms delay per attempt.
- Password change: re-derive KEK, re-wrap the DEK. No data rewrite.
- Lost password: no recovery. The UI offers "reset store", which deletes the store after
  a typed confirmation.
- The DEK lives only in main process memory, in a `Buffer` zeroed on lock, on quit, and
  after a configurable idle timeout (default 30 minutes, which locks the UI).
- The DEK never reaches the renderer or utility processes. They receive decrypted
  connection details per connection on demand.

### 3.3 Store layout

`node:sqlite` database at `<userData>/store.sqlite`. Each table has clear-text
structural columns (`id`, `created_at`, `updated_at`, `kind`, foreign keys) and a single
`payload BLOB` column holding `nonce(12) || ciphertext || tag(16)` under AES-256-GCM, with
AAD set to `table:id` so a row cannot be moved to another table or id. Query history
search happens in memory after decrypt, capped at 20,000 entries with oldest-first
eviction. History rows reference their connection with `ON DELETE CASCADE`, so removing a
connection removes its history. Timestamps and connection ids stay in clear text, which
reveals when queries ran per connection but not what they were.

### 3.4 Why not the OS keychain or TPM as the root

Electron's `safeStorage` reaches Keychain, DPAPI, libsecret or KWallet, but any process
running as the user can decrypt with it, and on Linux it silently falls back to a plain
text backend when no secret service is running. A TPM is not reachable from Electron
without a per-platform native addon (tpm2-tss on Linux, NCrypt Platform Crypto Provider on
Windows, Secure Enclave on macOS), and a TPM-sealed key is still released to any process
as the user. The master password is the only root that works identically on all three
platforms and survives a copied profile directory. An optional "unlock with OS keychain
on this device" setting can be added later; it stays off by default.

### 3.5 Other rules

- Connection export writes a file encrypted with AES-256-GCM under a scrypt-derived key
  from a passphrase the user types for that export. Import reverses it.
- Logs never contain URIs, passwords or document contents. A redaction helper in core
  masks `mongodb://user:***@host`.
- The renderer runs with `contextIsolation: true`, `nodeIntegration: false`, `sandbox:
  true`, and a strict CSP. The preload exposes only the RPC client.
- User scripts run only inside the utility process. The renderer never evaluates them.

## 4. Phases and tasks

Each task has an id used in commit messages and agent briefs. "Done" means: code, tests,
lint and typecheck pass with `pnpm check`, and a validator review found no blocking
issues.

### Phase 0: bootstrap

- **P0-1 workspace.** pnpm workspace, root `tsconfig.base.json` (strict, ES2023,
  `moduleResolution: bundler`), eslint 9 flat config with typescript-eslint and
  import boundary rules, prettier, vitest workspace, `pnpm check` script
  (lint + typecheck + test), `.editorconfig`, `.gitignore`, MIT `LICENSE`, README.
  Six empty packages with `package.json`, `tsconfig.json`, one passing test each.
- **P0-2 app skeleton.** electron-vite config in `packages/app`, a window that loads
  `ui`, preload with contextIsolation, dev script `pnpm dev`. GitHub Actions workflow
  running `pnpm check` on ubuntu, windows and macos.

### Phase 1: connections and tree

- **P1-1 core types and contract.** Domain types (`ConnectionProfile`,
  `ConnectionStatus`, `DatabaseInfo`, `CollectionInfo`, `CollectionStats`, `IndexInfo`),
  zod schemas, RPC contract for `connections`, `databases`, `collections`, `settings`,
  `vault` (unlock, lock, set password, change password). URI redaction helper with tests.
- **P1-2 adapter connections.** `ConnectionManager`: connect with timeout, disconnect,
  ping, list databases with sizes, list collections with type (collection, view,
  timeseries), `collStats` and `dbStats`. Testcontainers integration tests against
  4.4, 6.0 and 8.0 (tagged `integration`, run with `pnpm test:integration`).
- **P1-3 storage.** `Vault` (scrypt, wrap/unwrap, verifier, lock, idle timeout, zeroing),
  `EncryptedStore` over `node:sqlite` with migrations, repositories for connections,
  history, favourites, settings, layout. Unit tests use a temp directory; a test proves a
  copied store is unreadable without the password and that AAD binding rejects a moved row.
- **P1-4 app wiring.** RPC router mapping the contract to adapter and storage, unlock
  flow, connection registry, IPC channel validation with zod on both sides.
- **P1-5 ui shell.** Mantine theme (dark first), dockview layout with sidebar, main
  tabs and bottom panel, unlock and first-run screens, connection manager (list, add,
  edit, delete, test, URI and form modes, TLS options, SRV), connection tree with lazy
  loading of databases and collections, document counts, context menus. Storybook stories
  for every screen using `MockRpcClient`.
- **P1-6 e2e smoke.** Playwright launches the built app, sets a master password, adds a
  Testcontainers connection, expands the tree and sees a collection.
- **P1-7 Docker discovery.** Talk to the Docker Engine API over its socket (Unix socket
  on Linux and macOS, named pipe on Windows; plain Node `http`, no native code). List
  running containers whose image is `mongo`, `mongodb/*`, `bitnami/mongodb` or
  `percona/percona-server-mongodb`, or that listen on 27017. Show them under a "Docker"
  node in the connection tree with container name, image tag and state, refreshed every
  10 seconds while the panel is visible. One click connects. Credentials are prefilled
  from `MONGO_INITDB_ROOT_USERNAME` and `MONGO_INITDB_ROOT_PASSWORD` when the container
  has them. A container with a published 27017 port connects through the host port.
  A container without a published port connects through a throwaway forwarder: the app
  starts an `alpine/socat` container on the same Docker network that publishes a random
  loopback port and forwards to the Mongo container, labels it `mongo-gui.forwarder`,
  reuses it while the connection is open, and removes it on disconnect and on quit (and
  removes stale labelled forwarders on start). Connecting through the container IP is
  not used because it fails on Docker Desktop. A setting "connect to Docker instances
  automatically" (off by default) connects every discovered container on startup.

### Phase 2: editor and results

- **P2-1 shell runtime process.** Utility process hosting `ElectronRuntime` from
  `@mongosh/browser-runtime-electron` over `NodeDriverServiceProvider`. Protocol:
  `evaluate`, `nextBatch`, `cancel`, `complete`, `getSchemaSample`. Results are EJSON
  batches. Supports multi-statement scripts and `print`. Timeouts and memory cap per
  evaluation. Verify every mongosh API against the installed `.d.ts` files before use.
- **P2-2 app runtime supervisor.** Spawn, restart and route per connection, forward
  streams to the renderer through a MessagePort, kill on disconnect.
- **P2-3 editor.** Monaco with a mongosh language registration, completion provider
  backed by `@mongosh/autocomplete` plus sampled field names per collection (sample 100
  docs, cached per collection, refresh on demand), signature help for operators from a
  bundled operator table, Ctrl+Enter runs selection or statement under cursor, one editor
  tab per connection and database, unsaved indicator, format document.
- **P2-4 results.** Table view (AG Grid, nested objects flattened with dot paths, column
  chooser), tree view (expand/collapse, type badges, copy path and value), JSON view
  (Monaco read-only), paging, row count, elapsed time, export selected to JSON or CSV
  file.
- **P2-5 history and favourites.** Every executed statement saved with connection,
  database, duration and result count. Search panel, re-run, save as favourite with a
  name and folder.

### Phase 3: explain

- **P3-1 adapter explain.** Run explain for find, aggregate, count, distinct, update and
  delete at the three verbosities. Handle sharded output and 4.4 through 8.0 formats
  including the slot-based engine plan shape.
- **P3-2 plan normaliser.** In core: raw explain to a `PlanTree` of stages with name,
  index, keys examined, docs examined, returned, time, children, and `warnings`
  (`COLLSCAN`, in-memory `SORT`, examined to returned ratio over 10, `FETCH` after
  `IXSCAN` on a covered-able query, rejected plans count). Fixture tests from every
  supported server version.
- **P3-3 explain ui.** Explain button next to run. Plan tree with per-stage metrics,
  hot stage highlighting, a summary bar (index used, examined, returned, time), a plain
  language explanation generated from the normalised tree, and a raw JSON tab.

- **P3-4 stage coverage.** Added on 2026-10-09 at Erik's request. A stage catalogue in
  core describes every stage the planner can emit, with a plain-language description, its
  category (scan, fetch, filter, sort, projection, limit, lookup, group, merge, sharding,
  text, geo, write, cache, express), which metrics are meaningful for it, and specific
  advice. Covered at least: COLLSCAN, IXSCAN, FETCH, SORT (in memory and spilling),
  SORT_MERGE, SORT_KEY_GENERATOR, PROJECTION_SIMPLE/COVERED/DEFAULT, LIMIT, SKIP, OR,
  AND_SORTED, AND_HASH, SUBPLAN, CACHED_PLAN, IDHACK and the 8.0 EXPRESS stages,
  COUNT, COUNT_SCAN, DISTINCT_SCAN, TEXT_MATCH, TEXT_OR, GEO_NEAR_2D, GEO_NEAR_2DSPHERE,
  SHARDING_FILTER, SHARD_MERGE, SHARD_MERGE_SORT, EQ_LOOKUP and `$lookup` with an inner
  pipeline shown as a sub-tree, `$unionWith`, `$facet`, `$graphLookup`, `$group`
  (with spill to disk), `$unwind`, `$match`, `$project`, `$addFields`, `$sort`,
  `$limit`, `$skip`, `$count`, `$out`/`$merge` (explain only), UPDATE, DELETE,
  BATCHED_DELETE, and the timeseries unpack stage. Fixtures captured from real servers
  for each case on 4.4, 6.0 and 8.0 where the stage exists, plus hand-written sharded
  ones. The panel shows an icon and category per stage, hover descriptions, the
  metrics that apply, lookup and union sub-trees, and the advice. The raw tab is always
  present: it shows the exact explain document the server returned, as canonical EJSON
  with search, folding and copy, and it works even when the normaliser produces an
  `UNKNOWN` tree, so an unexpected plan shape is still inspectable.

### Phase 4: collection management

- **P4-1 collections and databases.** Create database, create collection (capped,
  timeseries, clustered options), rename, drop with typed confirmation, clear.
- **P4-2 indexes.** Index panel per collection: list with size and usage (`$indexStats`),
  create via builder (fields, order, unique, sparse, partial filter, TTL, collation,
  wildcard, text), drop, hide and unhide, build progress from `currentOp`.
- **P4-3 validation.** JSON schema editor with Monaco, validation level and action,
  test against sample documents.
- **P4-4 documents.** Inline edit in the tree view with BSON type picker, insert
  document dialog, delete, duplicate, bulk delete of the current result set with
  confirmation showing the filter.

### Phase 5: monitoring

- **P5-1 adapter sampling.** Sampler per connection polling `serverStatus`,
  `replSetGetStatus`, `currentOp`, `dbStats` at a configurable interval (1 to 10 s),
  computing deltas for counters and keeping a ring buffer of 1 hour.
- **P5-2 dashboard ui.** Charts with uPlot: operations per second by type, connections,
  network in and out, memory (resident, virtual, WiredTiger cache), queued readers and
  writers, replication lag per member, oplog window. Operations tab with running
  operations, filters, and kill with confirmation.

- **P5-3 configurable dashboard.** Added on 2026-10-09 at Erik's request. A panel
  catalogue in core drives both the sampler and the UI: each panel declares the series it
  needs (serverStatus paths, counter or gauge, unit), the chart type and a title. The
  sampler collects the sections the catalogue references (`wiredTiger` cache, checkpoint,
  eviction, tickets and transactions, block-manager bytes read and written for IO,
  `network`, `metrics.document`, `metrics.cursor`, `metrics.operation`, `metrics.ttl`,
  `metrics.repl`, `transactions`, `locks`, `asserts`, `extra_info` page faults,
  `logicalSessionRecordCache`, replica set lag and oplog) and emits a flat
  `series: Record<string, number>` per sample next to the existing headline fields. The
  dashboard gets an "Add panel" picker grouped by category (operations, documents, memory
  and cache, WiredTiger, IO and network, locks and tickets, transactions, sessions and
  cursors, replication, errors), every panel can be closed, resized and reordered, and the
  layout is saved per connection through the `layout` namespace, with a "Reset to
  default" action and a default set that matches today's dashboard.

### Phase 6: profiler

- **P6-1 adapter profiler.** Get and set profiling level and `slowms` per database,
  read `system.profile` with filters (namespace, op, min duration, time range), tail
  mode, group by `queryHash` for top shapes.
- **P6-2 profiler ui.** Slow query table, detail pane with the command, plan summary and
  lock stats, "explain this" which opens the explain view with the captured command,
  "open in editor", top shapes view.

### Phase 7: finishing

- **P7-1 import and export.** JSON (array and newline-delimited) and CSV import with
  field mapping and type inference, export of a collection or query result.
- **P7-2 schema analysis.** Sample N documents, report fields, types, presence
  percentage, example values, nested paths.
- **P7-3a packaging.** electron-builder targets (AppImage, deb, NSIS, dmg, zip),
  release workflow on tag `v*` building on Linux, Windows and macOS runners and
  attaching installers to a GitHub Release, unsigned until there are users.
- **P7-3b updater.** `electron-updater` against GitHub Releases. Checks 10 seconds
  after start and every 6 hours, never blocks startup. Where the platform supports
  unsigned updates (AppImage, NSIS) the app downloads in the background and offers
  "Restart to update". Where it does not (deb, unsigned macOS) it shows a notice with
  the version, release notes and a download link. A setting turns checks off.
- **P7-4 polish.** Light theme, settings screen, keyboard shortcut reference, idle
  lock, crash recovery of editor contents. Crash recovery of editor text is not built here.
  It lives in P2-3's tab persistence: tab text is saved through the layout namespace, so an
  unsaved editor survives a crash through that path.

### Phase 8: server administration

Added on 2026-10-09 at Erik's request: the administrative features MongoDB exposes that a
client is expected to cover. Each task has an adapter half (`core` types plus
`mongo-adapter` functions with Testcontainers tests) and a UI half (contract namespace,
router wiring, mock, panels, tests, screenshots). Adapter halves can run in parallel with
anything; UI halves follow their adapter merge.

- **P8-1 users and roles.** List users per database (`usersInfo` with roles and
  authentication restrictions), create user (name, password, roles picker from built-in
  and custom roles, mechanisms), change password, grant and revoke roles, drop user with
  typed confirmation; custom roles: list (`rolesInfo` with inherited roles and
  privileges), create and edit with a privilege editor (resource: cluster, database,
  collection, any; actions picker grouped by category), drop. Passwords never leave the
  main process in events or logs.
- **P8-2 replica set administration.** `replSetGetStatus` and `replSetGetConfig` views:
  members table (name, state, health, lag, priority, votes, hidden, delay, tags, arbiter),
  oplog window, election history; actions with typed confirmation and a dry-run summary:
  step down primary (with seconds), freeze member, add member, remove member, edit member
  (priority, votes, hidden, slave delay, tags) via `replSetReconfig` with the version
  bump, initiate a replica set on a standalone started with `--replSet`. Refuse
  reconfigurations that would lose quorum and say why.
- **P8-3 sharding overview.** `config` database readers: shards, databases with primary
  shard and sharding state, sharded collections with shard key and chunk counts per
  shard, balancer state and window, start and stop the balancer, enable sharding on a
  database, shard a collection (key, unique, presplit option) with a summary, zones and
  tags listing.
- **P8-4 server logs and diagnostics.** `getLog` viewer (global, startupWarnings) with
  filter and level, `getCmdLineOpts`, `getParameter: '*'` searchable table,
  `hostInfo`, `buildInfo`, `serverStatus` as an explorable tree, `top` per collection,
  `dbStats` and `collStats` panels, `connPoolStats`.
- **P8-5 sessions.** List sessions (`$listLocalSessions`, `$listSessions`), kill a
  session or all sessions of a user, with confirmation.
- **P8-6 GridFS browser.** List buckets per database, list files with metadata, upload
  (streaming from a chosen file), download to a chosen path, delete, rename.
  Delivered in P8-6a (adapter) and P8-6b (contract, transfers, dev mock, tree and panel).
  Filename search matches a substring, not a prefix. A metadata edit replaces the whole object.
- **P8-7 change streams watcher.** Watch a collection, database or deployment with an
  optional pipeline and full-document option; live event list with pause, filter and a
  detail pane; resume token shown; stops on panel close and renderer reset.
  Delivered in P8-7a (adapter) and P8-7b (contract, router, dev mock, panel).

### Phase 9: containers on Docker and Podman, with WSL

Added on 2026-10-10 at Erik's request, widened the same day from a MongoDB-only Docker node
to a container management section for every container, with the aim of replacing Docker
Desktop on Windows with this app plus a WSL distro that runs Podman. Linux Podman and Docker
are covered by the same code. macOS is out of scope for this release, and the design keeps
the engine behind one interface so a Podman machine socket can follow later.

The engine client in `packages/docker` already speaks the Engine HTTP API, which Podman
serves too. MongoDB-specific behaviour (the image filter, the connect action, the database
badge) becomes a layer on top of the general list instead of a filter in front of it. Each
task has a `packages/docker` half (engine calls or WSL commands, with tests) and a UI half
(contract namespace `docker`, router wiring, mock, panel, tests, screenshot). Actions that
lose data ask for a typed confirmation.

- **P9-0 WSL spike.** Prove the transport before anything else: spawn
  `wsl.exe -d <distro> socat STDIO UNIX-CONNECT:<socket>` and run the Engine ping, a
  container list and a hijacked exec over the process's stdin and stdout, through Node's
  HTTP client with a custom connection factory. Measure start latency and confirm that a
  live bridge process keeps the WSL VM up. The result decides whether the bridge or a
  loopback TCP socket on the distro is the default transport.
- **P9-1 engine providers.** One `EngineProvider` interface with three implementations:
  local Docker socket, local Podman socket (`/run/podman/podman.sock` and
  `$XDG_RUNTIME_DIR/podman/podman.sock`), and WSL (`wsl.exe -l -v` to list distros, a probe
  of each for a Docker or Podman socket, the bridge from P9-0). The status carries the
  engine kind, version, socket and distro. Settings choose the provider and distro, with
  auto-detection by default. The tree node reads "Containers" with the engine in its
  tooltip, for example "Podman 5.2 in WSL: Ubuntu".
- **P9-2 setup wizard for WSL.** Walks the user from nothing to a working engine: install
  the Ubuntu distro with `wsl --install`, enable systemd, install `podman`, the compose
  provider and `podman-docker`, enable `podman.socket` for the user, set the unprivileged
  port sysctl so ports under 1024 publish, and write a `docker.cmd` shim on the Windows
  PATH that forwards to `wsl podman`, so scripts and IDE plugins that call `docker` keep
  working. Each step shows the command it runs and its output, and the wizard resumes
  where it stopped. Built on the project's wizard skill.
- **P9-3 WSL configuration window.** A form for the two files people otherwise edit by
  hand, with the current values read from disk and unknown keys and comments kept on
  write. `%USERPROFILE%\.wslconfig` (global, section `[wsl2]`): memory, processors, swap
  and swap file, networking mode (NAT or mirrored, mirrored only offered on Windows 11
  22H2 and later), localhost forwarding, DNS tunnelling, firewall, auto proxy, nested
  virtualisation, VM idle timeout, and `[experimental]` auto memory reclaim and sparse
  VHD. `/etc/wsl.conf` per distro (read and written through `wsl.exe -u root`): systemd
  on boot, boot command, automount root and options, generate hosts and resolv.conf,
  hostname, interop and Windows PATH append, default user. The form validates sizes such
  as `4GB` and caps processors at the host count, shows the host's memory and CPU next to
  the fields, backs up the previous file beside it, and ends with "Apply and restart WSL",
  which runs `wsl --shutdown` or `wsl --terminate <distro>` after a warning that every
  running container stops. A read-only "Effective" column shows what WSL reports after the
  restart.
- **P9-4 container list and namespaces.** Every container, grouped by namespace: the
  Compose project (`com.docker.compose.project`, service from
  `com.docker.compose.service`), the Podman pod, and "Standalone". Each namespace shows
  the running count over the total, then its containers with image, state, published
  ports and the compact resource meta from P9-5. MongoDB containers keep the connect
  action and the database badge. "Group by" on the node menu switches to a flat list.
- **P9-5 resource usage.** One `GET /containers/{id}/stats?stream=false` sample per
  running container: CPU percent from the `cpu_stats` and `precpu_stats` delta, memory
  against the limit, network and block I/O. The row shows CPU and memory; the details
  panel shows sparklines fed by a poll while open (monitor interval, default 2 s, stopped
  on close and renderer reset). Memory at or above 85 percent of the limit shows an orange
  badge. A WSL provider also shows the VM's memory and CPU from inside the distro, so the
  user sees the `.wslconfig` limits at work.
- **P9-6 lifecycle actions.** Per container and per namespace: Start, Stop with grace
  seconds, Restart, Pause and Unpause, Kill with a signal picker, Remove with typed
  confirmation and an opt-in, red "also remove volumes". Remove is refused while the app
  holds a connection to the container unless "Disconnect first" is ticked, and a container
  reached through a forwarder releases it before Stop or Remove.
- **P9-7 inspect and logs.** Details panel tabs: Overview, Inspect (raw JSON in the
  read-only editor with search, environment values redacted), Mounts (with a warning on a
  Windows path mounted through `/mnt`, because named volumes are fast and those are not),
  Ports, and Logs (stdout and stderr demultiplexed from the 8-byte frames, tail 500,
  Follow, a level filter for JSON log lines reusing the diagnostics filter, copy and save).
- **P9-8 shells.** "Open shell" runs `sh`, or `bash` when present, and MongoDB containers
  also get "Open mongosh" with the container's credentials. Both open an xterm.js dock
  panel fed by an exec with TTY over the hijacked stream, piped through `docker:terminal`
  events keyed by session id with backpressure, resize through `POST /exec/{id}/resize`,
  and teardown on panel close and renderer reset. Keystrokes never reach the log.
- **P9-9 compose projects.** Compose has no API, so the app runs the compose CLI inside the
  engine's host (`podman compose` or `docker compose`) with streamed output in a panel:
  up, down, restart, pull, and per-service logs, plus `ps` parsed into the service table.
  Projects are found from the labels and, for the file path, from
  `com.docker.compose.project.config_files`. "Open compose file" opens the file in a
  read-only editor; the app does not edit compose files in this release. Tests pin one
  provider and record the differences of the other.
- **P9-10 images and volumes.** Images: list with size, tags and dangling state, pull with
  progress, remove, prune. Volumes: list with driver, mount point and the containers that
  use them, remove with typed confirmation, prune. Both as tabs of the Containers panel.
- **P9-11 create a container.** The MongoDB form from before (image tag, name, port with a
  free-port suggestion, root credentials, named data volume, memory and CPU limits,
  optional single-member replica set) plus a general form for any image: image, name,
  ports, environment, volumes, limits, restart policy. Creation reuses `createContainer`,
  `startContainer` and `pullImage`.

Out of scope for this release, stated in the UI where it matters: writing compose files,
registry logins other than `podman login` inside the distro, translation of Windows paths in
bind mounts, Windows containers, Kubernetes, and macOS.

Order: P9-0, then P9-1. P9-2 and P9-3 follow P9-1 and run in parallel with P9-4. P9-5,
P9-6 and P9-7 follow P9-4 and run in parallel. P9-8 follows P9-7. P9-9 and P9-10 follow
P9-4. P9-11 is last.

Order: P0 then P1 strictly sequential at the package level (P1-1 first, then P1-2,
P1-3 and P1-5 in parallel, then P1-4, then P1-6). P2 follows P1. After P2, phases 3 and 4
run in parallel with phases 5 and 6.

## 5. Testing

| Level | Tool | What |
|---|---|---|
| Unit | Vitest | core helpers, normaliser, vault, store, reducers, hooks |
| Component | Vitest + Testing Library + Storybook | each screen against `MockRpcClient` |
| Integration | Vitest + Testcontainers | adapter and shell-runtime against MongoDB 4.4, 6.0, 8.0 |
| End to end | Playwright (Electron) | unlock, connect, query, explain, index create |
| Boundaries | custom Vitest test | package import rules |

Integration tests are tagged and excluded from `pnpm test`; `pnpm test:integration`
starts the containers. CI runs unit tests on all three operating systems and integration
tests on Linux only.

## 6. Tooling

- `pnpm dev` runs electron-vite with hot reload.
- `pnpm dev:ui` runs `ui` in a browser against `MockRpcClient`.
- `pnpm storybook`.
- `pnpm check` is the gate: `lint`, `typecheck`, `test`.
- Conventional commits prefixed with the task id, for example `feat(P1-3): encrypted store`.

## 7. Agent workflow

The coordinator does not write product code. For each task:

1. A Haiku implementer gets a brief containing the task text above, the files it owns,
   the interfaces it must implement from `core`, the tests it must write, and the
   command that must pass (`pnpm check`). It commits on completion.
2. An Opus validator reviews the resulting diff against the brief with a fixed checklist:
   matches the plan, tests exercise real behaviour, boundary rules respected, security
   rules from section 3 respected, no native modules, no silent scope changes. It returns
   `blocking`, `minor` and `ok` findings.
3. Blocking findings go back to the implementer. The loop repeats until the validator
   returns no blocking findings.

## 8. Coding standards

- Strict TypeScript, no `any` outside test fixtures, `unknown` plus zod at every
  process boundary.
- Functions over classes except where state ownership is the point (ConnectionManager,
  Vault, Sampler).
- Every public function in `core` and `storage` has a unit test.
- No default exports. Named exports only.
- Errors are typed: `AppError` with a `code` from a union in core, surfaced to the UI
  with a user-facing message and an optional detail.
