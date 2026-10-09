/**
 * The panels a monitoring dashboard can show. The sampler reads every serverStatus section these
 * series reference, and the dashboard draws each panel from the series it lists.
 *
 * A series path is either a serverStatus path or a virtual source. Virtual sources are resolved in
 * derive.ts from data the sampler already holds: `tickets` (the 7.0+ queues or the older
 * concurrentTransactions location), `wiredTiger` checkpoint counters that moved between versions,
 * `repl` member lag (a `*` segment expands to one series per member), and `oplog` window.
 */

export type SeriesKind = 'counter' | 'gauge';

export type SeriesUnit =
  'count' | 'per-second' | 'bytes' | 'bytes-per-second' | 'ms' | 'percent' | 'seconds';

export interface SeriesSpec {
  readonly id: string;
  readonly path: readonly string[];
  readonly kind: SeriesKind;
  readonly unit: SeriesUnit;
  readonly label: string;
}

export const PANEL_CATEGORIES = [
  { id: 'operations', label: 'Operations' },
  { id: 'documents', label: 'Documents' },
  { id: 'memory-and-cache', label: 'Memory and cache' },
  { id: 'wiredtiger', label: 'WiredTiger' },
  { id: 'io-and-network', label: 'IO and network' },
  { id: 'locks-and-tickets', label: 'Locks and tickets' },
  { id: 'transactions', label: 'Transactions' },
  { id: 'sessions-and-cursors', label: 'Sessions and cursors' },
  { id: 'replication', label: 'Replication' },
  { id: 'errors', label: 'Errors' },
] as const;

export type PanelCategory = (typeof PANEL_CATEGORIES)[number]['id'];

export type PanelChart = 'lines' | 'stacked' | 'area' | 'stat';

/** A server feature a panel needs. The dashboard disables the panel when the connection lacks it. */
export type PanelRequirement = 'wiredTiger' | 'replicaSet';

export interface PanelSpec {
  readonly id: string;
  readonly title: string;
  readonly category: PanelCategory;
  readonly chart: PanelChart;
  readonly series: readonly SeriesSpec[];
  readonly description: string;
  readonly requires?: PanelRequirement;
}

/** What the connected server offers. Undefined means not known yet, which never disables a panel. */
export interface ServerCapabilities {
  readonly wiredTiger: boolean | undefined;
  readonly replicaSet: boolean | undefined;
}

export const REPLICA_MEMBER_SEGMENT = '*';

const counter = (
  id: string,
  path: readonly string[],
  unit: SeriesUnit,
  label: string,
): SeriesSpec => ({ id, path, kind: 'counter', unit, label });

const gauge = (
  id: string,
  path: readonly string[],
  unit: SeriesUnit,
  label: string,
): SeriesSpec => ({ id, path, kind: 'gauge', unit, label });

