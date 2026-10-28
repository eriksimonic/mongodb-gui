# Gap matrix against NoSQLBooster and other clients

Sources: nosqlbooster.com/features, nosqlbooster.com/uniqueFeatures, mongodb-gui-tools.com (October 2026 comparison of Compass, Navicat, NoSQLBooster, NoSQLManager and Studio 3T).

Only open rows are listed: features that are Partial, Gap or Check, and items with a decision. Built features are left out.

Status: Partial, Gap, Check. "Seen in" names the clients that list the feature. NSB is NoSQLBooster, S3T is Studio 3T.
Decision column is for you: In, Out, Later.

## Connection

| Feature                                                 | Status                                              | Seen in           | Decision |
| ------------------------------------------------------- | --------------------------------------------------- | ----------------- | -------- |
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
| Edit results of an aggregate                             | Gap (plain find edits scalar cells)                                            | NSB               |          |

## Results and data views

| Feature                                       | Status                                               | Seen in      | Decision |
| --------------------------------------------- | ---------------------------------------------------- | ------------ | -------- |
| One-click group and filter on a result column | Gap                                                  | NSB (unique) | Out      |
| Column filter and sort on the result          | Partial (client-side sort on loaded rows, no filter) | all          | Out      |
| Nested field column groups in the grid        | Partial (dotted paths)                               | NSB          | explore  |
| GeoJSON map viewer                            | Gap                                                  | NSB (unique) | no       |
| Image viewer, binary and text viewer/editor   | Gap                                                  | NSB, S3T     | yes      |

## Management

| Feature                                                | Status                                                                             | Seen in  | Decision                 |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------- | -------- | ------------------------ |
| Copy or paste collections across databases and servers | Gap (design only, no code: `docs/implementation-notes.md`, copy, compare and sync) | NSB, S3T | yes but more intentional |
| Copy or paste databases across servers                 | Gap                                                                                | NSB, S3T | yes but more intentional |
| Data compare and sync                                  | Gap                                                                                | S3T      | yes a specific project   |

## Monitoring

| Feature                                            | Status                                                                                       | Seen in      | Decision |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------- | ------------ | -------- |
| mongotop view                                      | Have (Diagnostics `top`, interval picker and delta switch, not yet checked on a live server) | NSB, Compass | yes      |
| Log file parser (upload a mongod log file to JSON) | Gap                                                                                          | NSB (unique) | no       |

## Import, export, schema

| Feature                            | Status | Seen in  | Decision         |
| ---------------------------------- | ------ | -------- | ---------------- |
| Export to Excel                    | Gap    | NSB, S3T |                  |
| Export to SQL file                 | Gap    | NSB, S3T | yes, later       |
| Import from SQL database (migrate) | Gap    | NSB, S3T | yes later        |
| Migrate MongoDB to SQL             | Gap    | S3T      | no               |
| Schema documentation export        | Gap    | NSB, S3T | yes need purpose |
| Reschema (schema optimisation)     | Gap    | NSB, S3T | yes, purpose     |

## Automation and app

Automation is not built. Revisit if needed.

| Feature                                               | Status                                                                  | Seen in  | Decision |
| ----------------------------------------------------- | ----------------------------------------------------------------------- | -------- | -------- |
| Saved tasks (import/export, dump/restore, run script) | Partial (saved backup and restore configs, no scheduling or script run) | NSB, S3T |          |
| Task scheduler                                        | Gap                                                                     | NSB, S3T |          |
| Email notification for tasks                          | Gap                                                                     | NSB      |          |
| Command line interface for tasks                      | Gap                                                                     | NSB      |          |
| Custom keyboard shortcuts                             | Gap (reference only, no rebinding)                                      | NSB, S3T |          |
| In-app tutorials                                      | Gap                                                                     | NSB      |          |
| Collaboration                                         | Gap                                                                     | S3T      |          |
| Multi-language UI                                     | Gap                                                                     | none     |          |

## Easy tasks

Open items from the easy task list.

- [ ] ES2022+ in scripts: run a script using `??`, `?.`, `#private` fields and top-level `await` in the editor. Fix what fails, or mark the ES2022+ row in Editor and scripting as Have.
- [ ] mongotop view: check the Diagnostics `top` view against a live server and update its row in Monitoring.
- [ ] Test data generator: list the NoSQLBooster generator options (field types, count, locale, relations), compare them with ours, and record the differences. Add the cheapest missing option.
- [ ] Nested field column groups: show how dotted paths render today. Decide whether to group nested fields under a parent header and record the decision in the Results row.
- [ ] Connections export: preselect the rows picked in the table. The export dialog still lists all connections.
- [ ] Connections import from a NoSQLBooster backup file. Blocked until the user provides a sample file, because the format is not documented.
</content>
