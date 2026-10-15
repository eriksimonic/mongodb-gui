// Runs in the page before any app script (Playwright addInitScript). Stands in for the preload
// script: window.mongoGui forwards invoke to POST /__e2e/rpc and events from SSE /__e2e/events.
// Playwright serializes this function, so it must not reference anything outside its body.
export function installBridge(): void {
  const listeners = new Set<(event: unknown) => void>();
  const source = new EventSource('/__e2e/events');
  source.onmessage = (message) => {
    const event: unknown = JSON.parse(message.data as string);
    for (const listener of listeners) {
      listener(event);
    }
  };
  // In the page globalThis is the window. The tooling project has no DOM types.
  Object.defineProperty(globalThis, 'mongoGui', {
    value: Object.freeze({
      async invoke(method: string, input: unknown) {
        const response = await fetch('/__e2e/rpc', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ method, input }),
        });
        const reply = (await response.json()) as { ok?: unknown; value?: unknown } | null;
        // JSON drops keys whose value is undefined. Electron IPC keeps them, and the page's
        // zod schema requires `value` on ok replies, so restore the key.
        if (reply?.ok === true && !('value' in reply)) {
          reply.value = undefined;
        }
        return reply;
      },
      onEvent(listener: (event: unknown) => void) {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    }),
  });
}
