# Changelog

All notable changes to Mongo GUI are listed here, newest first.

## 0.4.2 - 2026-10-19

### Added

- A read-only Storage panel per connection, opened from the connection menu or the context menu of a
  database. Tables list databases, collections and indexes with a size bar. A segmented bar splits
  one collection into data, free space and indexes. Insight cards list the biggest collections and
  indexes, unused indexes, indexes larger than their data and reclaimable space.
- The tree icons are colored by node type.
- The GridFS file table is styled like the profiler grid.

### Changed

- The GridFS upload chunk size defaults to 12 MiB.
- The editor refreshes its field and collection-name suggestions after each run and once a minute.
  The "Refresh databases" and "Refresh field names" toolbar buttons are gone.

## 0.4.1 - 2026-10-19

### Added

- The result table edits a scalar cell in place. Double-click it, or press F2 or Enter. Enter saves
  the value with its type, and Escape cancels. Double-clicking a cell that cannot be edited still
  opens the whole document.

### Fixed

- SQL completion offers columns after an INSERT creates the collection. An empty field sample was
  cached, so WHERE had nothing to offer until "Refresh field names".

## 0.4.0 - 2026-10-17

### Added

- Explain measures every top-level `$lookup` by itself when an aggregate finishes. The measured inner
  stages appear under the `$lookup` in the same plan, with the numbers of one document multiplied by
  the number of runs, labelled as an estimate. A `$lookup` that cannot be measured shows "Not
  measured" with the reason on hover and a Retry button. Measure no longer opens a second tab.
- The GridFS node of a database has a menu with "New GridFS bucket" and "Refresh".
- The mouse wheel zooms the explain plan graph around the pointer.
- The explain command box completes collection names, fields and operators like the query editor.
- The collection menu starts with "Open in editor", then "Query", then "Collection", which holds
  Indexes, Validation, Analyse schema, Collection stats, Watch changes and Shard collection.

### Changed

- Enter and double-click on a collection open the query editor again. The collection panel has no
  Documents tab. Insert, edit and delete documents with queries in the editor.
- The explain verbosity choices read "Plan only", "With stats" and "All plans", and a hover names the
  server setting. The verbosity control and Re-run share one height.
- The explain command box grows to 200 px and scrolls inside. Its collapse button sits beside the
  editor instead of over the scrollbar.
- The completion list sorts fields first, then operators, then functions, each group alphabetically.
- Menus and popups have a border and a deeper shadow, so they stand apart from the rows behind them.
- A plan narrower than the explain canvas is centred.

### Fixed

- Typing `{` or `,` in the editor opens completion for object keys, and Monaco's own word list no
  longer adds `db` and `find` to the suggestions.
- The completion list is no longer cut off at the edge of the editor.
- Replica set member rules and the shard drain dry run live in `core`, so the UI mocks and the
  adapter cannot drift apart.
- The connection search lists each collection once on a sharded cluster. `mongos` returned a
  collection once per shard, and the duplicates left search results in the tree after the search
  was cleared.
- Backup and restore no longer write the connection URI, password included, to a file. The tools
  read their config through a named pipe. A tool that prints nothing for 120 seconds is killed and
  the job fails with a message.

## 0.3.0 - 2026-10-12

### Added

- Settings has a Performance section with "Disable GPU acceleration". It saves about 90 MB of
  memory and moves drawing to the CPU. The option is stored in `startup.json` in the app data
  folder, outside the vault, because Electron reads it before the vault opens. A restart applies it,
  and the section offers a "Restart now" button. `--disable-gpu` on the command line does the same
  for one run.
- Typing in the connection tree filters the siblings of the focused row. Backspace shortens the
  filter and Escape clears it. Enter on a database or collection does what a double click does,
  and a tab opened from the tree puts the cursor in its editor.
