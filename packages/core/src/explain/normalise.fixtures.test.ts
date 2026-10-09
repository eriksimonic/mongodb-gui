import { describe, expect, it } from 'vitest';
import {
  PlanTreeSchema,
  type PlanCommand,
  type PlanEngine,
  type PlanWarningCode,
} from './plan-tree';
import { normaliseExplain } from './normalise';

// Every committed fixture under ./fixtures, loaded as unknown JSON.
const FIXTURES = import.meta.glob<unknown>('./fixtures/**/*.json', {
  eager: true,
  import: 'default',
});

interface Expectation {
  readonly key: string;
  readonly command: PlanCommand;
  readonly engine: PlanEngine;
  readonly collectionScan: boolean;
  readonly indexesUsed: readonly string[];
  readonly inMemorySort: boolean;
  readonly warnings: readonly PlanWarningCode[];
}

// Entries are keyed by <directory>/<case>.<verbosity>. The rows were written from the normaliser
// output, and each one was checked against its fixture: the winning stage, the index names in
// the raw plan, and the sort or scan stages. Notes:
// - 4.4 omits the command echo for distinct, so its distinct plan reads as find.
// - sharded/* are hand-written, see fixtures/README.md.
// - No fixture produces MANY_REJECTED_PLANS or FETCH_AFTER_COVERED_INDEX. Those are covered by
//   synthetic cases in warnings.test.ts.
function e(
  key: string,
  command: PlanCommand,
  engine: PlanEngine,
  collectionScan: boolean,
  indexesUsed: readonly string[],
  inMemorySort: boolean,
  warnings: readonly PlanWarningCode[],
): Expectation {
  return { key, command, engine, collectionScan, indexesUsed, inMemorySort, warnings };
}

