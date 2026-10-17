import {
  defaultDashboardLayout,
  findPanel,
  type DashboardLayout,
  type PanelSpec,
} from '@mongo-gui/core';
import { describe, expect, it } from 'vitest';
import {
  addPanel,
  readStoredLayout,
  movePanel,
  removePanel,
  resetLayout,
  setRowHeight,
  splitPanels,
  visibleRows,
} from './dashboard-state';

function panel(id: string): PanelSpec {
  const found = findPanel(id);
  if (found === undefined) {
    throw new Error(`missing panel ${id}`);
  }
  return found;
}

const TWO_PANELS: DashboardLayout = {
  version: 2,
  rows: [
    { h: 300, panels: [{ id: 'connections', f: 0.5 }, { id: 'network', f: 0.5 }] },
  ],
};

function sums(layout: DashboardLayout): number[] {
  return layout.rows.map((row) => row.panels.reduce((total, item) => total + item.f, 0));
}

describe('addPanel', () => {
  it('shares the last row equally while it has room', () => {
    const next = addPanel(TWO_PANELS, panel('memory'));
    expect(next.rows).toHaveLength(1);
    expect(next.rows[0]?.panels.map((item) => item.f)).toEqual([1 / 3, 1 / 3, 1 / 3]);
  });

  it('starts a new row when the last one has four panels', () => {
    let layout = TWO_PANELS;
    for (const id of ['memory', 'queues', 'asserts']) {
      layout = addPanel(layout, panel(id));
    }
    expect(layout.rows).toHaveLength(2);
    expect(layout.rows[1]?.panels).toEqual([{ id: 'asserts', f: 1 }]);
  });

  it('leaves a panel that is already there where it is', () => {
    expect(addPanel(TWO_PANELS, panel('network'))).toBe(TWO_PANELS);
  });
});

describe('removePanel', () => {
  it('gives the freed width to the others and drops an emptied row', () => {
    const next = removePanel(TWO_PANELS, 'connections');
    expect(next.rows[0]?.panels).toEqual([{ id: 'network', f: 1 }]);
    expect(removePanel(next, 'network').rows).toEqual([]);
  });

  it('leaves the layout alone for an unknown id', () => {
    expect(removePanel(TWO_PANELS, 'missing')).toBe(TWO_PANELS);
  });
});

describe('movePanel', () => {
  const three: DashboardLayout = {
    version: 2,
    rows: [
      { h: 300, panels: [{ id: 'a', f: 0.5 }, { id: 'b', f: 0.5 }] },
      { h: 200, panels: [{ id: 'c', f: 1 }] },
    ],
  };

  it('inserts beside a panel and keeps every row at full width', () => {
    const next = movePanel(three, 'c', 'a', 'right');
    expect(next.rows.map((row) => row.panels.map((item) => item.id))).toEqual([['a', 'c', 'b']]);
    expect(sums(next).every((sum) => Math.abs(sum - 1) < 1e-9)).toBe(true);
  });

  it('makes a new row above or below, with the source row height, and drops the emptied row', () => {
    const next = movePanel(three, 'a', 'c', 'below');
    expect(next.rows.map((row) => row.panels.map((item) => item.id))).toEqual([['b'], ['c'], ['a']]);
    expect(next.rows[0]?.panels[0]?.f).toBe(1);
    expect(next.rows[2]?.h).toBe(300);
  });

  it('does nothing when the ids are unknown or the same', () => {
    expect(movePanel(three, 'a', 'a', 'left')).toBe(three);
    expect(movePanel(three, 'x', 'a', 'left')).toBe(three);
  });
});

describe('splitPanels and setRowHeight', () => {
  it('moves one boundary and leaves the other panels alone', () => {
    const layout: DashboardLayout = {
      version: 2,
      rows: [{ h: 300, panels: [{ id: 'a', f: 0.25 }, { id: 'b', f: 0.25 }, { id: 'c', f: 0.5 }] }],
    };
    const next = splitPanels(layout, 'a', 'b', 0.8);
    next.rows[0]?.panels.forEach((item, index) => expect(item.f).toBeCloseTo([0.4, 0.1, 0.5][index] ?? 0));
  });

  it('sets a row height with a floor', () => {
    expect(setRowHeight(TWO_PANELS, 0, 500).rows[0]?.h).toBe(500);
    expect(setRowHeight(TWO_PANELS, 0, 10).rows[0]?.h).toBe(140);
  });
});

describe('resetLayout', () => {
  it('returns the default panels', () => {
    expect(resetLayout()).toEqual(defaultDashboardLayout());
  });
});

describe('readStoredLayout', () => {
  it('reads a valid stored layout', () => {
    expect(readStoredLayout(TWO_PANELS)).toEqual({ state: 'valid', layout: TWO_PANELS });
  });

  it('treats a null or missing value as nothing stored, not as an error', () => {
    expect(readStoredLayout(null)).toEqual({ state: 'missing' });
    expect(readStoredLayout(undefined)).toEqual({ state: 'missing' });
  });

  it('rejects a wrong version and an out-of-range width', () => {
    expect(readStoredLayout({ version: 3, rows: [] }).state).toBe('invalid');
    expect(readStoredLayout({ version: 1, panels: [{ id: 'a', w: 4, h: 1 }] }).state).toBe(
      'invalid',
    );
  });

  it('summarises the failing paths without the stored value', () => {
    const secret = 'sensitive-panel-id-value';
    const stored = readStoredLayout({ version: 1, panels: [{ id: secret, w: 4, h: 1 }] });
    expect(stored.state).toBe('invalid');
    if (stored.state === 'invalid') {
      expect(stored.summary).toContain('version');
      expect(stored.summary).not.toContain(secret);
    }
  });

  it('rejects a layout that places a panel twice', () => {
    const duplicated = {
      version: 2,
      rows: [{ h: 300, panels: [{ id: 'network', f: 0.5 }, { id: 'network', f: 0.5 }] }],
    };
    expect(readStoredLayout(duplicated).state).toBe('invalid');
  });
});

describe('visibleRows', () => {
  const layout: DashboardLayout = {
    version: 2,
    rows: [
      { h: 300, panels: [{ id: 'wt-cache', f: 0.5 }, { id: 'network', f: 0.25 }, { id: 'replication-lag', f: 0.25 }] },
    ],
  };

  it('hides panels whose requirement the connection lacks and refills the row width', () => {
    const standalone = visibleRows(layout, { wiredTiger: false, replicaSet: false });
    expect(standalone[0]?.panels.map((item) => [item.id, item.f])).toEqual([['network', 1]]);
    const replica = visibleRows(layout, { wiredTiger: true, replicaSet: true });
    expect(replica[0]?.panels.map((item) => item.id)).toEqual(['wt-cache', 'network', 'replication-lag']);
    const unknown = visibleRows(layout, { wiredTiger: undefined, replicaSet: undefined });
    expect(unknown[0]?.panels).toHaveLength(3);
  });

  it('skips panel ids the catalogue does not have, and rows left empty', () => {
    const retired: DashboardLayout = { version: 2, rows: [{ h: 300, panels: [{ id: 'retired', f: 1 }] }] };
    expect(visibleRows(retired, { wiredTiger: true, replicaSet: true })).toEqual([]);
  });
});