- The connection manager shows connections in a sortable table with the time each was last used.
- Dock tabs have icons and tooltips, and shrink to fit. The operations toolbar is centered.
- The editor font size setting scales the whole UI, including Mantine components, the connection
  tree, dock tabs, the result tree and the output panel.
- Documents open for editing with plain numbers and dates, and the editor grows with its content.
- Scrolling to the end of a result loads the next page. The Load more button is gone.
- The diagnostics tabs have refresh buttons, and Top can change its view.

### Changed

- The license is now Apache 2.0 with the Commons Clause, which forbids selling the software. This
  includes charging for hosting it or for support and consulting where the value comes substantially
  from the app. Use, modification and sharing stay free. Versions up to 0.2.0 stay under the MIT
  license.
- The Docker forwarder requires a client certificate. It listens with mutual TLS, and each
  forwarder gets a new certificate pair that is valid for 7 days. Before, any local process could
  reach an unauthenticated MongoDB behind the forwarder.
- The backup, restore, import, export and generate dialogs and the explain, profiler, monitor and
  GridFS panels load when first opened. The main window script is 4% smaller.
- The menu bar is hidden. Alt shows it.

### Fixed

- A result of 50,000 documents took the window to about 620 MB. The JSON view no longer runs the
  JSON language service on text above 2,000,000 characters, and the read-only editor skips link
  detection and similar features. The same result now peaks at about 280 MB.
- The shell process takes 94 MB at first use instead of 138 MB, and its script is 9.8 MB instead of
  24 MB. The TypeScript compiler was bundled for a function the runtime never calls. Completion
  works as before.
- The read-only mongosh views use the mongosh colors, and the JSON view opens on Relaxed JSON.
- Backup writes the description file for connections without credentials.
- The Docker-linked connections share the connection menu of other connections.
- Profiler commands open in the editor, and the profiler layout is tidier.
- The spacing in the Settings dialog and the padding of the Output panel are even.

## 0.2.0 - 2026-10-12

### Added

- F5 runs the selection or the statement under the cursor in the mongosh and SQL editors, like
  Ctrl+Enter. Field names, quoted keys and columns, collections and tables, and method names have
  their own colors in both editors, in the dark and the light theme.
- `packages/core` translates a T-SQL subset to mongosh: SELECT with joins, grouping and paging,
  UPDATE, DELETE, INSERT and TRUNCATE. Each statement becomes one mongosh statement, and a
  construct outside the subset is refused with a message that points at it.
- Each editor tab has a query language, Mongo or SQL, set by a toggle after the database select. A
  tab keeps one text per language, so switching never translates and the SQL stays available. A SQL
  tab shows the mongosh of its text on the right, read only, and updates it as you type. "Open in
  Mongo", on the preview and in the tab menu, switches the tab to that mongosh. In SQL mode, Run
  and Run all translate the statements to mongosh, print the mongosh in the Output panel and run
  it. Errors underline the clause, UPDATE and DELETE without WHERE and TRUNCATE ask for
  confirmation, and Format formats SQL. SQL completes table names after FROM and JOIN, and fields
  after an alias and a dot. The history and favourites lists mark SQL entries.
- "Back up…" on a connection, "Back up database…" and "Back up collection…" run `mongodump` from
  MongoDB Database Tools. A backup is one archive file, optionally gzipped, or a folder of BSON
  files. The backup covers the whole server, one database, several databases or one collection,
  and shows progress, with cancel.
- "Restore…" on a connection and "Restore into database…" run `mongorestore` on an archive or a
  folder. A contents tree selects the collections to restore, and "Restore as" renames each
  database on the way in. A dry run shows the plan without writing.
- Each backup writes a JSON description file next to it. The file records the source server,
  the tools version, the options used, the collections with their document counts and a checksum
  of the output, but never a password. The restore dialog reads it and shows its contents.
- Restore and backup check the tools version against the server. Mismatches show a warning or a
  block, with a button to use an installed version or to download one from MongoDB's feed. The
  download is checked against MongoDB's sha256 before it is installed.
