import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DockviewApi, SerializedDockview } from 'dockview-react';
import type { RpcClient } from '@mongo-gui/core';
import {
  LAYOUT_SAVE_DELAY_MS,
  createLayoutSaver,
  isSavedDockLayout,
  loadDockLayout,
  restoreDockLayout,
} from './dock-layout';

const SAVED = { grid: { root: { type: 'branch', data: [] } }, panels: {}, activeGroup: 'main' };

/** A saved layout with another active group, typed as the dock expects. */
function withGroup(activeGroup: string): SerializedDockview {
  return { ...SAVED, activeGroup } as unknown as SerializedDockview;
}

/** The dockview methods the restore path uses, as a test double. */
function fakeDock(options: { readonly loadFails?: boolean } = {}) {
  const calls: string[] = [];
  const api = {
    fromJSON: vi.fn((value: unknown) => {
      calls.push(`fromJSON:${typeof value}`);
      if (options.loadFails === true) {
        throw new Error('bad layout');
      }
    }),
    clear: vi.fn(() => {
      calls.push('clear');
    }),
  };
  return { api: api as unknown as DockviewApi, raw: api, calls };
}

describe('isSavedDockLayout', () => {
  it('accepts a value with a grid and a panel map', () => {
    expect(isSavedDockLayout(SAVED)).toBe(true);
  });

  it('rejects null, scalars and objects without the layout keys', () => {
    expect(isSavedDockLayout(null)).toBe(false);
    expect(isSavedDockLayout('layout')).toBe(false);
    expect(isSavedDockLayout({ grid: {} })).toBe(false);
    expect(isSavedDockLayout({ panels: {} })).toBe(false);
  });
});

describe('restoreDockLayout', () => {
  it('loads a saved layout into the dock', () => {
    const dock = fakeDock();
    expect(restoreDockLayout(dock.api, SAVED)).toBe(true);
    expect(dock.raw.fromJSON).toHaveBeenCalledWith(SAVED);
  });

  it('leaves the dock alone when nothing is saved', () => {
    const dock = fakeDock();
    expect(restoreDockLayout(dock.api, null)).toBe(false);
    expect(dock.raw.fromJSON).not.toHaveBeenCalled();
    expect(dock.raw.clear).not.toHaveBeenCalled();
  });

  it('rejects a value of the wrong shape without touching the dock', () => {
    const dock = fakeDock();
    expect(restoreDockLayout(dock.api, { panels: 'nope' })).toBe(false);
    expect(dock.raw.fromJSON).not.toHaveBeenCalled();
  });

  it('clears the dock and reports failure when the layout does not load', () => {
    const dock = fakeDock({ loadFails: true });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(restoreDockLayout(dock.api, SAVED)).toBe(false);
    expect(dock.raw.clear).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('loadDockLayout', () => {
  it('returns the stored value under the dockview key', async () => {
    const get = vi.fn(async () => ({ value: SAVED }));
    const rpc = { layout: { get } } as unknown as RpcClient;
    await expect(loadDockLayout(rpc)).resolves.toEqual(SAVED);
    expect(get).toHaveBeenCalledWith({ key: 'dockview:main' });
  });

  it('returns null and logs when the read fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const rpc = {
      layout: {
        get: async () => {
          throw new Error('locked');
        },
      },
    } as unknown as RpcClient;
    await expect(loadDockLayout(rpc)).resolves.toBeNull();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('createLayoutSaver', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('writes the layout once, after the quiet period', () => {
    const set = vi.fn(async () => undefined);
    const saver = createLayoutSaver({ layout: { set } } as unknown as RpcClient);

    saver.call(withGroup('a'));
    vi.advanceTimersByTime(LAYOUT_SAVE_DELAY_MS - 1);
    saver.call(withGroup('b'));
    vi.advanceTimersByTime(LAYOUT_SAVE_DELAY_MS - 1);
    expect(set).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(set).toHaveBeenCalledOnce();
    expect(set).toHaveBeenCalledWith({
      key: 'dockview:main',
      value: withGroup('b'),
    });
  });

  it('logs a failed write and keeps running', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const set = vi.fn(async () => {
      throw new Error('locked');
    });
    const saver = createLayoutSaver({ layout: { set } } as unknown as RpcClient);
    saver.call(withGroup('main'));
    vi.advanceTimersByTime(LAYOUT_SAVE_DELAY_MS);
    await vi.waitFor(() => expect(warn).toHaveBeenCalled());
    warn.mockRestore();
  });
});