const EXPECTATIONS: readonly Expectation[] = [
  e('4.4/aggregate-group.allPlansExecution', 'aggregate', 'classic', false, ['status_1'], true, [
    'IN_MEMORY_SORT',
  ]),
  e('4.4/aggregate-group.executionStats', 'aggregate', 'classic', false, ['status_1'], true, [
    'IN_MEMORY_SORT',
  ]),
  e('4.4/aggregate-group.queryPlanner', 'aggregate', 'classic', false, ['status_1'], true, [
    'IN_MEMORY_SORT',
    'NO_EXECUTION_STATS',
  ]),
  e(
    '4.4/aggregate-lookup.allPlansExecution',
    'aggregate',
    'classic',
    false,
    ['status_1'],
    false,
    [],
  ),
  e('4.4/aggregate-lookup.executionStats', 'aggregate', 'classic', false, ['status_1'], false, []),
  e('4.4/aggregate-lookup.queryPlanner', 'aggregate', 'classic', false, ['status_1'], false, [
    'NO_EXECUTION_STATS',
  ]),
  e('4.4/collscan.allPlansExecution', 'find', 'classic', true, [], false, ['COLLSCAN']),
  e('4.4/collscan.executionStats', 'find', 'classic', true, [], false, ['COLLSCAN']),
  e('4.4/collscan.queryPlanner', 'find', 'classic', true, [], false, [
    'COLLSCAN',
    'NO_EXECUTION_STATS',
  ]),
  e(
    '4.4/competing.allPlansExecution',
    'find',
    'classic',
    false,
    ['customerId_1_createdAt_-1'],
    false,
    [],
  ),
  e(
    '4.4/competing.executionStats',
    'find',
    'classic',
    false,
    ['customerId_1_createdAt_-1'],
    false,
    [],
  ),
  e('4.4/competing.queryPlanner', 'find', 'classic', false, ['customerId_1_createdAt_-1'], false, [
    'NO_EXECUTION_STATS',
  ]),
  e('4.4/count.allPlansExecution', 'count', 'classic', false, ['status_1'], false, []),
  e('4.4/count.executionStats', 'count', 'classic', false, ['status_1'], false, []),
  e('4.4/count.queryPlanner', 'count', 'classic', false, ['status_1'], false, [
    'NO_EXECUTION_STATS',
  ]),
  e(
    '4.4/covered.allPlansExecution',
    'find',
    'classic',
    false,
    ['customerId_1_createdAt_-1'],
    false,
    [],
  ),
  e(
    '4.4/covered.executionStats',
    'find',
    'classic',
    false,
    ['customerId_1_createdAt_-1'],
    false,
    [],
  ),
  e('4.4/covered.queryPlanner', 'find', 'classic', false, ['customerId_1_createdAt_-1'], false, [
    'NO_EXECUTION_STATS',
  ]),
  e('4.4/delete.allPlansExecution', 'delete', 'classic', false, ['status_1'], false, []),
  e('4.4/delete.executionStats', 'delete', 'classic', false, ['status_1'], false, []),
  e('4.4/delete.queryPlanner', 'delete', 'classic', false, ['status_1'], false, [
    'NO_EXECUTION_STATS',
  ]),
  e('4.4/distinct.allPlansExecution', 'find', 'classic', false, ['status_1'], false, []),
  e('4.4/distinct.executionStats', 'find', 'classic', false, ['status_1'], false, []),
  e('4.4/distinct.queryPlanner', 'find', 'classic', false, ['status_1'], false, [
    'NO_EXECUTION_STATS',
  ]),
  e('4.4/in-memory-sort.allPlansExecution', 'find', 'classic', false, ['status_1'], true, [
    'IN_MEMORY_SORT',
  ]),
  e('4.4/in-memory-sort.executionStats', 'find', 'classic', false, ['status_1'], true, [
    'IN_MEMORY_SORT',
  ]),
  e('4.4/in-memory-sort.queryPlanner', 'find', 'classic', false, ['status_1'], true, [
    'IN_MEMORY_SORT',
    'NO_EXECUTION_STATS',
  ]),
  e(
    '4.4/ixscan-sort.allPlansExecution',
    'find',
    'classic',
    false,
    ['customerId_1_createdAt_-1'],
    false,
    [],
  ),
  e(
    '4.4/ixscan-sort.executionStats',
    'find',
    'classic',
    false,
    ['customerId_1_createdAt_-1'],
    false,
    [],
  ),
  e(
    '4.4/ixscan-sort.queryPlanner',
    'find',
    'classic',
    false,
    ['customerId_1_createdAt_-1'],
    false,
    ['NO_EXECUTION_STATS'],
  ),
  e('4.4/multikey.allPlansExecution', 'find', 'classic', false, ['items.sku_1'], false, [
    'MULTIKEY_INDEX',
  ]),
  e('4.4/multikey.executionStats', 'find', 'classic', false, ['items.sku_1'], false, [
    'MULTIKEY_INDEX',
  ]),
  e('4.4/multikey.queryPlanner', 'find', 'classic', false, ['items.sku_1'], false, [
    'MULTIKEY_INDEX',
    'NO_EXECUTION_STATS',
  ]),
  e(
    '4.4/or.allPlansExecution',
    'find',
    'classic',
    false,
    ['customerId_1_createdAt_-1', 'status_1'],
    false,
    [],
  ),
  e(
    '4.4/or.executionStats',
    'find',
    'classic',
    false,
    ['customerId_1_createdAt_-1', 'status_1'],
    false,
    [],
  ),
  e(
    '4.4/or.queryPlanner',
    'find',
    'classic',
    false,
    ['customerId_1_createdAt_-1', 'status_1'],
    false,
    ['NO_EXECUTION_STATS'],
  ),
  e('4.4/update-multi.allPlansExecution', 'update', 'classic', false, ['status_1'], false, []),
  e('4.4/update-multi.executionStats', 'update', 'classic', false, ['status_1'], false, []),
  e('4.4/update-multi.queryPlanner', 'update', 'classic', false, ['status_1'], false, [
    'NO_EXECUTION_STATS',
  ]),
  e('6.0-sbe/aggregate-group.allPlansExecution', 'aggregate', 'sbe', false, ['status_1'], true, [
    'IN_MEMORY_SORT',
  ]),
  e('6.0-sbe/aggregate-group.executionStats', 'aggregate', 'sbe', false, ['status_1'], true, [
    'IN_MEMORY_SORT',
  ]),
  e('6.0-sbe/aggregate-group.queryPlanner', 'aggregate', 'sbe', false, ['status_1'], true, [
    'IN_MEMORY_SORT',
    'NO_EXECUTION_STATS',
  ]),
  e(
    '6.0-sbe/aggregate-lookup.allPlansExecution',
    'aggregate',
    'sbe',
    false,
    ['customerId_1_createdAt_-1', 'status_1'],
    false,
    ['HIGH_EXAMINED_RATIO'],
  ),
  e(
    '6.0-sbe/aggregate-lookup.executionStats',
    'aggregate',
    'sbe',
    false,
    ['customerId_1_createdAt_-1', 'status_1'],
    false,
    ['HIGH_EXAMINED_RATIO'],
  ),
  e(
    '6.0-sbe/aggregate-lookup.queryPlanner',
    'aggregate',
    'sbe',
    false,
    ['customerId_1_createdAt_-1', 'status_1'],
    false,
    ['NO_EXECUTION_STATS'],
  ),
  e('6.0-sbe/collscan.allPlansExecution', 'find', 'sbe', true, [], false, ['COLLSCAN']),
  e('6.0-sbe/collscan.executionStats', 'find', 'sbe', true, [], false, ['COLLSCAN']),
  e('6.0-sbe/collscan.queryPlanner', 'find', 'sbe', true, [], false, [
    'COLLSCAN',
    'NO_EXECUTION_STATS',
  ]),
  e(
    '6.0-sbe/competing.allPlansExecution',
    'find',
    'sbe',
    false,
    ['customerId_1_createdAt_-1'],
    false,
    [],
  ),
  e(
    '6.0-sbe/competing.executionStats',
    'find',
    'sbe',
    false,
    ['customerId_1_createdAt_-1'],
    false,
    [],
  ),
  e('6.0-sbe/competing.queryPlanner', 'find', 'sbe', false, ['customerId_1_createdAt_-1'], false, [
    'NO_EXECUTION_STATS',
  ]),
  e('6.0-sbe/count.allPlansExecution', 'count', 'classic', false, ['status_1'], false, []),
  e('6.0-sbe/count.executionStats', 'count', 'classic', false, ['status_1'], false, []),
  e('6.0-sbe/count.queryPlanner', 'count', 'classic', false, ['status_1'], false, [
    'NO_EXECUTION_STATS',
  ]),
  e(
    '6.0-sbe/covered.allPlansExecution',
    'find',
    'sbe',
    false,
    ['customerId_1_createdAt_-1'],
    false,
    [],
  ),
  e(
    '6.0-sbe/covered.executionStats',
    'find',
    'sbe',
    false,
    ['customerId_1_createdAt_-1'],
    false,
    [],
  ),
  e('6.0-sbe/covered.queryPlanner', 'find', 'sbe', false, ['customerId_1_createdAt_-1'], false, [
    'NO_EXECUTION_STATS',
  ]),
  e('6.0-sbe/delete.allPlansExecution', 'delete', 'classic', false, ['status_1'], false, []),
  e('6.0-sbe/delete.executionStats', 'delete', 'classic', false, ['status_1'], false, []),
  e('6.0-sbe/delete.queryPlanner', 'delete', 'classic', false, ['status_1'], false, [
    'NO_EXECUTION_STATS',
  ]),
  e('6.0-sbe/distinct.allPlansExecution', 'distinct', 'sbe', false, ['status_1'], false, []),
  e('6.0-sbe/distinct.executionStats', 'distinct', 'sbe', false, ['status_1'], false, []),
  e('6.0-sbe/distinct.queryPlanner', 'distinct', 'sbe', false, ['status_1'], false, [
    'NO_EXECUTION_STATS',
  ]),
  e('6.0-sbe/in-memory-sort.allPlansExecution', 'find', 'sbe', false, ['status_1'], true, [
    'IN_MEMORY_SORT',
  ]),
  e('6.0-sbe/in-memory-sort.executionStats', 'find', 'sbe', false, ['status_1'], true, [
    'IN_MEMORY_SORT',
  ]),
  e('6.0-sbe/in-memory-sort.queryPlanner', 'find', 'sbe', false, ['status_1'], true, [
    'IN_MEMORY_SORT',
    'NO_EXECUTION_STATS',
  ]),
  e(
    '6.0-sbe/ixscan-sort.allPlansExecution',
    'find',
    'sbe',
    false,
    ['customerId_1_createdAt_-1'],
    false,
    [],
  ),
  e(
    '6.0-sbe/ixscan-sort.executionStats',
    'find',
    'sbe',
    false,
    ['customerId_1_createdAt_-1'],
    false,
    [],
  ),
  e(
    '6.0-sbe/ixscan-sort.queryPlanner',
    'find',
    'sbe',
    false,
    ['customerId_1_createdAt_-1'],
    false,
    ['NO_EXECUTION_STATS'],
  ),
  e('6.0-sbe/multikey.allPlansExecution', 'find', 'sbe', false, ['items.sku_1'], false, [
    'MULTIKEY_INDEX',
  ]),
  e('6.0-sbe/multikey.executionStats', 'find', 'sbe', false, ['items.sku_1'], false, [
    'MULTIKEY_INDEX',
  ]),
  e('6.0-sbe/multikey.queryPlanner', 'find', 'sbe', false, ['items.sku_1'], false, [
    'MULTIKEY_INDEX',
    'NO_EXECUTION_STATS',
  ]),
  e(
    '6.0-sbe/or.allPlansExecution',
    'find',
    'sbe',
    false,
    ['customerId_1_createdAt_-1', 'status_1'],
    false,
    [],
  ),
  e(
    '6.0-sbe/or.executionStats',
    'find',
    'sbe',
    false,
    ['customerId_1_createdAt_-1', 'status_1'],
    false,
    [],
  ),
  e(
    '6.0-sbe/or.queryPlanner',
    'find',
    'sbe',
    false,
    ['customerId_1_createdAt_-1', 'status_1'],
    false,
    ['NO_EXECUTION_STATS'],
  ),
  e('6.0-sbe/update-multi.allPlansExecution', 'update', 'classic', false, ['status_1'], false, []),
  e('6.0-sbe/update-multi.executionStats', 'update', 'classic', false, ['status_1'], false, []),
  e('6.0-sbe/update-multi.queryPlanner', 'update', 'classic', false, ['status_1'], false, [
    'NO_EXECUTION_STATS',
  ]),
  e('6.0/aggregate-group.allPlansExecution', 'aggregate', 'classic', false, ['status_1'], true, [
    'IN_MEMORY_SORT',
  ]),
  e('6.0/aggregate-group.executionStats', 'aggregate', 'classic', false, ['status_1'], true, [
    'IN_MEMORY_SORT',
  ]),
  e('6.0/aggregate-group.queryPlanner', 'aggregate', 'classic', false, ['status_1'], true, [
    'IN_MEMORY_SORT',
    'NO_EXECUTION_STATS',
  ]),
  e(
    '6.0/aggregate-lookup.allPlansExecution',
    'aggregate',
    'classic',
    false,
    ['customerId_1_createdAt_-1', 'status_1'],
    false,
    ['HIGH_EXAMINED_RATIO'],
  ),
  e(
    '6.0/aggregate-lookup.executionStats',
    'aggregate',
    'classic',
    false,
    ['customerId_1_createdAt_-1', 'status_1'],
    false,
    ['HIGH_EXAMINED_RATIO'],
  ),
  e('6.0/aggregate-lookup.queryPlanner', 'aggregate', 'classic', false, ['status_1'], false, [
    'NO_EXECUTION_STATS',
  ]),
  e('6.0/collscan.allPlansExecution', 'find', 'classic', true, [], false, ['COLLSCAN']),
  e('6.0/collscan.executionStats', 'find', 'classic', true, [], false, ['COLLSCAN']),
  e('6.0/collscan.queryPlanner', 'find', 'classic', true, [], false, [
    'COLLSCAN',
    'NO_EXECUTION_STATS',
  ]),
  e(
    '6.0/competing.allPlansExecution',
    'find',
    'classic',
    false,
    ['customerId_1_createdAt_-1'],
    false,
    [],
  ),
  e(
    '6.0/competing.executionStats',
    'find',
    'classic',
    false,
    ['customerId_1_createdAt_-1'],
    false,
    [],
  ),
  e('6.0/competing.queryPlanner', 'find', 'classic', false, ['customerId_1_createdAt_-1'], false, [
    'NO_EXECUTION_STATS',
  ]),
  e('6.0/count.allPlansExecution', 'count', 'classic', false, ['status_1'], false, []),
  e('6.0/count.executionStats', 'count', 'classic', false, ['status_1'], false, []),
  e('6.0/count.queryPlanner', 'count', 'classic', false, ['status_1'], false, [
    'NO_EXECUTION_STATS',
  ]),
  e(
    '6.0/covered.allPlansExecution',
    'find',
    'classic',
    false,
    ['customerId_1_createdAt_-1'],
    false,
    [],
  ),
  e(
    '6.0/covered.executionStats',
    'find',
    'classic',
    false,
    ['customerId_1_createdAt_-1'],
    false,
    [],
  ),
  e('6.0/covered.queryPlanner', 'find', 'classic', false, ['customerId_1_createdAt_-1'], false, [
    'NO_EXECUTION_STATS',
  ]),
  e('6.0/delete.allPlansExecution', 'delete', 'classic', false, ['status_1'], false, []),
  e('6.0/delete.executionStats', 'delete', 'classic', false, ['status_1'], false, []),
  e('6.0/delete.queryPlanner', 'delete', 'classic', false, ['status_1'], false, [
    'NO_EXECUTION_STATS',
  ]),
  e('6.0/distinct.allPlansExecution', 'distinct', 'classic', false, ['status_1'], false, []),
  e('6.0/distinct.executionStats', 'distinct', 'classic', false, ['status_1'], false, []),
  e('6.0/distinct.queryPlanner', 'distinct', 'classic', false, ['status_1'], false, [
    'NO_EXECUTION_STATS',
  ]),
  e('6.0/in-memory-sort.allPlansExecution', 'find', 'classic', false, ['status_1'], true, [
    'IN_MEMORY_SORT',
  ]),
  e('6.0/in-memory-sort.executionStats', 'find', 'classic', false, ['status_1'], true, [
    'IN_MEMORY_SORT',
  ]),
  e('6.0/in-memory-sort.queryPlanner', 'find', 'classic', false, ['status_1'], true, [
    'IN_MEMORY_SORT',
    'NO_EXECUTION_STATS',
  ]),
  e(
    '6.0/ixscan-sort.allPlansExecution',
    'find',
    'classic',
    false,
    ['customerId_1_createdAt_-1'],
    false,
    [],
  ),
  e(
    '6.0/ixscan-sort.executionStats',
    'find',
    'classic',
    false,
    ['customerId_1_createdAt_-1'],
    false,
    [],
  ),
  e(
    '6.0/ixscan-sort.queryPlanner',
    'find',
    'classic',
    false,
    ['customerId_1_createdAt_-1'],
    false,
    ['NO_EXECUTION_STATS'],
  ),
  e('6.0/multikey.allPlansExecution', 'find', 'classic', false, ['items.sku_1'], false, [
    'MULTIKEY_INDEX',
  ]),
  e('6.0/multikey.executionStats', 'find', 'classic', false, ['items.sku_1'], false, [
    'MULTIKEY_INDEX',
  ]),
  e('6.0/multikey.queryPlanner', 'find', 'classic', false, ['items.sku_1'], false, [
    'MULTIKEY_INDEX',
    'NO_EXECUTION_STATS',
  ]),
  e(
    '6.0/or.allPlansExecution',
    'find',
    'classic',
    false,
    ['customerId_1_createdAt_-1', 'status_1'],
    false,
    [],
  ),
  e(
    '6.0/or.executionStats',
    'find',
    'classic',
    false,
    ['customerId_1_createdAt_-1', 'status_1'],
    false,
    [],
  ),
  e(
    '6.0/or.queryPlanner',
    'find',
    'classic',
    false,
    ['customerId_1_createdAt_-1', 'status_1'],
    false,
    ['NO_EXECUTION_STATS'],
  ),
  e('6.0/update-multi.allPlansExecution', 'update', 'classic', false, ['status_1'], false, []),
  e('6.0/update-multi.executionStats', 'update', 'classic', false, ['status_1'], false, []),
  e('6.0/update-multi.queryPlanner', 'update', 'classic', false, ['status_1'], false, [
    'NO_EXECUTION_STATS',
  ]),
  e(
    '8.0.17-classic/aggregate-group.allPlansExecution',
    'aggregate',
    'classic',
    false,
    ['status_1'],
    true,
    ['IN_MEMORY_SORT'],
  ),
  e(
    '8.0.17-classic/aggregate-group.executionStats',
    'aggregate',
    'classic',
    false,
    ['status_1'],
    true,
    ['IN_MEMORY_SORT'],
  ),
  e(
    '8.0.17-classic/aggregate-group.queryPlanner',
    'aggregate',
    'classic',
    false,
    ['status_1'],
    true,
    ['IN_MEMORY_SORT', 'NO_EXECUTION_STATS'],
  ),
  e(
    '8.0.17-classic/aggregate-lookup.allPlansExecution',
    'aggregate',
    'classic',
    false,
    ['customerId_1_createdAt_-1', 'status_1'],
    false,
    ['HIGH_EXAMINED_RATIO'],
  ),
  e(
    '8.0.17-classic/aggregate-lookup.executionStats',
    'aggregate',
    'classic',
    false,
    ['customerId_1_createdAt_-1', 'status_1'],
    false,
    ['HIGH_EXAMINED_RATIO'],
  ),
  e(
    '8.0.17-classic/aggregate-lookup.queryPlanner',
    'aggregate',
    'classic',
    false,
    ['status_1'],
    false,
    ['NO_EXECUTION_STATS'],
  ),
  e('8.0.17-classic/collscan.allPlansExecution', 'find', 'classic', true, [], false, ['COLLSCAN']),
  e('8.0.17-classic/collscan.executionStats', 'find', 'classic', true, [], false, ['COLLSCAN']),
  e('8.0.17-classic/collscan.queryPlanner', 'find', 'classic', true, [], false, [
    'COLLSCAN',
    'NO_EXECUTION_STATS',
  ]),
  e(
    '8.0.17-classic/competing.allPlansExecution',
    'find',
    'classic',
    false,
    ['customerId_1_createdAt_-1'],
    false,
    [],
  ),
  e(
    '8.0.17-classic/competing.executionStats',
    'find',
    'classic',
    false,
    ['customerId_1_createdAt_-1'],
    false,
    [],
  ),
  e(
    '8.0.17-classic/competing.queryPlanner',
    'find',
    'classic',
    false,
    ['customerId_1_createdAt_-1'],
    false,
    ['NO_EXECUTION_STATS'],
  ),
  e('8.0.17-classic/count.allPlansExecution', 'count', 'classic', false, ['status_1'], false, []),
  e('8.0.17-classic/count.executionStats', 'count', 'classic', false, ['status_1'], false, []),
  e('8.0.17-classic/count.queryPlanner', 'count', 'classic', false, ['status_1'], false, [
    'NO_EXECUTION_STATS',
  ]),
  e(
    '8.0.17-classic/covered.allPlansExecution',
    'find',
    'classic',
    false,
    ['customerId_1_createdAt_-1'],
    false,
    [],
  ),
  e(
    '8.0.17-classic/covered.executionStats',
    'find',
    'classic',
    false,
    ['customerId_1_createdAt_-1'],
    false,
    [],
  ),
  e(
    '8.0.17-classic/covered.queryPlanner',
    'find',
    'classic',
    false,
    ['customerId_1_createdAt_-1'],
    false,
    ['NO_EXECUTION_STATS'],
  ),
  e('8.0.17-classic/delete.allPlansExecution', 'delete', 'classic', false, ['status_1'], false, []),
  e('8.0.17-classic/delete.executionStats', 'delete', 'classic', false, ['status_1'], false, []),
  e('8.0.17-classic/delete.queryPlanner', 'delete', 'classic', false, ['status_1'], false, [
    'NO_EXECUTION_STATS',
  ]),
  e(
    '8.0.17-classic/distinct.allPlansExecution',
    'distinct',
    'classic',
    false,
    ['status_1'],
    false,
    [],
  ),
  e(
    '8.0.17-classic/distinct.executionStats',
    'distinct',
    'classic',
    false,
    ['status_1'],
    false,
    [],
  ),
  e('8.0.17-classic/distinct.queryPlanner', 'distinct', 'classic', false, ['status_1'], false, [
    'NO_EXECUTION_STATS',
  ]),
  e(
    '8.0.17-classic/in-memory-sort.allPlansExecution',
    'find',
    'classic',
    false,
    ['status_1'],
    true,
    ['IN_MEMORY_SORT'],
  ),
  e('8.0.17-classic/in-memory-sort.executionStats', 'find', 'classic', false, ['status_1'], true, [
    'IN_MEMORY_SORT',
  ]),
  e('8.0.17-classic/in-memory-sort.queryPlanner', 'find', 'classic', false, ['status_1'], true, [
    'IN_MEMORY_SORT',
    'NO_EXECUTION_STATS',
  ]),
  e(
    '8.0.17-classic/ixscan-sort.allPlansExecution',
    'find',
    'classic',
    false,
    ['customerId_1_createdAt_-1'],
    false,
    [],
  ),
  e(
    '8.0.17-classic/ixscan-sort.executionStats',
    'find',
    'classic',
    false,
    ['customerId_1_createdAt_-1'],
    false,
    [],
  ),
  e(
    '8.0.17-classic/ixscan-sort.queryPlanner',
    'find',
    'classic',
    false,
    ['customerId_1_createdAt_-1'],
    false,
    ['NO_EXECUTION_STATS'],
  ),
  e('8.0.17-classic/multikey.allPlansExecution', 'find', 'classic', false, ['items.sku_1'], false, [
    'MULTIKEY_INDEX',
  ]),
  e('8.0.17-classic/multikey.executionStats', 'find', 'classic', false, ['items.sku_1'], false, [
    'MULTIKEY_INDEX',
  ]),
  e('8.0.17-classic/multikey.queryPlanner', 'find', 'classic', false, ['items.sku_1'], false, [
    'MULTIKEY_INDEX',
    'NO_EXECUTION_STATS',
  ]),
  e(
    '8.0.17-classic/or.allPlansExecution',
    'find',
    'classic',
    false,
    ['customerId_1_createdAt_-1', 'status_1'],
    false,
    [],
  ),
  e(
    '8.0.17-classic/or.executionStats',
    'find',
    'classic',
    false,
    ['customerId_1_createdAt_-1', 'status_1'],
    false,
    [],
  ),
  e(
    '8.0.17-classic/or.queryPlanner',
    'find',
    'classic',
    false,
    ['customerId_1_createdAt_-1', 'status_1'],
    false,
    ['NO_EXECUTION_STATS'],
  ),
  e(
    '8.0.17-classic/update-multi.allPlansExecution',
    'update',
    'classic',
    false,
    ['status_1'],
    false,
    [],
  ),
  e(
    '8.0.17-classic/update-multi.executionStats',
    'update',
    'classic',
    false,
    ['status_1'],
    false,
    [],
  ),
  e('8.0.17-classic/update-multi.queryPlanner', 'update', 'classic', false, ['status_1'], false, [
    'NO_EXECUTION_STATS',
  ]),
  e('8.0.17/aggregate-group.allPlansExecution', 'aggregate', 'sbe', false, ['status_1'], true, [
    'IN_MEMORY_SORT',
  ]),
  e('8.0.17/aggregate-group.executionStats', 'aggregate', 'sbe', false, ['status_1'], true, [
    'IN_MEMORY_SORT',
  ]),
  e('8.0.17/aggregate-group.queryPlanner', 'aggregate', 'sbe', false, ['status_1'], true, [
    'IN_MEMORY_SORT',
    'NO_EXECUTION_STATS',
  ]),
  e(
    '8.0.17/aggregate-lookup.allPlansExecution',
    'aggregate',
    'sbe',
    false,
    ['customerId_1_createdAt_-1', 'status_1'],
    false,
    ['HIGH_EXAMINED_RATIO'],
  ),
  e(
    '8.0.17/aggregate-lookup.executionStats',
    'aggregate',
    'sbe',
    false,
    ['customerId_1_createdAt_-1', 'status_1'],
    false,
    ['HIGH_EXAMINED_RATIO'],
  ),
  e(
    '8.0.17/aggregate-lookup.queryPlanner',
    'aggregate',
    'sbe',
    false,
    ['customerId_1_createdAt_-1', 'status_1'],
    false,
    ['NO_EXECUTION_STATS'],
  ),
  e('8.0.17/collscan.allPlansExecution', 'find', 'classic', true, [], false, ['COLLSCAN']),
  e('8.0.17/collscan.executionStats', 'find', 'classic', true, [], false, ['COLLSCAN']),
  e('8.0.17/collscan.queryPlanner', 'find', 'classic', true, [], false, [
    'COLLSCAN',
    'NO_EXECUTION_STATS',
  ]),
  e(
    '8.0.17/competing.allPlansExecution',
    'find',
    'classic',
    false,
    ['customerId_1_createdAt_-1'],
    false,
    [],
  ),
  e(
    '8.0.17/competing.executionStats',
    'find',
    'classic',
    false,
    ['customerId_1_createdAt_-1'],
    false,
    [],
  ),
  e(
    '8.0.17/competing.queryPlanner',
    'find',
    'classic',
    false,
    ['customerId_1_createdAt_-1'],
    false,
    ['NO_EXECUTION_STATS'],
  ),
  e('8.0.17/count.allPlansExecution', 'count', 'classic', false, ['status_1'], false, []),
  e('8.0.17/count.executionStats', 'count', 'classic', false, ['status_1'], false, []),
  e('8.0.17/count.queryPlanner', 'count', 'classic', false, ['status_1'], false, [
    'NO_EXECUTION_STATS',
  ]),
  e(
    '8.0.17/covered.allPlansExecution',
    'find',
    'classic',
    false,
    ['customerId_1_createdAt_-1'],
    false,
    [],
  ),
  e(
    '8.0.17/covered.executionStats',
    'find',
    'classic',
    false,
    ['customerId_1_createdAt_-1'],
    false,
    [],
  ),
  e('8.0.17/covered.queryPlanner', 'find', 'classic', false, ['customerId_1_createdAt_-1'], false, [
    'NO_EXECUTION_STATS',
  ]),
  e('8.0.17/delete.allPlansExecution', 'delete', 'classic', false, ['status_1'], false, []),
  e('8.0.17/delete.executionStats', 'delete', 'classic', false, ['status_1'], false, []),
  e('8.0.17/delete.queryPlanner', 'delete', 'classic', false, ['status_1'], false, [
    'NO_EXECUTION_STATS',
  ]),
  e('8.0.17/distinct.allPlansExecution', 'distinct', 'classic', false, ['status_1'], false, []),
  e('8.0.17/distinct.executionStats', 'distinct', 'classic', false, ['status_1'], false, []),
  e('8.0.17/distinct.queryPlanner', 'distinct', 'classic', false, ['status_1'], false, [
    'NO_EXECUTION_STATS',
  ]),
  e('8.0.17/in-memory-sort.allPlansExecution', 'find', 'classic', false, ['status_1'], true, [
    'IN_MEMORY_SORT',
  ]),
  e('8.0.17/in-memory-sort.executionStats', 'find', 'classic', false, ['status_1'], true, [
    'IN_MEMORY_SORT',
  ]),
  e('8.0.17/in-memory-sort.queryPlanner', 'find', 'classic', false, ['status_1'], true, [
    'IN_MEMORY_SORT',
    'NO_EXECUTION_STATS',
  ]),
  e(
    '8.0.17/ixscan-sort.allPlansExecution',
    'find',
    'classic',
    false,
    ['customerId_1_createdAt_-1'],
    false,
    [],
  ),
  e(
    '8.0.17/ixscan-sort.executionStats',
    'find',
    'classic',
    false,
    ['customerId_1_createdAt_-1'],
    false,
    [],
  ),
  e(
    '8.0.17/ixscan-sort.queryPlanner',
    'find',
    'classic',
    false,
    ['customerId_1_createdAt_-1'],
    false,
    ['NO_EXECUTION_STATS'],
  ),
  e('8.0.17/multikey.allPlansExecution', 'find', 'classic', false, ['items.sku_1'], false, [
    'MULTIKEY_INDEX',
  ]),
  e('8.0.17/multikey.executionStats', 'find', 'classic', false, ['items.sku_1'], false, [
    'MULTIKEY_INDEX',
  ]),
  e('8.0.17/multikey.queryPlanner', 'find', 'classic', false, ['items.sku_1'], false, [
    'MULTIKEY_INDEX',
    'NO_EXECUTION_STATS',
  ]),
  e(
    '8.0.17/or.allPlansExecution',
    'find',
    'classic',
    false,
    ['customerId_1_createdAt_-1', 'status_1'],
    false,
    [],
  ),
  e(
    '8.0.17/or.executionStats',
    'find',
    'classic',
    false,
    ['customerId_1_createdAt_-1', 'status_1'],
    false,
    [],
  ),
  e(
    '8.0.17/or.queryPlanner',
    'find',
    'classic',
    false,
    ['customerId_1_createdAt_-1', 'status_1'],
    false,
    ['NO_EXECUTION_STATS'],
  ),
  e('8.0.17/update-multi.allPlansExecution', 'update', 'classic', false, ['status_1'], false, []),
  e('8.0.17/update-multi.executionStats', 'update', 'classic', false, ['status_1'], false, []),
  e('8.0.17/update-multi.queryPlanner', 'update', 'classic', false, ['status_1'], false, [
    'NO_EXECUTION_STATS',
  ]),
  e(
    'sharded/find-sort.executionStats',
    'find',
    'classic',
    false,
    ['customerId_1_createdAt_-1'],
    false,
    [],
  ),
  e(
    'sharded/find.executionStats',
    'find',
    'classic',
    false,
    ['customerId_1_createdAt_-1'],
    false,
    [],
  ),
];