- The "MongoDB tools" section in Settings lists the installed tools versions, picks the default
  version, removes downloaded versions and shows the tools licence.
- Linux x64 and Windows x64 builds bundle `mongodump` and `mongorestore` at the pinned version,
  so backup and restore work without a download. Other platforms download a version first.
- "Generate data" on a collection inserts made-up documents from a seeded set of generators
  (identifiers, numbers, dates, names, emails, file paths and lorem text), with unique fields,
  a preview, progress and cancel. A unique field that its generator cannot fill is refused before
  the first write.
- Connecting to a password-protected MongoDB container without credentials in its environment
  opens a dialog for a user name, password and authentication database. The app tests the
  credentials and saves them with the container's connection.
- "Only problematic" in the profiler filter row hides slow query rows without a COLLSCAN, an
  in-memory sort or a high examined-to-returned ratio. It filters the loaded rows in the app.
- Right-click on a table cell offers "Copy value", "Copy key" and "Copy document".
- The Output panel folds down to its tab strip with the chevron at the right of its tabs or with
  Mod+J, and unfolds to its previous height.
- Field completion lists top-level fields before nested paths and returns up to 1,000 entries,
  so a collection with a large keyed map no longer hides its other fields.
- The Explain panel's Raw view fills the panel height.
- A connection with `directConnection=true` to a replica set member shows the set name and
  "direct" in the connection tree, in the status tooltip and in the monitor header.
- A replica set node under each replica set connection lists the members with their state.
  "Connect directly" on a member saves and opens a direct connection to that host.
- Right-click a user in the Users and roles panel for "Copy as connection string".
- Double-clicking a collection whose query tab is already open brings that tab to the front.
- Exports selected connections to a file encrypted with AES-256-GCM under a scrypt key from a
  passphrase of at least 10 characters. Each export uses a new salt and IV.
- Imports a connections file after its passphrase is typed. Name collisions can skip, rename or
  replace the existing connection, and the connection tree reloads.
- Edits an index from the Indexes panel. The index builder opens with the current definition, and
  "Replace index" drops the index and creates the new one. MongoDB cannot change an index in place,
  so a failed create after the drop leaves the index missing until a valid definition is saved.
- Opens a whole document on double-click in the Documents panel and in the table and tree views of
  results. A result that cannot be edited opens the document read-only.
- "Open documents" on a collection, and a double-click on a collection in the tree, open an editor
  tab that runs `find({})` on the collection. The Documents panel stays available as "Manage
  documents".
- Right-click a dock tab to close it, close the other tabs, close the tabs to its left or right,
  or close all tabs. The connections, welcome and output panels stay open.
- A connection can compress its traffic: the "Compress traffic (zlib)" switch in the connection
  form adds `compressors=zlib` to the URI. snappy and zstd are not bundled, so they are not offered.
- Every option in the backup, restore, export and import dialogs has an info icon. Hover or focus
  it to read what the option does and, for backup and restore, which tool flag it sets.
- A backup configuration can be saved under a name, then loaded back into the backup dialog and
  renamed or deleted. A restore configuration can be saved the same way, and loading it checks that
  the backup is still there. Both are stored encrypted, per connection, without credentials, and
  are removed with the connection. A saved backup does not keep its folder.

### Changed

- The master password needs at least 4 characters instead of 10. The strength meter is unchanged.

### Fixed

- After a restore dry run, "Back to options" returns to the form with its options kept, so the
  run can be repeated or turned into the real restore.
- Completion offers the BSON constructors (`ISODate`, `ObjectId`, `Long`, `UUID` and others)
  where a value starts, the cursor methods after a `find` or `aggregate` chain, fields after a
  dotted parent and inside quoted keys, and keeps its context in a statement that spans lines.
  Typing two letters quickly no longer closes the suggestion list for the rest of the word.