export const PANEL_CATALOG: readonly PanelSpec[] = [
  {
    id: 'operations-by-type',
    title: 'Operations by type',
    category: 'operations',
    chart: 'stacked',
    description: 'Commands the server ran per second, split by type.',
    series: [
      counter('op-insert', ['opcounters', 'insert'], 'per-second', 'Insert'),
      counter('op-query', ['opcounters', 'query'], 'per-second', 'Query'),
      counter('op-update', ['opcounters', 'update'], 'per-second', 'Update'),
      counter('op-delete', ['opcounters', 'delete'], 'per-second', 'Delete'),
      counter('op-getmore', ['opcounters', 'getmore'], 'per-second', 'Get more'),
      counter('op-command', ['opcounters', 'command'], 'per-second', 'Command'),
    ],
  },
  {
    id: 'connections',
    title: 'Connections',
    category: 'operations',
    chart: 'lines',
    description: 'Open client connections and how many of them are active.',
    series: [
      gauge('conn-current', ['connections', 'current'], 'count', 'Current'),
      gauge('conn-active', ['connections', 'active'], 'count', 'Active'),
    ],
  },
  {
    id: 'connections-available',
    title: 'Available connections',
    category: 'operations',
    chart: 'stat',
    description: 'Connections the server can still accept before it reaches its limit.',
    series: [gauge('conn-available', ['connections', 'available'], 'count', 'Available')],
  },
  {
    id: 'documents',
    title: 'Document operations',
    category: 'documents',
    chart: 'lines',
    description: 'Documents inserted, updated, deleted and returned per second.',
    series: [
      counter('doc-inserted', ['metrics', 'document', 'inserted'], 'per-second', 'Inserted'),
      counter('doc-updated', ['metrics', 'document', 'updated'], 'per-second', 'Updated'),
      counter('doc-deleted', ['metrics', 'document', 'deleted'], 'per-second', 'Deleted'),
      counter('doc-returned', ['metrics', 'document', 'returned'], 'per-second', 'Returned'),
    ],
  },
  {
    id: 'ttl',
    title: 'TTL monitor',
    category: 'documents',
    chart: 'lines',
    description: 'Passes the TTL monitor made per second, and the documents it deleted.',
    series: [
      counter('ttl-passes', ['metrics', 'ttl', 'passes'], 'per-second', 'Passes'),
      counter('ttl-deleted', ['metrics', 'ttl', 'deletedDocuments'], 'per-second', 'Deleted'),
    ],
  },
  {
    id: 'memory',
    title: 'Memory',
    category: 'memory-and-cache',
    chart: 'lines',
    description: 'Resident and virtual memory of the server process.',
    series: [
      gauge('mem-resident', ['mem', 'resident'], 'bytes', 'Resident'),
      gauge('mem-virtual', ['mem', 'virtual'], 'bytes', 'Virtual'),
    ],
  },
  {
    id: 'page-faults',
    title: 'Page faults',
    category: 'memory-and-cache',
    chart: 'area',
    description: 'Page faults per second, which rise when the server reads data from disk.',
    series: [counter('page-faults', ['extra_info', 'page_faults'], 'per-second', 'Page faults')],
  },
  {
    id: 'wt-cache',
    title: 'WiredTiger cache',
    category: 'memory-and-cache',
    chart: 'lines',
    requires: 'wiredTiger',
    description: 'Bytes in the WiredTiger cache, the dirty part of it, and the configured maximum.',
    series: [
      gauge(
        'wt-cache-used',
        ['wiredTiger', 'cache', 'bytes currently in the cache'],
        'bytes',
        'Used',
      ),
      gauge(
        'wt-cache-dirty',
        ['wiredTiger', 'cache', 'tracked dirty bytes in the cache'],
        'bytes',
        'Dirty',
      ),
      gauge(
        'wt-cache-max',
        ['wiredTiger', 'cache', 'maximum bytes configured'],
        'bytes',
        'Maximum',
      ),
    ],
  },
  {
    id: 'wt-cache-fill',
    title: 'Cache fill',
    category: 'memory-and-cache',
    chart: 'stat',
    requires: 'wiredTiger',
    description: 'Share of the configured WiredTiger cache that holds data.',
    series: [gauge('wt-cache-fill', ['wiredTiger', 'fillPercent'], 'percent', 'Cache fill')],
  },
  {
    id: 'wt-cache-traffic',
    title: 'Cache traffic',
    category: 'memory-and-cache',
    chart: 'lines',
    requires: 'wiredTiger',
    description: 'Bytes read into the WiredTiger cache and written out of it per second.',
    series: [
      counter(
        'wt-bytes-read-in',
        ['wiredTiger', 'cache', 'bytes read into cache'],
        'bytes-per-second',
        'Read into cache',
      ),
      counter(
        'wt-bytes-written-out',
        ['wiredTiger', 'cache', 'bytes written from cache'],
        'bytes-per-second',
        'Written from cache',
      ),
    ],
  },
  {
    id: 'wt-pages',
    title: 'Pages in and out of cache',
    category: 'wiredtiger',
    chart: 'lines',
    requires: 'wiredTiger',
    description: 'Pages read into the cache and written from it per second, including eviction.',
    series: [
      counter(
        'wt-pages-read',
        ['wiredTiger', 'cache', 'pages read into cache'],
        'per-second',
        'Read into cache',
      ),
      counter(
        'wt-pages-written',
        ['wiredTiger', 'cache', 'pages written from cache'],
        'per-second',
        'Written from cache',
      ),
    ],
  },
  {
    id: 'wt-checkpoints',
    title: 'Checkpoints',
    category: 'wiredtiger',
    chart: 'lines',
    requires: 'wiredTiger',
    description: 'Checkpoints WiredTiger completed per second.',
    series: [counter('wt-checkpoints', ['wiredTiger', 'checkpoints'], 'per-second', 'Checkpoints')],
  },
  {
    id: 'wt-checkpoint-duration',
    title: 'Last checkpoint',
    category: 'wiredtiger',
    chart: 'stat',
    requires: 'wiredTiger',
    description: 'Duration of the most recent WiredTiger checkpoint.',
    series: [gauge('wt-checkpoint-ms', ['wiredTiger', 'checkpointMs'], 'ms', 'Most recent')],
  },
  {
    id: 'block-io',
    title: 'Block manager IO',
    category: 'io-and-network',
    chart: 'lines',
    requires: 'wiredTiger',
    description: 'Bytes the WiredTiger block manager read from and wrote to disk per second.',
    series: [
      counter('bm-read', ['wiredTiger', 'block-manager', 'bytes read'], 'bytes-per-second', 'Read'),
      counter(
        'bm-written',
        ['wiredTiger', 'block-manager', 'bytes written'],
        'bytes-per-second',
        'Written',
      ),
    ],
  },
  {
    id: 'network',
    title: 'Network',
    category: 'io-and-network',
    chart: 'lines',
    description: 'Bytes received from and sent to clients per second.',
    series: [
      counter('net-in', ['network', 'bytesIn'], 'bytes-per-second', 'Bytes in'),
      counter('net-out', ['network', 'bytesOut'], 'bytes-per-second', 'Bytes out'),
    ],
  },
  {
    id: 'network-requests',
    title: 'Requests',
    category: 'io-and-network',
    chart: 'area',
    description: 'Client requests the server received per second.',
    series: [counter('net-requests', ['network', 'numRequests'], 'per-second', 'Requests')],
  },
  {
    id: 'network-physical',
    title: 'Physical network bytes',
    category: 'io-and-network',
    chart: 'lines',
    description:
      'Bytes on the wire per second where the server reports them, which differ from logical bytes when wire compression is on.',
    series: [
      counter('net-physical-in', ['network', 'physicalBytesIn'], 'bytes-per-second', 'Physical in'),
      counter(
        'net-physical-out',
        ['network', 'physicalBytesOut'],
        'bytes-per-second',
        'Physical out',
      ),
    ],
  },
  {
    id: 'tickets',
    title: 'Read and write tickets',
    category: 'locks-and-tickets',
    chart: 'lines',
    requires: 'wiredTiger',
    description:
      'Tickets free and in use for reads and writes, where no free ticket means operations wait.',
    series: [
      gauge('tickets-read-available', ['tickets', 'read', 'available'], 'count', 'Read free'),
      gauge('tickets-read-out', ['tickets', 'read', 'out'], 'count', 'Read in use'),
      gauge('tickets-write-available', ['tickets', 'write', 'available'], 'count', 'Write free'),
      gauge('tickets-write-out', ['tickets', 'write', 'out'], 'count', 'Write in use'),
    ],
  },
  {
    id: 'lock-acquires',
    title: 'Lock acquisitions',
    category: 'locks-and-tickets',
    chart: 'lines',
    description: 'Global lock acquisitions per second, by mode.',
    series: [
      counter(
        'lock-global-r',
        ['locks', 'Global', 'acquireCount', 'r'],
        'per-second',
        'Intent shared (r)',
      ),
      counter(
        'lock-global-w',
        ['locks', 'Global', 'acquireCount', 'w'],
        'per-second',
        'Intent exclusive (w)',
      ),
      counter(
        'lock-global-R',
        ['locks', 'Global', 'acquireCount', 'R'],
        'per-second',
        'Shared (R)',
      ),
      counter(
        'lock-global-W',
        ['locks', 'Global', 'acquireCount', 'W'],
        'per-second',
        'Exclusive (W)',
      ),
    ],
  },
  {
    id: 'queues',
    title: 'Queued operations',
    category: 'locks-and-tickets',
    chart: 'lines',
    description: 'Operations waiting for the global lock, split into readers and writers.',
    series: [
      gauge('queue-readers', ['globalLock', 'currentQueue', 'readers'], 'count', 'Queued readers'),
      gauge('queue-writers', ['globalLock', 'currentQueue', 'writers'], 'count', 'Queued writers'),
    ],
  },
  {
    id: 'transactions-open',
    title: 'Open transactions',
    category: 'transactions',
    chart: 'lines',
    description: 'Multi-document transactions that are running, idle or open right now.',
    series: [
      gauge('tx-active', ['transactions', 'currentActive'], 'count', 'Active'),
      gauge('tx-inactive', ['transactions', 'currentInactive'], 'count', 'Inactive'),
      gauge('tx-open', ['transactions', 'currentOpen'], 'count', 'Open'),
    ],
  },
  {
    id: 'transactions-rate',
    title: 'Transactions per second',
    category: 'transactions',
    chart: 'lines',
    description: 'Transactions started, committed and aborted per second.',
    series: [
      counter('tx-started', ['transactions', 'totalStarted'], 'per-second', 'Started'),
      counter('tx-committed', ['transactions', 'totalCommitted'], 'per-second', 'Committed'),
      counter('tx-aborted', ['transactions', 'totalAborted'], 'per-second', 'Aborted'),
    ],
  },
  {
    id: 'cursors',
    title: 'Open cursors',
    category: 'sessions-and-cursors',
    chart: 'lines',
    description:
      'Cursors the server holds open, with the ones that never time out and the pinned ones.',
    series: [
      gauge('cursor-open', ['metrics', 'cursor', 'open', 'total'], 'count', 'Open'),
      gauge('cursor-no-timeout', ['metrics', 'cursor', 'open', 'noTimeout'], 'count', 'No timeout'),
      gauge('cursor-pinned', ['metrics', 'cursor', 'open', 'pinned'], 'count', 'Pinned'),
    ],
  },
  {
    id: 'cursor-timeouts',
    title: 'Cursor timeouts',
    category: 'sessions-and-cursors',
    chart: 'area',
    description: 'Cursors that the server closed after they were idle too long, per second.',
    series: [
      counter('cursor-timed-out', ['metrics', 'cursor', 'timedOut'], 'per-second', 'Timed out'),
    ],
  },
  {
    id: 'logical-sessions',
    title: 'Logical sessions',
    category: 'sessions-and-cursors',
    chart: 'stat',
    description: 'Logical sessions the server currently tracks as active.',
    series: [
      gauge(
        'sessions-active',
        ['logicalSessionRecordCache', 'activeSessionsCount'],
        'count',
        'Active sessions',
      ),
    ],
  },
  {
    id: 'replication-lag',
    title: 'Replication lag',
    category: 'replication',
    chart: 'lines',
    requires: 'replicaSet',
    description: 'Seconds each secondary is behind the primary.',
    series: [gauge('repl-lag', ['repl', 'lag', REPLICA_MEMBER_SEGMENT], 'seconds', 'Lag')],
  },
  {
    id: 'oplog-window',
    title: 'Oplog window',
    category: 'replication',
    chart: 'stat',
    requires: 'replicaSet',
    description: 'Time between the oldest and the newest entry in the oplog.',
    series: [gauge('oplog-window', ['oplog', 'windowSeconds'], 'seconds', 'Oplog window')],
  },
  {
    id: 'repl-apply',
    title: 'Replication apply',
    category: 'replication',
    chart: 'lines',
    requires: 'replicaSet',
    description: 'Oplog batches and operations a secondary applied per second.',
    series: [
      counter(
        'repl-apply-batches',
        ['metrics', 'repl', 'apply', 'batches', 'num'],
        'per-second',
        'Batches',
      ),
      counter('repl-apply-ops', ['metrics', 'repl', 'apply', 'ops'], 'per-second', 'Operations'),
    ],
  },
  {
    id: 'asserts',
    title: 'Assertions',
    category: 'errors',
    chart: 'lines',
    description: 'Assertions the server raised per second, by kind.',
    series: [
      counter('assert-regular', ['asserts', 'regular'], 'per-second', 'Regular'),
      counter('assert-warning', ['asserts', 'warning'], 'per-second', 'Warning'),
      counter('assert-msg', ['asserts', 'msg'], 'per-second', 'Message'),
      counter('assert-user', ['asserts', 'user'], 'per-second', 'User'),
    ],
  },
  {
    id: 'deadlocks',
    title: 'Deadlocks',
    category: 'errors',
    chart: 'lines',
    description: 'Deadlocks the server detected per second, shown once the first deadlock happens.',
    series: [counter('deadlocks', ['locks', 'deadlockCount'], 'per-second', 'Deadlocks')],
  },
];

