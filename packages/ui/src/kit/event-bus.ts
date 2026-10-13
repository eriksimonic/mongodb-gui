export interface UiEventBus<E extends { readonly type: string }> {
  emit(event: E): void;
  subscribe(listener: (event: E) => void): () => void;
}

/**
 * Listener sets by bus name, kept on globalThis. A hot reload in development runs this module
 * again, and a fresh set would leave the app store's subscriptions on the old bus, so a click
 * would reach nobody.
 */
const LISTENERS_KEY = Symbol.for('mongo-gui.ui-event-listeners');

function listenersOf(name: string): Set<(event: never) => void> {
  const scope = globalThis as { [LISTENERS_KEY]?: Map<string, Set<(event: never) => void>> };
  const all = (scope[LISTENERS_KEY] ??= new Map());
  let listeners = all.get(name);
  if (listeners === undefined) {
    listeners = new Set();
    all.set(name, listeners);
  }
  return listeners;
}

export function createUiEventBus<E extends { readonly type: string }>(name: string): UiEventBus<E> {
  const listeners = listenersOf(name) as Set<(event: E) => void>;
  return {
    emit(event) {
      for (const listener of [...listeners]) {
        listener(event);
      }
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
