import { TextInput } from '@mantine/core';
import { type EjsonValue, parseValueText } from '@mongo-gui/core';
import { useState } from 'react';
import { mongoshText } from './condition-model';

export interface RawTextProps {
  /** The stored value. The box shows it as one line of mongosh text. */
  readonly value: unknown;
  readonly ariaLabel: string;
  /** A CSS width, such as `calc(240px * var(--mg-font-scale, 1))`. */
  readonly width: string;
  /**
   * Receives the parsed value on blur. Return a reason to keep the stored value and show it, or
   * undefined to accept the value.
   */
  readonly onCommit: (value: EjsonValue) => string | undefined;
}

/**
 * A raw value as mongosh text. The text is read again when the box loses focus. Text that does not
 * parse keeps the stored value and shows red with the parser reason. The draft is shown while it is
 * being edited. The parent remounts the box when the stored value changes, so a draft never shows
 * on another row.
 */
export function RawText({ value, ariaLabel, width, onCommit }: RawTextProps) {
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const commit = (): void => {
    if (draft === null) return;
    const parsed = parseValueText(draft);
    const reason = 'unsupported' in parsed ? parsed.unsupported : onCommit(parsed.value);
    if (reason !== undefined) {
      setError(reason);
      return;
    }
    setDraft(null);
    setError(null);
  };

  return (
    <TextInput
      size="xs"
      aria-label={ariaLabel}
      ff="monospace"
      value={draft ?? mongoshText(value)}
      error={error}
      onChange={(event) => setDraft(event.currentTarget.value)}
      onBlur={commit}
      w={width}
    />
  );
}
