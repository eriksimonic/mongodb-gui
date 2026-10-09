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

## P3-4 cases

`capture/capture-explain.ts` captured the cases below from one real server per run. Each case
writes one file per version, `<version>/<case>.executionStats.json`, at `executionStats`
verbosity. The script seeds its own database, `explain_capture`, with `places`, `customers`,
`clustered` and `readings`. It starts its own container on a random port, and it stops the
container when it finishes.

Run it once per version, in the foreground:

    node --experimental-strip-types packages/core/src/explain/fixtures/capture/capture-explain.ts 6.0

Cases captured on 4.4, 6.0 and 8.0.17: `text-search`, `geo-2dsphere`, `geo-2d`,
`geo-near-aggregate`, `and-hash`, `sort-merge`, `idhack`, `express-unique`, `update-express`,
`delete-express`, `delete-many`, `sort-spill`, `group-spill`, `group-plain`, `lookup-pipeline`,
`lookup-indexed`, `lookup-unindexed`, `union-with`, `facet`, `graph-lookup`, `pipeline-stages`,
`out-stage`, `merge-stage`, `limit-skip`, `projection-default`, `cached-plan` and `or-subplan`.

Skipped, with the reason:

- `clustered-id` on 4.4. Clustered collections need 5.3 or newer, and the capture creates the
  collection only from 6.0 on.
- `timeseries-find` on 4.4. Timeseries collections need 5.0 or newer.

No capture case failed on any version.

Hand-written: `sharded/sharding-filter.executionStats.json` (SHARDING_FILTER with 480 orphans on
one shard). The shard and merge stages come from the two older files.

## P3-4 observed differences

- 4.4 reports `usedDisk` on a sort that spilled, but no `spills` count. 6.0 adds `spills`.
  8.0 adds `spilledDataStorageSize`.
- 6.0 reports `usedDisk: true` on a classic `$group` that spilled. 4.4 reports no spill fields
  on its `$group`. The 8.0 `group-spill` case did not spill, because the slot-based group
  reads a different memory parameter, which the capture does not set. Its `GROUP` stage reports
  `spills: 0`.
- A `$lookup` with an inner pipeline shows no inner plan on any version, so the normaliser
  models the inner pipeline from its spec.
- 8.0 shows an indexed equality join as `EQ_LOOKUP` with an `indexName`, and an unindexed one as
  `EQ_LOOKUP` without an index name, executed as `hash_lookup`. 4.4 and 6.0 show no index
  evidence on the `$lookup` stage for either form.
- `$unionWith` reports its input as a `$cursor` with its own `queryPlanner` and `executionStats`.
- Each `$facet` branch reports its stages with their counters.
- `$geoNear` runs its query under a `$geoNearCursor` key, not `$cursor`.
- A timeseries find is an aggregate over `$cursor`, `$match`, `$_internalUnpackBucket` and
  `$_internalBoundedSort` on 6.0 and 8.0.
- 8.0 uses `EXPRESS_IXSCAN` for `_id` and unique equality matches, and `EXPRESS_CLUSTERED_IXSCAN`
  for a clustered key. `UPDATE` and `DELETE` keep their `FETCH` child. `deleteMany` shows
  `BATCHED_DELETE` on 8.0 and `DELETE` on 6.0.
- `SORT_MERGE` sits under `FETCH` on 6.0 and 8.0 and under `SUBPLAN` on 4.4.

Stages in the catalogue that no captured case produced: `AND_SORTED`, `AND_HASH` (the and-hash
case used a single index), `CACHED_PLAN` (the cached-plan case explains as its plan), `TEXT_OR`,
`EXPRESS_UPDATE`, `EXPRESS_DELETE`, `SORT_KEY_GENERATOR`, `SHARD_MERGE_SORT` in the captured set
(the hand-written file covers it), and `SHARDING_FILTER` (the hand-written file covers it).