const EXPECTATION_BY_KEY = new Map(EXPECTATIONS.map((row) => [row.key, row]));

function fixtureKey(path: string): string {
  return path.replace(/^\.\/fixtures\//, '').replace(/\.json$/, '');
}

function verbosityOfKey(key: string): string {
  const dot = key.lastIndexOf('.');
  return key.slice(dot + 1);
}

describe('committed explain fixtures', () => {
  it('has exactly one expectation for every fixture and no stale expectation', () => {
    const fixtureKeys = Object.keys(FIXTURES).map(fixtureKey).sort();
    const expectedKeys = EXPECTATIONS.map((row) => row.key).sort();
    expect(new Set(expectedKeys).size).toBe(expectedKeys.length);
    expect(expectedKeys).toEqual(fixtureKeys);
  });

  it.each(Object.entries(FIXTURES))('normalises %s into the expected plan', (path, raw) => {
    const key = fixtureKey(path);
    const expected = EXPECTATION_BY_KEY.get(key);
    if (expected === undefined) {
      throw new Error(`no expectation for ${key}`);
    }
    const tree = normaliseExplain(raw);
    const parsed = PlanTreeSchema.safeParse(tree);
    expect(parsed.success).toBe(true);
    expect(tree.command).toBe(expected.command);
    expect(tree.engine).toBe(expected.engine);
    expect(tree.verbosity).toBe(verbosityOfKey(key));
    expect(tree.summary.collectionScan).toBe(expected.collectionScan);
    expect(tree.summary.indexesUsed).toEqual([...expected.indexesUsed]);
    expect(tree.summary.inMemorySort).toBe(expected.inMemorySort);
    expect(tree.warnings.map((warning) => warning.code)).toEqual([...expected.warnings]);
    expect(tree.sharded).toBe(key.startsWith('sharded/'));
    if (tree.verbosity === 'allPlansExecution') {
      // Each rejected plan pairs with its allPlansExecution entry, so it carries counters.
      for (const rejected of tree.rejected) {
        expect(rejected.nReturned, `${key} rejected ${rejected.name}`).toBeTypeOf('number');
      }
    }
    if (tree.verbosity === 'queryPlanner') {
      expect(tree.summary.executionTimeMs).toBeUndefined();
    } else {
      expect(tree.summary.executionTimeMs).toBeTypeOf('number');
    }
  });
});