- The Indexes panel and the profiler show the index types, collation and text weights of an index,
  a dash for a missing ratio or size, a SORT badge, durations from one second in seconds, and the
  date of older profiler entries, and offer every namespace in the loaded entries.
- Typing `db.` lists every collection of the database, including on slow or remote servers. The
  editor no longer depends on the shell's short collection lookup.
- Completion requests no longer hide the completions of the next keystroke, and a slow field sample
  no longer blanks completions while it runs.
- Field completion works inside queries on collections named with `db.getCollection("...")` or
  `db["..."]`.
- Completing `db.` on a collection whose name is not a valid identifier, such as `my-coll`, offers
  `db.getCollection("my-coll")` and no longer inserts an invalid `db.my-coll`.

## 0.1.0 - 2026-10-10

First tagged release.

### Connections and vault

- Stores saved connections, history, favourites, settings and layout in an encrypted SQLite database.
- Derives the store key from a master password with scrypt and encrypts with AES.
- Locks the vault after an idle timeout and on request, and changes the master password.
- Connects with a timeout, disconnects, and pings the server.
- Creates connections in URI mode or form mode, with TLS options and SRV records.
- Tests a connection before saving it.
- Loads databases and collections lazily in the connection tree, with document counts.
- Lists collections by type (collection, view, time series).
- Shows collection and database statistics.
- Redacts credentials from connection URIs in logs and error messages.

### Docker discovery

