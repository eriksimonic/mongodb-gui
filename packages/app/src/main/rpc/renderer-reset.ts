/**
 * Handlers that stop work the renderer started. The window calls resetRenderer when its page
 * goes away (a crash, a closed window, a quit), so nothing keeps running for a page nobody sees.
 */
export interface RendererResetRegistry {
  /** Adds a handler. The returned function removes it again. */
  register(handler: () => void): () => void;
  /** Runs every handler. A handler that throws does not stop the others. */
  resetRenderer(): void;
}

export function createRendererResetRegistry(): RendererResetRegistry {
  const handlers = new Set<() => void>();
  return {
    register(handler) {
      handlers.add(handler);
      return () => {
        handlers.delete(handler);
      };
    },
    resetRenderer() {
      for (const handler of [...handlers]) {
        try {
          handler();
        } catch {
          // A failing handler must not keep the others from running.
        }
      }
    },
  };
}
