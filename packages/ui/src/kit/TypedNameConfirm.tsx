import { TextInput } from '@mantine/core';
import { useEffect, useEffectEvent, useState } from 'react';

export interface TypedNameConfirmProps {
  /** The name the user must type. An empty name never matches. */
  readonly expected: string;
  /** Called with whether the typed text equals `expected`, and with false on unmount. */
  readonly onMatchChange: (matches: boolean) => void;
}

/**
 * A text input that asks for a name before an action that destroys data. The host keeps its
 * confirm button disabled until the input reports a match. The match is exact: case and spaces
 * count.
 */
export function TypedNameConfirm({ expected, onMatchChange }: TypedNameConfirmProps) {
  const [typed, setTyped] = useState('');
  const matches = expected !== '' && typed === expected;
  // Always calls the latest onMatchChange, so the host may pass a new function on each render.
  const report = useEffectEvent((value: boolean) => {
    onMatchChange(value);
  });

  useEffect(() => {
    report(matches);
  }, [matches]);

  // A remount or an unmount starts unconfirmed, so the host never keeps a match for a hidden input.
  useEffect(() => () => report(false), []);

  return (
    <TextInput
      label={`Type ${expected} to confirm`}
      value={typed}
      onChange={(event) => {
        setTyped(event.currentTarget.value);
      }}
      autoComplete="off"
      spellCheck={false}
    />
  );
}
