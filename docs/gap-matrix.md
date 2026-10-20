# Gap matrix against NoSQLBooster and other clients

Sources: nosqlbooster.com/features, nosqlbooster.com/uniqueFeatures, mongodb-gui-tools.com (October 2026 comparison of Compass, Navicat, NoSQLBooster, NoSQLManager and Studio 3T).

Status: Have, Partial, Gap. "Seen in" names the clients that list the feature. NSB is NoSQLBooster, S3T is Studio 3T.
Decision column is for you: In, Out, Later.

## Connection

| Feature                                                 | Status                                              | Seen in           | Decision |
| ------------------------------------------------------- | --------------------------------------------------- | ----------------- | -------- |
| URI and form connections, SRV                           | Have                                                | all               |          |
| TLS with CA and client certificate files                | Have                                                | all               |          |
| Connection colour                                       | Have                                                | NSB               |          |
| Read preference, connect timeout                        | Have                                                | all               |          |
| Connection export and import (encrypted)                | Have                                                | NSB, S3T          |          |
| Compress traffic (zlib)                                 | Have (0.2.0)                                        | Compass           |          |
| Connection table with sort, filter and last used time   | Have (0.3.0)                                        | NSB               |          |
| SSH tunnel                                              | Gap                                                 | all               |          |
| Proxy (SOCKS5/HTTP) connection                          | Gap                                                 | Compass, S3T      |          |
| x.509 authentication                                    | Gap (form has no mechanism field, the URI may work) | all               | Later    |
| Kerberos and LDAP authentication                        | Gap                                                 | all               | Later    |
| AWS IAM authentication                                  | Gap                                                 | all               | Later    |
| OIDC/OAuth 2.0 authentication                           | Gap                                                 | all               | Later    |
| In-use encryption (CSFLE/QE) connection                 | Gap                                                 | NSB, Compass      |          |
| Read-only connection mode                               | Gap                                                 | NSB, S3T, Compass |          |
| Switch replica set member or database inside the editor | Gap                                                 | NSB (unique)      |          |

## Editor and scripting

