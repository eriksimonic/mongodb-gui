import type { AppStore } from '../state/app-store';
import { profilerUiEvents } from '../profiler/profiler-events';

/**
 * Sends the profiler's "Explain this" requests to the app store. Returns the unsubscribe function.
 * The store provider calls it once per store.
 */
export function bridgeProfilerExplain(store: AppStore): () => void {
  return profilerUiEvents.subscribe((event) => {
    if (event.type !== 'profiler:explain') {
      return;
    }
    void store.getState().openExplainCommand({
      connectionId: event.ref.connectionId,
      database: event.ref.database,
      commandEjson: JSON.stringify(event.ref.command),
    });
  });
}
