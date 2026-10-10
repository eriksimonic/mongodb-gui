# Changelog

All notable changes to Mongo GUI are listed here, newest first.

## Unreleased

### Added

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

### Changed

- The master password needs at least 4 characters instead of 10. The strength meter is unchanged.

### Fixed

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