| Feature                                                  | Status                                                                         | Seen in           | Decision |
| -------------------------------------------------------- | ------------------------------------------------------------------------------ | ----------------- | -------- |
| mongosh statements, multi-statement scripts              | Have                                                                           | all               |          |
| Completion for collections, fields, operators            | Have                                                                           | NSB, S3T          |          |
| T-SQL mode with translated mongosh shown                 | Have                                                                           | NSB, S3T          |          |
| Query history and favourites                             | Have                                                                           | all               |          |
| Snippets library                                         | Partial (operator completion only)                                             | NSB               |          |
| On-the-fly error detection                               | Partial (SQL translation errors underline the clause, no mongosh syntax check) | NSB               | Yes      |
| Mouse hover docs, F1 to online docs                      | Gap                                                                            | NSB               |          |
| Script debugger with breakpoints                         | Gap                                                                            | NSB (unique)      |          |
| Fluent query API (`where().gte()`)                       | Gap                                                                            | NSB (unique)      | yes      |
| Node/npm modules, lodash, moment in scripts              | Gap                                                                            | NSB               |          |
| ES2022+ in scripts                                       | Check (mongosh runs on Node, likely Have)                                      | NSB (unique)      | ??       |
| Mark changed lines in editor                             | Gap                                                                            | NSB               |          |
| Command palette                                          | Gap                                                                            | NSB               |          |
| Query code generator (Node, Java, Python, C# and others) | Gap                                                                            | NSB, S3T, Compass | no       |
| Visual find builder                                      | Gap                                                                            | NSB, S3T, Compass | no       |
| Visual aggregation builder                               | Gap                                                                            | S3T, Compass      | no       |
| AI helper, natural language to query, schema aware       | Gap                                                                            | NSB, S3T, Compass | no       |
| Interactive samples and "My Queries" tree                | Gap                                                                            | NSB (unique)      |          |
| Update-in-place of a find result from a script           | Have (tree edit on plain find)                                                 | NSB               |          |
| Edit results of an aggregate                             | Gap (plain find edits scalar cells, 0.4.1)                                     | NSB               |          |

## Results and data views

| Feature                                       | Status                                               | Seen in      | Decision |
| --------------------------------------------- | ---------------------------------------------------- | ------------ | -------- |
| Table, tree and JSON views                    | Have                                                 | all          |          |
| Inline edit with BSON type picker             | Have                                                 | all          |          |
| Scroll paging                                 | Have                                                 | all          |          |
| Copy cell, key, document                      | Have                                                 |              |          |
| One-click group and filter on a result column | Gap                                                  | NSB (unique) | Out      |
| Column filter and sort on the result          | Partial (client-side sort on loaded rows, no filter) | all          | Out      |
| Nested field column groups in the grid        | Partial (dotted paths)                               | NSB          | explore  |
| GeoJSON map viewer                            | Gap                                                  | NSB (unique) | no       |
| Image viewer, binary and text viewer/editor   | Gap                                                  | NSB, S3T     | yes      |
| EJSON relaxed and canonical output            | Have                                                 | NSB          |          |

## Management

| Feature                                                | Status                                                                  | Seen in    | Decision                 |
| ------------------------------------------------------ | ----------------------------------------------------------------------- | ---------- | ------------------------ |
| Databases, collections, views                          | Have                                                                    | all        |                          |
| Indexes (create, edit, hide, drop)                     | Have                                                                    | all        |                          |
| Validators                                             | Have                                                                    | all        |                          |
| Users and roles                                        | Have                                                                    | all        |                          |
| GridFS                                                 | Have                                                                    | NSB, S3T   |                          |
| Replica set and sharding admin                         | Have                                                                    | beyond NSB |                          |
| Docker discovery and management                        | Have                                                                    | beyond NSB |                          |
| Docker container credentials dialog                    | Have (0.2.0)                                                            | beyond NSB |                          |
| Copy or paste collections across databases and servers | Gap (design only, no code: `docs/plans/2026-10-17-copy-sync.design.md`) | NSB, S3T   | yes but more intentional |
| Copy or paste databases across servers                 | Gap                                                                     | NSB, S3T   | yes but more intentional |
| Data compare and sync                                  | Gap                                                                     | S3T        | yes a specific project   |

## Monitoring

| Feature                                            | Status                                                                                       | Seen in      | Decision                                              |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------- | ------------ | ----------------------------------------------------- |
| Real-time server monitor (mongostat)               | Have                                                                                         | all          |                                                       |
| Storage usage panel (sizes, insights)              | Have (0.4.2)                                                                                 | beyond NSB   |                                                       |
| mongotop view                                      | Have (Diagnostics `top`, interval picker and delta switch, not yet checked on a live server) | NSB, Compass | yes                                                   |
| Current operations, kill                           | Have                                                                                         | NSB, S3T     |                                                       |
| Profiler                                           | Have                                                                                         | NSB, S3T     |                                                       |
| Change streams                                     | Have                                                                                         | NSB          |                                                       |
| Server log viewer                                  | Have (log in Diagnostics)                                                                    | NSB          | yes, this is different as it parses the log, and yes. |
| Log file parser (upload a mongod log file to JSON) | Gap                                                                                          | NSB (unique) | no                                                    |

## Import, export, schema

| Feature                                                              | Status       | Seen in    | Decision                                                            |
| -------------------------------------------------------------------- | ------------ | ---------- | ------------------------------------------------------------------- |
| Import JSON and CSV with mapping                                     | Have         | all        |                                                                     |
| Export JSON, NDJSON, CSV                                             | Have         | all        |                                                                     |
| Export to Excel                                                      | Gap          | NSB, S3T   |                                                                     |
| Export to SQL file                                                   | Gap          | NSB, S3T   | yes, later                                                          |
| Import from SQL database (migrate)                                   | Gap          | NSB, S3T   | yes later                                                           |
| Migrate MongoDB to SQL                                               | Gap          | S3T        | no                                                                  |
| mongodump and mongorestore                                           | Have         | all        |                                                                     |
| Backup and restore of one database or collection, with saved configs | Have (0.2.0) | S3T        |                                                                     |
| Tools version check and download                                     | Have (0.2.0) | beyond NSB |                                                                     |
| Test data generator                                                  | Have         | NSB        | validate agains NSB                                                 |
| Schema analysis                                                      | Have         | all        | compare to others                                                   |
| Schema documentation export                                          | Gap          | NSB, S3T   | yes need purpose                                                    |
| Reschema (schema optimisation)                                       | Gap          | NSB, S3T   | yes, purpose                                                        |
| Visual explain                                                       | Have         | all        | I like the compas view how ti loks as it builds a tree of execution |

## Automation and app

### autoamtion is not suported in this app at all, if needed we will implement tihs later.

| Feature                                               | Status                                                    | Seen in    | Decision |
| ----------------------------------------------------- | --------------------------------------------------------- | ---------- | -------- |
| Saved tasks (import/export, dump/restore, run script) | Gap                                                       | NSB, S3T   |          |
| Task scheduler                                        | Gap                                                       | NSB, S3T   |          |
| Email notification for tasks                          | Gap                                                       | NSB        |          |
| Command line interface for tasks                      | Gap                                                       | NSB        |          |
| Auto update                                           | Have                                                      | all        |          |
| Dark and light theme                                  | Have                                                      | all        |          |
| Custom keyboard shortcuts                             | Gap (reference only, no rebinding)                        | NSB, S3T   |          |
| Save and restore session                              | Have (layout, window and open editor tabs per connection) | NSB, S3T   |          |
| In-app tutorials                                      | Gap                                                       | NSB        |          |
| Collaboration                                         | Gap                                                       | S3T        |          |
| Multi-language UI                                     | Gap                                                       | none       |          |
| Encrypted store with master password and idle lock    | Have                                                      | beyond NSB |          |
