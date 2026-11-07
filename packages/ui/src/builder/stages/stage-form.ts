import { ACCUMULATORS, type Accumulator } from '@mongo-gui/core';
import { useState } from 'react';

/**
 * Remounts a stage form when its body changes from outside the form. The form remembers the last
 * body it emitted or received. A body whose fields differ from it came from the parent, so the key
 * changes and the form reads the new body on mount. A change the form emits keeps the key.
 */
export function useStageKey<T extends object>(
  body: T,
  onChange: (next: T) => void,
): { readonly key: number; readonly emit: (next: T) => void } {
  const [known, setKnown] = useState<T>(body);
  const [key, setKey] = useState(0);
  if (!sameFields(known, body)) {
    setKnown(body);
    setKey((current) => current + 1);
  }
  const emit = (next: T): void => {
    setKnown(next);
    onChange(next);
  };
  return { key, emit };
}

/**
 * True when every field of `known` has the same JSON text in `body`. A field that `body` adds, such
 * as `enabled` from the stage list, is ignored. The stage list re-wraps the body on every change.
 */
function sameFields(known: object, body: object): boolean {
  const fields = body as Record<string, unknown>;
  return Object.entries(known).every(
    ([name, value]) => JSON.stringify(value) === JSON.stringify(fields[name]),
  );
}

export function isAccumulator(value: string | null): value is Accumulator {
  return ACCUMULATORS.some((accumulator) => accumulator === value);
}
