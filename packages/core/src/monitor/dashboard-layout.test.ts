import { describe, expect, it } from 'vitest';
import {
  DASHBOARD_LAYOUT_VERSION,
  dashboardLayoutKey,
  defaultDashboardLayout,
  layoutValueBytes,
  parseDashboardLayout,
} from './dashboard-layout';

describe('parseDashboardLayout', () => {
  it('returns a layout that matches the schema, with each row summing to 1', () => {
    const layout = {
      version: DASHBOARD_LAYOUT_VERSION,
      rows: [
        { h: 300, panels: [{ id: 'memory', f: 0.5 }, { id: 'queues', f: 0.5 }] },
        { h: 200, panels: [{ id: 'network', f: 1 }] },
      ],
    };
    expect(parseDashboardLayout(layout)).toEqual(layout);
    const uneven = { version: 2, rows: [{ h: 300, panels: [{ id: 'a', f: 0.2 }, { id: 'b', f: 0.2 }] }] };
    expect(parseDashboardLayout(uneven)?.rows[0]?.panels.map((panel) => panel.f)).toEqual([0.5, 0.5]);
  });

  it('returns undefined for a missing value, an unknown version or a row without panels', () => {
    expect(parseDashboardLayout(null)).toBeUndefined();
    expect(parseDashboardLayout({ version: 3, rows: [] })).toBeUndefined();
    expect(parseDashboardLayout({ version: 2, rows: [{ h: 300, panels: [] }] })).toBeUndefined();
    expect(parseDashboardLayout({ version: 1, panels: [{ id: 'a', w: 4, h: 1 }] })).toBeUndefined();
  });

  it('returns undefined when a panel appears twice', () => {
    const duplicated = {
      version: 2,
      rows: [{ h: 300, panels: [{ id: 'network', f: 0.5 }, { id: 'network', f: 0.5 }] }],
    };
    expect(parseDashboardLayout(duplicated)).toBeUndefined();
  });

  it('migrates span layouts into rows of three columns', () => {
    const migrated = parseDashboardLayout({
      version: 1,
      panels: [
        { id: 'a', w: 2, h: 1 },
        { id: 'b', w: 1, h: 1 },
        { id: 'c', w: 3, h: 2 },
      ],
    });
    expect(migrated?.rows.map((row) => row.panels.map((panel) => panel.id))).toEqual([['a', 'b'], ['c']]);
    expect(migrated?.rows[0]?.panels[0]?.f).toBeCloseTo(2 / 3);
    expect(migrated?.rows[1]?.panels[0]?.f).toBe(1);
  });

  it('migrates a free pixel layout by sorting top to bottom, then left to right', () => {
    const migrated = parseDashboardLayout({
      version: 1,
      panels: [
        { id: 'right', w: 1, h: 1, rect: { x: 600, y: 0, w: 300, h: 200 } },
        { id: 'low', w: 1, h: 1, rect: { x: 0, y: 400, w: 500, h: 200 } },
        { id: 'left', w: 1, h: 1, rect: { x: 0, y: 0, w: 300, h: 200 } },
      ],
    });
    expect(migrated?.rows.map((row) => row.panels.map((panel) => panel.id))).toEqual([['left', 'right'], ['low']]);
  });

  it('accepts the default layout', () => {
    expect(parseDashboardLayout(defaultDashboardLayout())).toEqual(defaultDashboardLayout());
  });
});

describe('layoutValueBytes', () => {
  it('counts one byte per ASCII character of the JSON text', () => {
    expect(layoutValueBytes('ab')).toBe('"ab"'.length);
  });

  it('counts multi-byte UTF-8 characters by their encoded length', () => {
    // The JSON text of 'é' is "é" with quotes, so two ASCII bytes plus two bytes for é.
    expect(layoutValueBytes('é')).toBe(4);
    // A three-byte character (€) and a four-byte character (an emoji outside the BMP).
    expect(layoutValueBytes('€')).toBe(5);
    expect(layoutValueBytes('😀')).toBe(6);
  });

  it('counts the encoded bytes of nested text, with multi-byte characters inside it', () => {
    // {"id":"panel-ü","note":"línea → 😀"} is 42 bytes once encoded as UTF-8.
    expect(layoutValueBytes({ id: 'panel-ü', note: 'línea → 😀' })).toBe(42);
  });

  it('measures undefined as the JSON null', () => {
    expect(layoutValueBytes(undefined)).toBe(4);
  });
});

describe('dashboardLayoutKey', () => {
  it('names one layout per connection', () => {
    expect(dashboardLayoutKey('abc')).toBe('layout:dashboard:abc');
    expect(dashboardLayoutKey('abc')).not.toBe(dashboardLayoutKey('abd'));
  });
});
