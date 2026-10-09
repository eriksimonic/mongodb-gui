import type { RpcClient } from '@mongo-gui/core';
import type { DockviewApi, SerializedDockview } from 'dockview-react';
import { debounce, type Debounced } from '@mongo-gui/core';
import { DOCK_LAYOUT_KEY } from '../state/app-store';

/** Quiet time after the last layout change before the layout is written. */
export const LAYOUT_SAVE_DELAY_MS = 500;

/**
 * True when a stored value has the outline of a dockview layout: a grid and a panel map. The
 * dockview loader checks the rest, and a failure there resets the layout.
 */
export function isSavedDockLayout(value: unknown): value is SerializedDockview {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record['grid'] === 'object' &&
    record['grid'] !== null &&
    typeof record['panels'] === 'object' &&
    record['panels'] !== null
  );
}

/** Reads the saved layout. Null means none is saved, or the read failed and the default applies. */
export async function loadDockLayout(rpc: RpcClient): Promise<unknown> {
  try {
    const { value } = await rpc.layout.get({ key: DOCK_LAYOUT_KEY });
    return value;
  } catch (error) {
    console.warn('The saved panel layout could not be read. The default layout is used.', error);
    return null;
  }
}

/**
 * Loads a saved layout into the dock. Returns false when the value is missing or does not load.
 * A failed load clears the dock, so the caller can build the default layout on an empty dock.
 */
export function restoreDockLayout(api: DockviewApi, value: unknown): boolean {
  if (value === null || value === undefined) {
    return false;
  }
  if (!isSavedDockLayout(value)) {
    console.warn('The saved panel layout is not valid. The default layout is used.');
    return false;
  }
  try {
    api.fromJSON(value);
    return true;
  } catch (error) {
    console.warn('The saved panel layout could not be loaded. The default layout is used.', error);
    api.clear();
    return false;
  }
}

/**
 * Writes the layout a quiet period after the last change. A write that fails is logged and
 * dropped, so the next change tries again.
 */
export function createLayoutSaver(rpc: RpcClient): Debounced<[SerializedDockview]> {
  return debounce((layout: SerializedDockview) => {
    rpc.layout.set({ key: DOCK_LAYOUT_KEY, value: layout }).catch((error: unknown) => {
      console.warn('The panel layout could not be saved.', error);
    });
  }, LAYOUT_SAVE_DELAY_MS);
}
