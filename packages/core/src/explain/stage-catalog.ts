// What each stage name in an explain plan means. The planner emits classic names (COLLSCAN,
// FETCH), slot-based names in lowercase (scan, nlj), and aggregation names ($lookup, $group).
// Names that are not listed get a generic entry, so the caller never has to handle a miss.

export const STAGE_CATEGORIES = [
  'scan',
  'fetch',
  'filter',
  'sort',
  'projection',
  'limit',
  'lookup',
  'group',
  'merge',
  'sharding',
  'text',
  'geo',
  'write',
  'cache',
  'express',
  'unknown',
] as const;

export type StageCategory = (typeof STAGE_CATEGORIES)[number];

// Keys of a normalised PlanStage that a stage can report. A stage lists the ones that carry a
// meaningful value for it, so the panel shows only those.
export const STAGE_METRICS = [
  'docsExamined',
  'keysExamined',
  'nReturned',
  'executionTimeMs',
  'works',
  'memUsageBytes',
  'memLimitBytes',
  'usedDisk',
  'spills',
  'spilledBytes',
  'chunkSkips',
  'index',
] as const;

export type StageMetric = (typeof STAGE_METRICS)[number];

export interface StageInfo {
  readonly name: string;
  readonly category: StageCategory;
  // One plain sentence.
  readonly description: string;
  readonly metrics: readonly StageMetric[];
  // Advice for this stage when a plan shows it. Absent when the stage needs none.
  readonly advice?: string;
}

const SORT_ADVICE =
  'Add an index whose keys match the sort order, so the server returns documents in order without sorting.';
const SPILL_ADVICE =
  'A sort that spills to disk writes temporary files and runs slowly. Add an index that matches the sort, or add a $match that returns fewer documents.';
const GROUP_ADVICE =
  'Put a $match before the $group so fewer documents reach it. A group that spills to disk writes temporary files, so reduce the number of distinct group keys or the size of the pushed values.';
const LOOKUP_ADVICE =
  'Without an index on the foreign field, the join reads the foreign collection for each input document. Create an index on the foreignField.';
const SCAN_ADVICE =
  'The query reads every document. Add an index on the fields in the filter, with the equality fields first and the range or sort fields after.';
const FETCH_ADVICE =
  'Each fetched document costs a read. An index that holds every returned field lets the query skip the fetch.';
const MATCH_AFTER_BLOCKING_ADVICE =
  'A $match placed after a $group or $sort sees only the output of that stage. Move the $match before it so fewer documents are grouped or sorted.';
const OR_ADVICE =
  'An $or runs one scan for each clause. A clause without an index forces a collection scan, so index every clause.';
const SHARD_FILTER_ADVICE =
  'Orphan documents are left on a shard after a chunk moved away. Run cleanupOrphaned once the balancer finishes, or check whether a migration failed.';

