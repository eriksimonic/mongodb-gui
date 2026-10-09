import { describe, expect, it } from 'vitest';
import {
  CATALOG_SERIES,
  PANEL_CATALOG,
  PANEL_CATEGORIES,
  REQUIREMENT_LABELS,
  findPanel,
  findSeries,
  serverStatusSections,
  unmetRequirement,
  type PanelSpec,
} from './catalog';
import {
  DEFAULT_DASHBOARD_PANELS,
  defaultDashboardLayout,
  DashboardLayoutSchema,
} from './dashboard-layout';

const CATEGORY_IDS = new Set<string>(PANEL_CATEGORIES.map((category) => category.id));

function idsOf(items: readonly { readonly id: string }[]): string[] {
  return items.map((item) => item.id);
}

describe('PANEL_CATALOG', () => {
  it('has unique panel ids and unique series ids', () => {
    const panelIds = idsOf(PANEL_CATALOG);
    expect(new Set(panelIds).size).toBe(panelIds.length);
    const seriesIds = idsOf(CATALOG_SERIES);
    expect(new Set(seriesIds).size).toBe(seriesIds.length);
  });

  it('gives every series a non-empty path made of non-empty segments', () => {
    for (const series of CATALOG_SERIES) {
      expect(series.path.length, series.id).toBeGreaterThan(0);
      for (const segment of series.path) {
        expect(segment.length, `${series.id} segment`).toBeGreaterThan(0);
      }
    }
  });

  it('uses only known categories and gives every panel a title, description and series', () => {
    for (const panel of PANEL_CATALOG) {
      expect(CATEGORY_IDS.has(panel.category), panel.id).toBe(true);
      expect(panel.title.length, panel.id).toBeGreaterThan(0);
      expect(panel.description.length, panel.id).toBeGreaterThan(0);
      expect(panel.series.length, panel.id).toBeGreaterThan(0);
    }
  });

  it('keeps descriptions to one sentence without exclamation marks', () => {
    for (const panel of PANEL_CATALOG) {
      expect(panel.description, panel.id).toMatch(/\.$/);
      expect(panel.description.match(/[.!?]/g)?.length, panel.id).toBe(1);
      expect(panel.description).not.toContain('!');
    }
  });

  it('gives every category at least one panel', () => {
    for (const category of PANEL_CATEGORIES) {
      expect(
        PANEL_CATALOG.some((panel) => panel.category === category.id),
        category.id,
      ).toBe(true);
    }
  });

  it('sets requires on the WiredTiger and replica set panels', () => {
    const wiredTigerPanels = PANEL_CATALOG.filter((panel) =>
      panel.series.some(
        (series) => series.path[0] === 'wiredTiger' || series.path[0] === 'tickets',
      ),
    );
    expect(wiredTigerPanels.length).toBeGreaterThan(0);
    for (const panel of wiredTigerPanels) {
      expect(panel.requires, panel.id).toBe('wiredTiger');
    }
    const replicaPanels = PANEL_CATALOG.filter((panel) =>
      panel.series.some((series) => series.path[0] === 'repl' || series.path[0] === 'oplog'),
    );
    expect(replicaPanels.map((panel) => panel.id).sort()).toEqual(
      ['oplog-window', 'replication-lag'].sort(),
    );
    for (const panel of replicaPanels) {
      expect(panel.requires, panel.id).toBe('replicaSet');
    }
  });

  it('covers the required panels for each category listed in the brief', () => {
    const ids = new Set(idsOf(PANEL_CATALOG));
    for (const id of [
      'operations-by-type',
      'documents',
      'connections',
      'network',
      'network-requests',
      'memory',
      'wt-cache',
      'wt-checkpoints',
      'wt-checkpoint-duration',
      'tickets',
      'block-io',
      'lock-acquires',
      'deadlocks',
      'queues',
      'transactions-open',
      'transactions-rate',
      'cursors',
      'logical-sessions',
      'ttl',
      'replication-lag',
      'repl-apply',
      'asserts',
      'page-faults',
    ]) {
      expect(ids.has(id), id).toBe(true);
    }
  });

  it('covers the series the brief names', () => {
    for (const id of [
      'op-insert',
      'doc-inserted',
      'net-in',
      'net-out',
      'net-requests',
      'net-physical-in',
      'mem-resident',
      'mem-virtual',
      'wt-cache-used',
      'wt-cache-dirty',
      'wt-cache-max',
      'wt-pages-read',
      'wt-pages-written',
      'wt-checkpoints',
      'wt-checkpoint-ms',
      'tickets-read-available',
      'tickets-write-out',
      'bm-read',
      'bm-written',
      'lock-global-r',
      'lock-global-w',
      'lock-global-R',
      'lock-global-W',
      'deadlocks',
      'tx-active',
      'tx-open',
      'tx-started',
      'cursor-open',
      'cursor-no-timeout',
      'cursor-pinned',
      'cursor-timed-out',
      'sessions-active',
      'ttl-passes',
      'ttl-deleted',
      'repl-lag',
      'oplog-window',
      'repl-apply-batches',
      'repl-apply-ops',
      'assert-regular',
      'assert-warning',
      'assert-msg',
      'assert-user',
      'page-faults',
    ]) {
      expect(findSeries(id), id).toBeDefined();
    }
  });

  it('gives the memory series bytes and the rate series per-second units', () => {
    expect(findSeries('mem-resident')?.unit).toBe('bytes');
    expect(findSeries('op-insert')?.unit).toBe('per-second');
    expect(findSeries('net-in')?.unit).toBe('bytes-per-second');
  });
});

