import type { PointerEvent } from 'react';

/** Runs `move` for each pointer move after a press on the element, and `end` on release. */
export function trackPointer(
  event: PointerEvent<HTMLElement>,
  move: (event: globalThis.PointerEvent) => void,
  end: (event: globalThis.PointerEvent) => void,
): void {
  if (event.button !== 0 || (event.target as Element).closest('button')) {
    return;
  }
  event.preventDefault();
  const target = event.currentTarget;
  target.setPointerCapture(event.pointerId);
  const finish = (next: globalThis.PointerEvent) => {
    target.removeEventListener('pointermove', move);
    target.removeEventListener('pointerup', finish);
    target.removeEventListener('pointercancel', finish);
    end(next);
  };
  target.addEventListener('pointermove', move);
  target.addEventListener('pointerup', finish);
  target.addEventListener('pointercancel', finish);
}

/** Starts a pointer drag and reports its offset from the press. Used by the dividers and the grip. */
export function trackOffset(
  event: PointerEvent<HTMLElement>,
  report: (dx: number, dy: number, final: boolean) => void,
): void {
  const x = event.clientX;
  const y = event.clientY;
  trackPointer(
    event,
    (next) => report(next.clientX - x, next.clientY - y, false),
    (next) => report(next.clientX - x, next.clientY - y, true),
  );
}
