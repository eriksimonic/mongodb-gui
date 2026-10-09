import type { AppStore } from '../state/app-store';
import { profilerUiEvents } from '../profiler/profiler-events';
import { explainTarget } from '../profiler/profiler-model';

/**
 * Sends the profiler's "Explain this" requests to the app store. Returns the unsubscribe function.
 * The store provider calls it once per store. An entry that cannot be explained sends nothing.
 */
export function bridgeProfilerExplain(store: AppStore): () => void {
  return profilerUiEvents.subscribe((event) => {
    if (event.type !== 'profiler:explain') {
      return;
    }
    const target = explainTarget(event.ref.entry, event.ref.command);
    if (target === undefined) {
      return;
    }
    void store.getState().openExplainCommand({
      connectionId: event.ref.connectionId,
      database: event.ref.database,
      commandEjson: JSON.stringify(target.command),
      ...(target.profileOp === undefined ? {} : { profileOp: target.profileOp }),
      ...(target.collection === undefined ? {} : { collection: target.collection }),
    });
  });
}