- Lists running MongoDB containers through the Docker Engine API on the local socket or named pipe.
- Recognises containers by image (mongo, mongodb/*, bitnami/mongodb, percona/percona-server-mongodb) or by port 27017.
- Shows a Docker node in the connection tree with container name, image tag and state, refreshed every 10 seconds.
- Prefills credentials from MONGO_INITDB_ROOT_USERNAME and MONGO_INITDB_ROOT_PASSWORD.
- Connects through the published host port, or through a socat forwarder for containers without one.
- Removes its forwarder containers on disconnect, on quit and on start.
- Connects to every discovered container on startup when the setting is on. The setting is off by default.

### Shell editor and results

- Runs mongosh statements in a supervised utility process for each connection.
- Completes mongosh APIs, collection names and sampled field names in a Monaco editor.
- Shows signature help for query operators.
- Runs the selection, or the statement under the cursor, with Ctrl+Enter.
- Runs multi-statement scripts and shows print output.
- Applies a timeout and a memory cap to each evaluation.
- Shows results as a grid, with nested fields flattened to dot paths and a column chooser.
- Shows results as an expandable tree with type badges, and copies a path or value from it.
- Shows results as read-only JSON in mongosh syntax.
- Pages results and shows the row count and elapsed time.
- Exports selected rows to JSON or CSV.
- Keeps a searchable query history with re-run.
- Keeps favourites with a name and a folder.

### Explain

- Runs explain for find, aggregate, count, distinct, update and delete at three verbosities.
- Reads the explain output of sharded deployments and of servers from 4.4 to 8.0.
- Normalises the plan into a stage tree with keys and documents examined, documents returned, time and children.
- Warns on COLLSCAN, in-memory SORT, a high examined-to-returned ratio, and FETCH after IXSCAN.
- Describes each stage in a catalogue with its category, its metrics and specific advice.
- Shows a summary bar with the index used, documents examined and returned, and time.
- Writes a plain-language explanation of the plan.
- Shows the raw explain document as EJSON, with search, folding and copy.

### Collection management

- Creates, renames, drops and clears databases and collections, including capped, time series and clustered options.
- Requires the name to be typed before a drop.
- Lists indexes with size and usage, and creates, drops, hides and unhides them.
- Creates indexes from a builder with unique, sparse, partial filter, TTL, collation, wildcard and text options.
- Shows index build progress.
- Edits JSON schema validators in Monaco and tests them against sample documents.
- Edits values inline in the tree view, with a BSON type picker.
- Inserts, duplicates and deletes documents.
- Deletes the current result set in bulk, with the filter shown in the confirmation.

### Monitoring dashboard

- Samples server metrics for each connection every 1 to 10 seconds and keeps one hour in a ring buffer.
- Charts operations, connections, network, memory, WiredTiger cache, queues, replication lag and the oplog window.
- Offers a catalogue of 30 server metrics, grouped by category, as dashboard panels.
- Adds, closes, resizes and reorders panels, and saves the layout per connection.
- Resets the layout to the default set.
- Lists running operations with filters, and kills an operation after confirmation.

### Profiler

- Reads and sets the profiling level and the slow operation threshold for each database.
- Lists slow operations, filtered by namespace, operation type, duration and time range.
- Tails new profile entries.
- Groups operations by query hash into top query shapes.
- Shows the command, plan summary and lock statistics of an operation in a detail pane.
- Opens a captured command in the explain view or in the editor.

### Import and export

- Imports JSON (array and newline-delimited) and CSV files.
- Maps fields in an import wizard with a preview and type inference.
- Exports a collection or a query result to JSON, NDJSON or CSV, with a filter.
- Shows transfer progress for imports and exports.

### Schema analysis

- Samples a set number of documents and reports each field's types and presence percentage.
- Shows example values and nested paths.
- Shows a summary, type bars and a field table.

### Users and roles

- Lists users of a database with their roles and authentication restrictions.
- Creates users, changes passwords, grants and revokes roles, and drops users after confirmation.
- Lists custom roles with their inherited roles and privileges.
- Creates and edits custom roles with a privilege editor.
- Keeps passwords in the main process, out of events and logs.

### Replica set

- Shows members with state, health, lag, priority, votes, hidden, delay, tags and arbiter status.
- Shows the oplog window and the election history.
- Steps down the primary, freezes a member, and adds, removes or edits a member.
- Initiates a replica set on a standalone server started with --replSet.
- Shows a dry-run summary before each reconfiguration.
- Refuses a reconfiguration that would lose quorum.

### Sharding

- Lists shards, databases with their primary shard, and sharded collections with shard key and chunk counts per shard.
- Shows the balancer state and window, and starts or stops the balancer.
- Enables sharding on a database and shards a collection, with key, unique and presplit options.
- Lists zones and tags.
- Shows the chunk distribution of a sharded collection, with a dry run.

### Diagnostics and sessions

- Views the server log, filtered by level, component and text.
- Shows startup warnings and command line options.
- Searches server parameters in a table.
- Shows host and build information.
- Explores serverStatus as a tree.
- Shows top, dbStats, collStats and connection pool statistics.
- Lists local and cluster sessions, and kills one session or all sessions of a user after confirmation.

### GridFS

- Lists GridFS buckets per database and the files in each bucket with their metadata.
- Uploads and downloads files with streaming.
- Deletes and renames files.
- Edits file metadata. A save replaces the whole metadata object.
- Matches filenames by substring.

### Change streams

- Watches a collection, a database or a deployment, with an optional pipeline and full-document option.
- Shows live events in a list, with pause, filter and a detail pane.
- Shows the resume token and resumes from a token.
- Stops the stream when the panel closes.

### Settings and themes

- Follows the system theme, or stays in light or dark.
- Provides a settings screen with sections, including an About section.
- Provides a keyboard shortcut reference.
- Saves the window size and position between launches.
- Sets the editor font size.
- Turns update checks off.

### Packaging and updates

- Builds an AppImage and a .deb for Linux (x64), an NSIS installer for Windows (x64), and a DMG and a ZIP for macOS (x64 and arm64).
- Ships unsigned builds, with ad-hoc signing on macOS.
- Creates a draft GitHub release for each v* tag, adds the installers from three runners, and publishes the release after all builds succeed.
- Checks GitHub for a new release about ten seconds after unlock and every six hours.
- Downloads and installs updates on the AppImage and the Windows installer.
- Shows a notice with a download link on the .deb and on macOS.
