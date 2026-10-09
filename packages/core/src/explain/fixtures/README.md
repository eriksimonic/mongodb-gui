# Explain fixtures

Raw explain output from real servers, used by `normalise.fixtures.test.ts`.

## Captured fixtures

The directories `4.4`, `6.0`, `6.0-sbe`, `8.0.17` and `8.0.17-classic` hold output captured by
`packages/mongo-adapter/src/explain-fixtures.integration.test.ts`. One run wrote them. The test
writes files only when `CAPTURE_EXPLAIN_FIXTURES=1`.

Each file is `<case>.<verbosity>.json` and holds the explain result as canonical EJSON, pretty
printed with two spaces. Each case runs at `queryPlanner`, `executionStats` and
`allPlansExecution`.

| Directory | Server | Setting | Engine seen |
|---|---|---|---|
| `4.4` | `mongo:4.4` (4.4.30) | none | classic |
| `6.0` | `mongo:6.0` (6.0.28) | none | classic (forced by default) |
| `6.0-sbe` | `mongo:6.0` | `--setParameter featureFlagSbeFull=true` and runtime `internalQueryForceClassicEngine: false` | slot-based for find |
| `8.0.17` | `mongo:8.0.17` | none | classic for find and count, slot-based for aggregate |
| `8.0.17-classic` | `mongo:8.0.17` | runtime `internalQueryFrameworkControl: forceClassicEngine` | classic everywhere |

The seed data is 2000 orders, with indexes on `{ customerId: 1, createdAt: -1 }`, `{ status: 1 }`,
`{ 'items.sku': 1 }` and a text index on `tags`.

The cases are `collscan`, `ixscan-sort`, `in-memory-sort`, `covered`, `multikey`, `or`, `count`,
`distinct`, `aggregate-group`, `aggregate-lookup`, `update-multi` and `delete`.

No case was skipped. `$lookup` runs on all three versions, because it has worked since 3.2. The
`minMajor` field in the capture test is there for cases that need a newer server. None is set.

## Hand-written fixtures

`sharded/find.executionStats.json` and `sharded/find-sort.executionStats.json` are hand-written.
They follow the documented sharded shape, and no server was used to produce them:

- `find` uses the older mongos shape. `queryPlanner.winningPlan.shards[]` has no stage name, and
  `executionStats.executionStages` has the `SHARD_MERGE` stage with a `shards[]` array.
- `find-sort` uses the newer shape. `queryPlanner.winningPlan.stage` is `SHARD_MERGE_SORT` with a
  `shards[]` array.

These two files use plain JSON numbers, which relaxed EJSON allows. The normaliser reads both forms.

## Observed differences

- 4.4 does not echo the command in explain output. Find, count, distinct, update and delete all
  lack a `command` field. The normaliser then reads the command from the winning stage. A distinct
  on a plain index is a `PROJECTION_SIMPLE` on 4.4, so it is read as `find`.
- 6.0 echoes `command` and `explainVersion`. 4.4 has no `explainVersion`.
- 8.0 changed the distinct plan to a `FETCH` over `IXSCAN`. 4.4 and 6.0 use `PROJECTION_SIMPLE`.
- The slot-based engine reports lowercase stage names (`scan`, `ixseek`, `nlj`, `filter`, `mkobj`,
  `sort`). Its `executionStages` tree does not match the classic `queryPlanner` tree. Its
  `queryPlan` and `slotBasedPlan` keys appear under `winningPlan`.
- Aggregates with `$group` or `$lookup` use the slot-based engine on 8.0 by default. On 6.0 they
  use the classic engine unless the SBE flag is on.
- The `$cursor` stage of an aggregate holds a nested explain. The pipeline stages that follow it
  carry their counters beside the stage name, not inside its spec.
- Canonical EJSON wraps every integer as `$numberInt` or `$numberLong`.

## Known gaps

No captured case produces `MANY_REJECTED_PLANS`, because no rejected plans appeared for these
queries. No case produces `FETCH_AFTER_COVERED_INDEX` either. Both codes are covered by
synthetic cases in `warnings.test.ts`.