describe('unmetRequirement', () => {
  const wiredTigerPanel = findPanel('wt-cache');
  const replicaPanel = findPanel('replication-lag');

  function panel(value: PanelSpec | undefined): PanelSpec {
    if (value === undefined) {
      throw new Error('missing panel in the catalogue');
    }
    return value;
  }

  it('reports the requirement a connection lacks', () => {
    const none = { wiredTiger: false, replicaSet: false };
    expect(unmetRequirement(panel(wiredTigerPanel), none)).toBe('wiredTiger');
    expect(unmetRequirement(panel(replicaPanel), none)).toBe('replicaSet');
  });

  it('treats an unknown capability as met, and a panel without requires as always met', () => {
    const unknown = { wiredTiger: undefined, replicaSet: undefined };
    expect(unmetRequirement(panel(wiredTigerPanel), unknown)).toBeUndefined();
    expect(unmetRequirement(panel(replicaPanel), unknown)).toBeUndefined();
    expect(
      unmetRequirement(panel(findPanel('connections')), { wiredTiger: false, replicaSet: false }),
    ).toBeUndefined();
  });

  it('has a reason for every requirement', () => {
    expect(REQUIREMENT_LABELS.wiredTiger).toMatch(/WiredTiger/);
    expect(REQUIREMENT_LABELS.replicaSet).toMatch(/replica set/);
  });
});

describe('serverStatusSections', () => {
  it('lists every real section the catalogue reads, sorted and without virtual sources', () => {
    const sections = serverStatusSections();
    expect(sections).toEqual([...sections].sort());
    for (const section of [
      'wiredTiger',
      'metrics',
      'network',
      'mem',
      'locks',
      'transactions',
      'opcounters',
      'asserts',
      'extra_info',
      'globalLock',
      'connections',
      'logicalSessionRecordCache',
      'queues',
    ]) {
      expect(sections, section).toContain(section);
    }
    expect(sections).not.toContain('tickets');
    expect(sections).not.toContain('repl');
    expect(sections).not.toContain('oplog');
  });

  it('reads the queues section for the tickets source', () => {
    const tickets = [findSeries('tickets-read-available')].flatMap((spec) => (spec ? [spec] : []));
    expect(serverStatusSections(tickets)).toEqual(['queues', 'wiredTiger']);
  });
});

describe('default dashboard layout', () => {
  it('names only catalogue panels, each once, with the six default cards', () => {
    expect(DEFAULT_DASHBOARD_PANELS.map((panel) => panel.id)).toEqual([
      'operations-by-type',
      'connections',
      'network',
      'memory',
      'queues',
      'replication-lag',
    ]);
    for (const panel of DEFAULT_DASHBOARD_PANELS) {
      expect(findPanel(panel.id), panel.id).toBeDefined();
    }
    expect(DashboardLayoutSchema.safeParse(defaultDashboardLayout()).success).toBe(true);
  });
});
