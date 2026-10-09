/** jsdom lacks these browser APIs. Dockview and Mantine ask for them on mount. */

class ResizeObserverShim {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

if (typeof globalThis.ResizeObserver === 'undefined') {
  Object.assign(globalThis, { ResizeObserver: ResizeObserverShim });
}

if (typeof window.matchMedia !== 'function') {
  Object.assign(window, {
    matchMedia: (query: string): MediaQueryList => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => undefined,
      removeListener: () => undefined,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      dispatchEvent: () => false,
    }),
  });
}