/** Every series in the catalogue, in panel order. */
export const CATALOG_SERIES: readonly SeriesSpec[] = PANEL_CATALOG.flatMap((panel) => panel.series);

export function findPanel(id: string): PanelSpec | undefined {
  return PANEL_CATALOG.find((panel) => panel.id === id);
}

export function findSeries(id: string): SeriesSpec | undefined {
  return CATALOG_SERIES.find((series) => series.id === id);
}

/** The requirement a connection does not meet, or undefined when the panel can run there. */
export function unmetRequirement(
  panel: PanelSpec,
  capabilities: ServerCapabilities,
): PanelRequirement | undefined {
  if (panel.requires === undefined) {
    return undefined;
  }
  if (panel.requires === 'wiredTiger' && capabilities.wiredTiger === false) {
    return 'wiredTiger';
  }
  if (panel.requires === 'replicaSet' && capabilities.replicaSet === false) {
    return 'replicaSet';
  }
  return undefined;
}

export const REQUIREMENT_LABELS: Readonly<Record<PanelRequirement, string>> = {
  wiredTiger: 'Needs the WiredTiger storage engine',
  replicaSet: 'Needs a replica set',
};

/** Virtual sources that read serverStatus sections other than their own first segment. */
const VIRTUAL_SECTION_NEEDS: ReadonlyMap<string, readonly string[]> = new Map([
  ['tickets', ['wiredTiger', 'queues']],
]);
/** Virtual sources that do not read any serverStatus section. */
const NON_SECTION_SOURCES: ReadonlySet<string> = new Set(['repl', 'oplog']);

/**
 * The serverStatus top-level sections the catalogue reads, sorted. Virtual sources add the
 * sections they resolve from, so a tickets series also reads `queues` on 7.0 and later.
 */
export function serverStatusSections(series: readonly SeriesSpec[] = CATALOG_SERIES): string[] {
  const sections = new Set<string>();
  for (const spec of series) {
    const first = spec.path[0];
    if (first === undefined || NON_SECTION_SOURCES.has(first)) {
      continue;
    }
    const needs = VIRTUAL_SECTION_NEEDS.get(first);
    if (needs !== undefined) {
      for (const section of needs) {
        sections.add(section);
      }
      continue;
    }
    sections.add(first);
  }
  return [...sections].sort();
}
