/** jsdom lacks these browser APIs. Dockview and Mantine ask for them on mount. */

// Mantine scrolls the highlighted option into view when a select opens. jsdom has no layout.
if (typeof Element.prototype.scrollIntoView !== 'function') {
  Element.prototype.scrollIntoView = () => undefined;
}

class ResizeObserverShim {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

if (typeof globalThis.ResizeObserver === 'undefined') {
  Object.assign(globalThis, { ResizeObserver: ResizeObserverShim });
}

// The profiler table virtualises rows against its scroll element's height. jsdom reports zero, so
// the profiler scroller reports a fixed viewport. Every other element keeps the jsdom answer.
const PROFILER_VIEWPORT_PX = 800;
const PROFILER_SCROLLER = 'mg-profiler-scroll';
// Every other virtualised list takes the same viewport through this class.
const VIRTUAL_SCROLLER = 'mg-virtual-scroll';
const SCHEMA_SCROLLER = 'mg-schema-scroll';
const GRIDFS_SCROLLER = 'mg-gridfs-scroll';
function isViewport(element: Element): boolean {
  return (
    element.classList.contains(PROFILER_SCROLLER) ||
    element.classList.contains(SCHEMA_SCROLLER) ||
    element.classList.contains(VIRTUAL_SCROLLER) ||
    element.classList.contains(GRIDFS_SCROLLER)
  );
}
const originalRect = Element.prototype.getBoundingClientRect;
Element.prototype.getBoundingClientRect = function getBoundingClientRect(): DOMRect {
  if (isViewport(this)) {
    return {
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      bottom: PROFILER_VIEWPORT_PX,
      right: 1000,
      width: 1000,
      height: PROFILER_VIEWPORT_PX,
      toJSON: () => ({}),
    } as DOMRect;
  }
  return originalRect.call(this);
};
Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
  configurable: true,
  get(this: HTMLElement): number {
    return isViewport(this) ? PROFILER_VIEWPORT_PX : 0;
  },
});

// Scrolling in jsdom does not move anything. The profiler scroller keeps the offset it is given,
// so a test can check where scrollToIndex put the selected row.
const scrollOffsets = new WeakMap<Element, number>();
Object.defineProperty(Element.prototype, 'scrollTop', {
  configurable: true,
  get(this: Element): number {
    return scrollOffsets.get(this) ?? 0;
  },
  set(this: Element, value: number) {
    scrollOffsets.set(this, value);
  },
});
Element.prototype.scrollTo = function scrollTo(this: Element, ...args: unknown[]): void {
  const options = args[0];
  if (typeof options === 'object' && options !== null && 'top' in options) {
    const top = (options as { top?: unknown }).top;
    if (typeof top === 'number') {
      scrollOffsets.set(this, top);
    }
  }
};
// The scroll height of the profiler scroller is its header plus the body the table sets as an inline
// height. The virtualiser clamps scroll offsets to scrollHeight minus clientHeight, as a browser does.
const PROFILER_HEADER_PX = 32;
Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
  configurable: true,
  get(this: HTMLElement): number {
    if (!isViewport(this)) {
      return 0;
    }
    const body = this.firstElementChild?.lastElementChild;
    const bodyPx = body instanceof HTMLElement ? parseFloat(body.style.height) : 0;
    return PROFILER_HEADER_PX + (Number.isFinite(bodyPx) ? bodyPx : 0);
  },
});
Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
  configurable: true,
  get(this: HTMLElement): number {
    return isViewport(this) ? PROFILER_VIEWPORT_PX : 0;
  },
});

// Mantine's combobox scrolls the highlighted option into view when it opens.
if (typeof Element.prototype.scrollIntoView !== 'function') {
  Element.prototype.scrollIntoView = (): void => undefined;
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
