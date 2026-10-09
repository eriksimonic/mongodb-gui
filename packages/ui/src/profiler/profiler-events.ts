import type { ProfileEntry } from '@mongo-gui/core';

export interface ProfilerEntryRef {
  readonly connectionId: string;
  readonly database: string;
  readonly entry: ProfileEntry;
}

/**
 * UI-level events from the profiler. The explain phase subscribes to `profiler:explain` and the
 * editor phase subscribes to `profiler:open`. Until then the panel only shows a notification.
 */
export type ProfilerUiEvent =
  | { readonly type: 'profiler:explain'; readonly ref: ProfilerEntryRef }
  | { readonly type: 'profiler:open'; readonly ref: ProfilerEntryRef };

export interface UiEventBus<E extends { readonly type: string }> {
  emit(event: E): void;
  subscribe(listener: (event: E) => void): () => void;
}

export function createUiEventBus<E extends { readonly type: string }>(): UiEventBus<E> {
  const listeners = new Set<(event: E) => void>();
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

export const profilerUiEvents = createUiEventBus<ProfilerUiEvent>();