const CATALOG: readonly StageInfo[] = [
  // Scans and fetches
  {
    name: 'COLLSCAN',
    category: 'scan',
    description: 'Reads every document in the collection and applies the filter to each one.',
    metrics: ['docsExamined', 'nReturned', 'executionTimeMs', 'works'],
    advice: SCAN_ADVICE,
  },
  {
    name: 'IXSCAN',
    category: 'scan',
    description: 'Reads the index keys within the query bounds, in index order.',
    metrics: ['keysExamined', 'nReturned', 'executionTimeMs', 'works', 'index'],
  },
  {
    name: 'FETCH',
    category: 'fetch',
    description: 'Reads the full document for each record the child stage returns.',
    metrics: ['docsExamined', 'nReturned', 'executionTimeMs'],
    advice: FETCH_ADVICE,
  },
  {
    name: 'COUNT',
    category: 'group',
    description: 'Counts the documents its child stage returns and returns one number.',
    metrics: ['nReturned', 'docsExamined', 'executionTimeMs'],
  },
  {
    name: 'COUNT_SCAN',
    category: 'scan',
    description: 'Counts the matching index keys without reading documents.',
    metrics: ['keysExamined', 'nReturned', 'executionTimeMs', 'index'],
  },
  {
    name: 'DISTINCT_SCAN',
    category: 'scan',
    description: 'Reads one index key for each distinct value of the field.',
    metrics: ['keysExamined', 'nReturned', 'executionTimeMs', 'index'],
  },
  {
    name: 'IDHACK',
    category: 'scan',
    description: 'Looks up one document by its _id through the _id index.',
    metrics: ['keysExamined', 'docsExamined', 'nReturned', 'executionTimeMs'],
  },
  {
    name: 'CACHED_PLAN',
    category: 'cache',
    description: 'Shows that the server reused a plan from its plan cache for this query shape.',
    metrics: ['nReturned', 'executionTimeMs', 'works'],
    advice:
      'A cached plan can be slow after the data changes. Run the query again with a new shape or clear the plan cache for the collection.',
  },
  {
    name: 'SUBPLAN',
    category: 'filter',
    description: 'Plans each $or clause on its own, then runs the chosen plan for each clause.',
    metrics: ['nReturned', 'executionTimeMs'],
    advice: OR_ADVICE,
  },
  {
    name: 'OR',
    category: 'filter',
    description: 'Merges the results of its child plans for an $or query and removes duplicates.',
    metrics: ['nReturned', 'docsExamined', 'executionTimeMs'],
    advice: OR_ADVICE,
  },
  {
    name: 'AND_SORTED',
    category: 'filter',
    description: 'Intersects index scans that return keys in the same order.',
    metrics: ['nReturned', 'keysExamined', 'docsExamined', 'executionTimeMs'],
  },
  {
    name: 'AND_HASH',
    category: 'filter',
    description: 'Intersects index scans by building a hash table of the keys of the first scan.',
    metrics: ['nReturned', 'memUsageBytes', 'memLimitBytes', 'executionTimeMs'],
    advice:
      'Intersecting single-field indexes costs a hash table in memory. A compound index on the filtered fields is usually faster.',
  },
  // Sorting
  {
    name: 'SORT',
    category: 'sort',
    description:
      'Sorts the documents in memory, or on disk when they exceed the memory limit of the sort.',
    metrics: [
      'nReturned',
      'executionTimeMs',
      'memUsageBytes',
      'memLimitBytes',
      'usedDisk',
      'spills',
      'spilledBytes',
    ],
    advice: `${SORT_ADVICE} ${SPILL_ADVICE}`,
  },
  {
    name: 'SORT_MERGE',
    category: 'sort',
    description: 'Merges several sorted index streams from an $or into one sorted stream.',
    metrics: ['nReturned', 'executionTimeMs'],
  },
  {
    name: 'SORT_KEY_GENERATOR',
    category: 'sort',
    description: 'Computes the sort key of each document before the sort runs.',
    metrics: ['nReturned', 'executionTimeMs'],
  },
  // Projections
  {
    name: 'PROJECTION_SIMPLE',
    category: 'projection',
    description: 'Applies an inclusion or exclusion projection to each document.',
    metrics: ['nReturned', 'executionTimeMs'],
  },
  {
    name: 'PROJECTION_COVERED',
    category: 'projection',
    description: 'Returns the projected fields from the index keys, so no document is read.',
    metrics: ['nReturned', 'keysExamined', 'executionTimeMs'],
  },
  {
    name: 'PROJECTION_DEFAULT',
    category: 'projection',
    description:
      'Applies a projection that the simple form cannot handle, such as computed fields or $slice.',
    metrics: ['nReturned', 'executionTimeMs'],
  },
  // Limits
  {
    name: 'LIMIT',
    category: 'limit',
    description: 'Stops the query after the given number of documents.',
    metrics: ['nReturned', 'executionTimeMs'],
  },
  {
    name: 'SKIP',
    category: 'limit',
    description: 'Discards the given number of documents before it returns any.',
    metrics: ['nReturned', 'executionTimeMs'],
  },
  // Express paths (8.0 and later)
  {
    name: 'EXPRESS_IXSCAN',
    category: 'express',
    description:
      'Fast path for an equality match on an index, which skips the general query planner.',
    metrics: ['keysExamined', 'docsExamined', 'nReturned', 'executionTimeMs', 'index'],
  },
  {
    name: 'EXPRESS_CLUSTERED_IXSCAN',
    category: 'express',
    description: 'Fast path for an equality match on the clustered key of a clustered collection.',
    metrics: ['keysExamined', 'docsExamined', 'nReturned', 'executionTimeMs'],
  },
  {
    name: 'EXPRESS_UPDATE',
    category: 'express',
    description: 'Fast path for an update that matches one document through an index.',
    metrics: ['docsExamined', 'nReturned', 'executionTimeMs'],
  },
  {
    name: 'EXPRESS_DELETE',
    category: 'express',
    description: 'Fast path for a delete that matches one document through an index.',
    metrics: ['docsExamined', 'nReturned', 'executionTimeMs'],
  },
  // Text and geo
  {
    name: 'TEXT',
    category: 'text',
    description: 'Runs a $text search through a text index.',
    metrics: ['nReturned', 'executionTimeMs', 'index'],
  },
  {
    name: 'TEXT_MATCH',
    category: 'text',
    description: 'Checks each fetched document against the terms of the $text search.',
    metrics: ['nReturned', 'docsExamined', 'executionTimeMs'],
  },
  {
    name: 'TEXT_OR',
    category: 'text',
    description: 'Combines the index results of each search term.',
    metrics: ['nReturned', 'keysExamined', 'executionTimeMs'],
  },
  {
    name: 'GEO_NEAR_2D',
    category: 'geo',
    description: 'Returns documents in order of distance from a point, using a legacy 2d index.',
    metrics: ['nReturned', 'keysExamined', 'docsExamined', 'executionTimeMs', 'index'],
  },
  {
    name: 'GEO_NEAR_2DSPHERE',
    category: 'geo',
    description:
      'Returns documents in order of distance from a point on the sphere, using a 2dsphere index.',
    metrics: ['nReturned', 'keysExamined', 'docsExamined', 'executionTimeMs', 'index'],
  },
  // Sharding
  {
    name: 'SHARDING_FILTER',
    category: 'sharding',
    description: 'Drops orphan documents on a shard, which belong to a chunk on another shard.',
    metrics: ['nReturned', 'docsExamined', 'chunkSkips', 'executionTimeMs'],
    advice: SHARD_FILTER_ADVICE,
  },
  {
    name: 'SHARD_MERGE',
    category: 'sharding',
    description: 'Merges the results of each shard in the order the shards return them.',
    metrics: ['nReturned', 'executionTimeMs'],
  },
  {
    name: 'SHARD_MERGE_SORT',
    category: 'sharding',
    description: 'Merges the sorted results of each shard into one sorted stream.',
    metrics: ['nReturned', 'executionTimeMs'],
  },
  // Lookups and unions
  {
    name: 'EQ_LOOKUP',
    category: 'lookup',
    description:
      'Joins each input document to the foreign collection on equal field values, through an index on the foreign field.',
    metrics: ['nReturned', 'docsExamined', 'keysExamined', 'executionTimeMs', 'index'],
    advice: LOOKUP_ADVICE,
  },
  {
    name: 'hash_lookup',
    category: 'lookup',
    description:
      'Joins the input to the foreign collection by building a hash table of the foreign documents.',
    metrics: ['nReturned', 'docsExamined', 'keysExamined', 'usedDisk', 'executionTimeMs'],
    advice: LOOKUP_ADVICE,
  },
  {
    name: 'nlj',
    category: 'lookup',
    description: 'Joins two inputs with a nested loop, reading the inner input once per outer row.',
    metrics: ['nReturned', 'docsExamined', 'keysExamined', 'executionTimeMs'],
  },
  {
    name: 'traverse',
    category: 'lookup',
    description: 'Walks each input row through a nested input, used for array and nested joins.',
    metrics: ['nReturned', 'executionTimeMs'],
  },
  {
    name: 'union',
    category: 'lookup',
    description: 'Concatenates the rows of several inputs into one stream.',
    metrics: ['nReturned', 'executionTimeMs'],
  },
  // Writes
  {
    name: 'UPDATE',
    category: 'write',
    description: 'Applies the update to each document the child stage matches.',
    metrics: ['nReturned', 'docsExamined', 'executionTimeMs', 'works'],
  },
  {
    name: 'DELETE',
    category: 'write',
    description: 'Deletes each document the child stage matches.',
    metrics: ['nReturned', 'docsExamined', 'executionTimeMs', 'works'],
  },
  {
    name: 'BATCHED_DELETE',
    category: 'write',
    description: 'Deletes the matched documents in batches, with the child stage as the source.',
    metrics: ['nReturned', 'docsExamined', 'executionTimeMs'],
  },
  // Timeseries
  {
    name: '$_internalUnpackBucket',
    category: 'scan',
    description:
      'Unpacks the buckets of a timeseries collection into the measurements the query reads.',
    metrics: ['nReturned', 'executionTimeMs'],
  },
  {
    name: '$_internalBoundedSort',
    category: 'sort',
    description: 'Sorts timeseries measurements by time, using the order of the buckets.',
    metrics: ['nReturned', 'executionTimeMs', 'memUsageBytes', 'usedDisk'],
  },
  // Aggregation stages
  {
    name: '$geoNearCursor',
    category: 'geo',
    description: 'Runs the query of a $geoNear stage, with its own plan shown below.',
    metrics: ['nReturned', 'executionTimeMs'],
  },
  {
    name: '$cursor',
    category: 'scan',
    description: 'Runs the first part of the pipeline as a query, with its own plan shown below.',
    metrics: ['nReturned', 'executionTimeMs'],
  },
  {
    name: '$match',
    category: 'filter',
    description: 'Keeps the documents that match the condition.',
    metrics: ['nReturned', 'executionTimeMs'],
    advice: MATCH_AFTER_BLOCKING_ADVICE,
  },
  {
    name: '$lookup',
    category: 'lookup',
    description:
      'Joins each input document with the documents of another collection, or with the result of an inner pipeline.',
    metrics: ['nReturned', 'docsExamined', 'keysExamined', 'executionTimeMs', 'index'],
    advice: LOOKUP_ADVICE,
  },
  {
    name: '$unionWith',
    category: 'lookup',
    description:
      'Appends the documents of another collection, or of an inner pipeline, to the stream.',
    metrics: ['nReturned', 'executionTimeMs'],
  },
  {
    name: '$graphLookup',
    category: 'lookup',
    description:
      'Follows links between documents of a collection, repeating the lookup for each level of the graph.',
    metrics: ['nReturned', 'docsExamined', 'executionTimeMs'],
    advice:
      'A graph lookup reads the collection once per level. Index the connectToField, and set maxDepth to stop the walk.',
  },
  {
    name: '$facet',
    category: 'group',
    description:
      'Runs several sub-pipelines on the same input and returns each result in one document.',
    metrics: ['nReturned', 'executionTimeMs'],
    advice:
      'Each branch of a $facet reads every document that reaches it. Put a $match before the $facet, and give each branch a $limit or a $match where the result allows.',
  },
  {
    name: '$group',
    category: 'group',
    description: 'Groups documents by a key and computes an accumulator for each group.',
    metrics: [
      'nReturned',
      'executionTimeMs',
      'memUsageBytes',
      'usedDisk',
      'spills',
      'spilledBytes',
    ],
    advice: GROUP_ADVICE,
  },
  {
    name: '$sortByCount',
    category: 'group',
    description: 'Groups documents by a key and sorts the groups by their count.',
    metrics: ['nReturned', 'executionTimeMs', 'usedDisk', 'spills'],
    advice: GROUP_ADVICE,
  },
  {
    name: '$count',
    category: 'group',
    description: 'Counts the documents that reach the stage and returns one document.',
    metrics: ['nReturned', 'executionTimeMs'],
  },
  {
    name: '$unwind',
    category: 'projection',
    description: 'Emits one document for each element of an array field.',
    metrics: ['nReturned', 'executionTimeMs'],
  },
  {
    name: '$project',
    category: 'projection',
    description: 'Keeps, drops or computes the fields of each document.',
    metrics: ['nReturned', 'executionTimeMs'],
  },
  {
    name: '$addFields',
    category: 'projection',
    description: 'Adds or replaces fields in each document and keeps the others.',
    metrics: ['nReturned', 'executionTimeMs'],
  },
  {
    name: '$sort',
    category: 'sort',
    description: 'Sorts the documents that reach the stage.',
    metrics: [
      'nReturned',
      'executionTimeMs',
      'memUsageBytes',
      'memLimitBytes',
      'usedDisk',
      'spills',
      'spilledBytes',
    ],
    advice: `${SORT_ADVICE} ${SPILL_ADVICE}`,
  },
  {
    name: '$limit',
    category: 'limit',
    description: 'Passes on the first given number of documents and stops the stream there.',
    metrics: ['nReturned', 'executionTimeMs'],
  },
  {
    name: '$skip',
    category: 'limit',
    description: 'Discards the given number of documents and passes on the rest.',
    metrics: ['nReturned', 'executionTimeMs'],
  },
  {
    name: '$sample',
    category: 'filter',
    description: 'Returns a random sample of the documents that reach the stage.',
    metrics: ['nReturned', 'executionTimeMs'],
  },
  {
    name: '$geoNear',
    category: 'geo',
    description: 'Returns documents in order of distance from a point, and adds the distance.',
    metrics: ['nReturned', 'docsExamined', 'keysExamined', 'executionTimeMs', 'index'],
    advice:
      'The $geoNear stage needs a geospatial index on the key field. It must be the first stage of the pipeline.',
  },
  {
    name: '$out',
    category: 'merge',
    description:
      'Writes the result to a collection, replacing it. Explain only shows the stage and does not write.',
    metrics: ['nReturned', 'executionTimeMs'],
    advice:
      'A real run of $out replaces the target collection. Check the target name before you run it.',
  },
  {
    name: '$merge',
    category: 'merge',
    description:
      'Writes the result into a collection, inserting, merging or replacing documents by key. Explain only shows the stage and does not write.',
    metrics: ['nReturned', 'executionTimeMs'],
    advice:
      'A real run of $merge changes the target collection. Check the target and the on field before you run it.',
  },
  // Slot-based engine names that are not covered above
  {
    name: 'scan',
    category: 'scan',
    description: 'Reads documents from the collection in the slot-based engine.',
    metrics: ['docsExamined', 'nReturned', 'executionTimeMs'],
    advice: SCAN_ADVICE,
  },
  {
    name: 'ixseek',
    category: 'scan',
    description: 'Reads index keys within the bounds in the slot-based engine.',
    metrics: ['keysExamined', 'nReturned', 'executionTimeMs', 'index'],
  },
  {
    name: 'seek',
    category: 'fetch',
    description:
      'Reads the document at the record id from the child stage in the slot-based engine.',
    metrics: ['docsExamined', 'nReturned', 'executionTimeMs'],
    advice: FETCH_ADVICE,
  },
  {
    name: 'coscan',
    category: 'scan',
    description: 'Produces one empty row, which the stages above it extend.',
    metrics: ['nReturned'],
  },
  {
    name: 'filter',
    category: 'filter',
    description: 'Keeps the rows that match the predicate in the slot-based engine.',
    metrics: ['nReturned', 'executionTimeMs'],
  },
  {
    name: 'cfilter',
    category: 'filter',
    description: 'Keeps the rows where the constant predicate holds, in the slot-based engine.',
    metrics: ['nReturned', 'executionTimeMs'],
  },
  {
    name: 'unique',
    category: 'filter',
    description: 'Drops rows whose key was already seen, in the slot-based engine.',
    metrics: ['nReturned', 'executionTimeMs'],
  },
  {
    name: 'branch',
    category: 'filter',
    description: 'Chooses one of two inputs for each row, in the slot-based engine.',
    metrics: ['nReturned', 'executionTimeMs'],
  },
  {
    name: 'project',
    category: 'projection',
    description: 'Computes or renames the fields of each row, in the slot-based engine.',
    metrics: ['nReturned', 'executionTimeMs'],
  },
  {
    name: 'mkobj',
    category: 'projection',
    description: 'Builds the output document from its fields, in the slot-based engine.',
    metrics: ['nReturned', 'executionTimeMs'],
  },
  {
    name: 'mkbson',
    category: 'projection',
    description: 'Builds the output BSON document from the row, in the slot-based engine.',
    metrics: ['nReturned', 'executionTimeMs'],
  },
  {
    name: 'unwind',
    category: 'projection',
    description: 'Emits one row for each element of an array, in the slot-based engine.',
    metrics: ['nReturned', 'executionTimeMs'],
  },
  {
    name: 'limit',
    category: 'limit',
    description: 'Stops the rows after the given number, in the slot-based engine.',
    metrics: ['nReturned', 'executionTimeMs'],
  },
  {
    name: 'skip',
    category: 'limit',
    description: 'Discards the given number of rows, in the slot-based engine.',
    metrics: ['nReturned', 'executionTimeMs'],
  },
  {
    name: 'sort',
    category: 'sort',
    description: 'Sorts the rows in the slot-based engine, in memory or on disk.',
    metrics: [
      'nReturned',
      'executionTimeMs',
      'memUsageBytes',
      'memLimitBytes',
      'usedDisk',
      'spills',
      'spilledBytes',
    ],
    advice: `${SORT_ADVICE} ${SPILL_ADVICE}`,
  },
  {
    name: 'group',
    category: 'group',
    description: 'Groups the rows by key in the slot-based engine, which may spill to disk.',
    metrics: [
      'nReturned',
      'executionTimeMs',
      'memUsageBytes',
      'usedDisk',
      'spills',
      'spilledBytes',
    ],
    advice: GROUP_ADVICE,
  },
  {
    name: 'GROUP',
    category: 'group',
    description: 'Groups documents by key in the query plan of a slot-based $group.',
    metrics: ['nReturned', 'executionTimeMs', 'usedDisk', 'spills', 'spilledBytes'],
    advice: GROUP_ADVICE,
  },
  {
    name: '$teeConsumer',
    category: 'projection',
    description: 'Feeds each document of a $facet input to one branch of the facet.',
    metrics: ['nReturned', 'executionTimeMs'],
  },
  {
    name: '$internalFacetTeeConsumer',
    category: 'projection',
    description: 'Feeds each document of a $facet input to one branch of the facet.',
    metrics: ['nReturned', 'executionTimeMs'],
  },
];

const BY_NAME: ReadonlyMap<string, StageInfo> = new Map(
  CATALOG.map((entry) => [entry.name, entry]),
);

// The catalogue entry for a stage name. A name that is not listed gets a generic unknown entry.
export function describeStage(name: string): StageInfo {
  return (
    BY_NAME.get(name) ?? {
      name,
      category: 'unknown',
      description: `The server reports a stage named ${name}, which this app does not describe yet.`,
      metrics: ['nReturned', 'executionTimeMs'],
    }
  );
}

// Every catalogue entry, in the order the catalogue lists them.
export function stageCatalog(): readonly StageInfo[] {
  return CATALOG;
}
