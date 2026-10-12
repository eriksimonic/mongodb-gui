import { useContext, useSyncExternalStore } from 'react';
import { AppStoreContext } from '../state/app-store-context';

/** The editor font size at which the UI renders at its designed size. */
const BASE_FONT_SIZE = 13;

function scaleFor(fontSize: number | undefined): number {
  return (fontSize ?? BASE_FONT_SIZE) / BASE_FONT_SIZE;
}

/** The current scale, for pixel sizes that JavaScript computes, such as virtual row heights. */
export function useFontScale(): number {
  const store = useContext(AppStoreContext);
  // Without a store, as in isolated component tests, rows keep their designed size.
  return useSyncExternalStore(
    (notify) => store?.subscribe(notify) ?? (() => undefined),
    () => scaleFor(store?.getState().settings?.editorFontSize),
  );
}

/** Mantine's rem units follow the root font size. Custom px font sizes multiply by --mg-font-scale. */
export function applyFontScale(fontSize: number | undefined): void {
  const scale = scaleFor(fontSize);
  const root = document.documentElement;
  root.style.fontSize = `${16 * scale}px`;
  root.style.setProperty('--mg-font-scale', String(scale));
}
