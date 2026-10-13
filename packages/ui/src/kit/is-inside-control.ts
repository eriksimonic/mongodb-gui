/** True when an event came from a button, link or field. Row double-clicks skip these targets. */
export function isInsideControl(target: EventTarget): boolean {
  return target instanceof Element && target.closest('button, a, input, textarea') !== null;
}
