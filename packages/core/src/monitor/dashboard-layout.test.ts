import { describe, expect, it } from 'vitest';
import {
  DASHBOARD_LAYOUT_VERSION,
  dashboardLayoutKey,
  defaultDashboardLayout,
  layoutValueBytes,
  parseDashboardLayout,
} from './dashboard-layout';

describe('parseDashboardLayout', () => {
  it('returns a layout that matches the schema', () => {
    const layout = {
      version: DASHBOARD_LAYOUT_VERSION,
      panels: [
        { id: 'memory', w: 2, h: 2 },
        { id: 'queues', w: 1, h: 1 },
      ],
    };
    expect(parseDashboardLayout(layout)).toEqual(layout);
  });

  it('returns undefined for a missing value, a wrong version or an unknown width', () => {
    expect(parseDashboardLayout(null)).toBeUndefined();
    expect(parseDashboardLayout(undefined)).toBeUndefined();
    expect(parseDashboardLayout({ version: 2, panels: [] })).toBeUndefined();
    expect(parseDashboardLayout({ version: 1, panels: [{ id: 'a', w: 4, h: 1 }] })).toBeUndefined();
  });

  it('returns undefined when a panel appears twice', () => {
    const duplicated = {
      version: 1,
      panels: [
        { id: 'network', w: 1, h: 1 },
        { id: 'network', w: 2, h: 1 },
      ],
    };
    expect(parseDashboardLayout(duplicated)).toBeUndefined();
  });

  it('returns undefined above the panel limit', () => {
    const panels = Array.from({ length: 65 }, (_, index) => ({ id: `p${index}`, w: 1, h: 1 }));
    expect(parseDashboardLayout({ version: 1, panels })).toBeUndefined();
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
