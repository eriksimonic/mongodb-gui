import {
  defaultDashboardLayout,
  findPanel,
  type DashboardLayout,
  type PanelSpec,
} from '@mongo-gui/core';
import { describe, expect, it } from 'vitest';
import {
  addPanel,
  defaultWidthFor,
  readStoredLayout,
  movePanel,
  removePanel,
  resetLayout,
  resizePanel,
  visiblePanels,
} from './dashboard-state';

function panel(id: string): PanelSpec {
  const found = findPanel(id);
  if (found === undefined) {
    throw new Error(`missing panel ${id}`);
  }
  return found;
}

function idsOf(layout: DashboardLayout): string[] {
  return layout.panels.map((item) => item.id);
}

const TWO_PANELS: DashboardLayout = {
  version: 1,
  panels: [
    { id: 'connections', w: 1, h: 1 },
    { id: 'network', w: 2, h: 1 },
  ],
};

describe('addPanel', () => {
  it('appends a panel at the end with its default size', () => {
    const next = addPanel(TWO_PANELS, panel('memory'));
    expect(next.panels.at(-1)).toEqual({ id: 'memory', w: 1, h: 1 });
    expect(idsOf(next)).toEqual(['connections', 'network', 'memory']);
  });

  it('gives a stacked panel two columns', () => {
    expect(defaultWidthFor(panel('operations-by-type'))).toBe(2);
    expect(addPanel(TWO_PANELS, panel('operations-by-type')).panels.at(-1)?.w).toBe(2);
  });

  it('leaves a panel that is already there where it is', () => {
    expect(addPanel(TWO_PANELS, panel('network'))).toBe(TWO_PANELS);
  });
});

describe('removePanel', () => {
  it('drops the panel and keeps the others in order', () => {
    expect(idsOf(removePanel(TWO_PANELS, 'connections'))).toEqual(['network']);
  });

  it('leaves the layout alone for an unknown id', () => {
    expect(idsOf(removePanel(TWO_PANELS, 'missing'))).toEqual(['connections', 'network']);
  });
});

describe('movePanel', () => {
  it('moves a panel to the position of the target', () => {
    const three: DashboardLayout = {
      version: 1,
      panels: [
        { id: 'a', w: 1, h: 1 },
        { id: 'b', w: 1, h: 1 },
        { id: 'c', w: 1, h: 1 },
      ],
    };
    expect(idsOf(movePanel(three, 'c', 'a'))).toEqual(['c', 'a', 'b']);
    expect(idsOf(movePanel(three, 'a', 'c'))).toEqual(['b', 'c', 'a']);
  });

  it('keeps the size of a moved panel', () => {
    const moved = movePanel(TWO_PANELS, 'network', 'connections');
    expect(moved.panels[0]).toEqual({ id: 'network', w: 2, h: 1 });
  });

  it('does nothing when the ids are unknown or the same', () => {
    expect(movePanel(TWO_PANELS, 'network', 'network')).toBe(TWO_PANELS);
    expect(movePanel(TWO_PANELS, 'missing', 'network')).toBe(TWO_PANELS);
  });
});

describe('resizePanel', () => {
  it('changes only the width or only the height the change names', () => {
    const wider = resizePanel(TWO_PANELS, 'connections', { w: 3 });
    expect(wider.panels[0]).toEqual({ id: 'connections', w: 3, h: 1 });
    const taller = resizePanel(TWO_PANELS, 'network', { h: 2 });
    expect(taller.panels[1]).toEqual({ id: 'network', w: 2, h: 2 });
  });

  it('leaves the other panels as they were', () => {
    const next = resizePanel(TWO_PANELS, 'connections', { h: 2 });
    expect(next.panels[1]).toBe(TWO_PANELS.panels[1]);
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
    expect(readStoredLayout({ version: 2, panels: [] }).state).toBe('invalid');
    expect(readStoredLayout({ version: 1, panels: [{ id: 'a', w: 4, h: 1 }] }).state).toBe(
      'invalid',
    );
  });

  it('summarises the failing paths without the stored value', () => {
    const secret = 'sensitive-panel-id-value';
    const stored = readStoredLayout({ version: 1, panels: [{ id: secret, w: 4, h: 1 }] });
    expect(stored.state).toBe('invalid');
    if (stored.state === 'invalid') {
      expect(stored.summary).toContain('panels.0.w');
      expect(stored.summary).not.toContain(secret);
    }
  });

  it('rejects a layout that places a panel twice', () => {
    const duplicated = {
      version: 1,
      panels: [
        { id: 'network', w: 1, h: 1 },
        { id: 'network', w: 2, h: 1 },
      ],
    };
    expect(readStoredLayout(duplicated).state).toBe('invalid');
  });
});

describe('visiblePanels', () => {
  it('hides panels whose requirement the connection lacks, and keeps the rest in order', () => {
    const layout: DashboardLayout = {
      version: 1,
      panels: [
        { id: 'wt-cache', w: 2, h: 1 },
        { id: 'network', w: 1, h: 1 },
        { id: 'replication-lag', w: 1, h: 1 },
      ],
    };
    const standalone = visiblePanels(layout, { wiredTiger: false, replicaSet: false });
    expect(standalone.map((item) => item.spec.id)).toEqual(['network']);
    const replica = visiblePanels(layout, { wiredTiger: true, replicaSet: true });
    expect(replica.map((item) => item.spec.id)).toEqual(['wt-cache', 'network', 'replication-lag']);
    const unknown = visiblePanels(layout, { wiredTiger: undefined, replicaSet: undefined });
    expect(unknown).toHaveLength(3);
  });

  it('skips panel ids the catalogue does not have', () => {
    const layout: DashboardLayout = { version: 1, panels: [{ id: 'retired', w: 1, h: 1 }] };
    expect(visiblePanels(layout, { wiredTiger: true, replicaSet: true })).toEqual([]);
  });
});
