import { SegmentedControl, Stack } from '@mantine/core';
import { useMemo, useState } from 'react';
import { ReadOnlyCode } from '../editor/ReadOnlyCode';
import type { JsonObject } from './result-model';
import { MODE_LABELS, jsonTextFor, type JsonMode } from './json-text';

export interface JsonViewProps {
  /** A cursor page, or the printable text of a non-cursor value. */
  readonly source:
    { readonly documents: readonly JsonObject[] } | { readonly printableEjson: string };
  readonly label: string;
}

/** The page as read-only Monaco text, with folding and find. Mongosh syntax by default. */
export function JsonView({ source, label }: JsonViewProps) {
  const [mode, setMode] = useState<JsonMode>('mongosh');
  const text = useMemo(() => jsonTextFor(source, mode), [source, mode]);
  return (
    <Stack gap={6} h="100%">
      <SegmentedControl
        size="xs"
        aria-label="JSON notation"
        value={mode}
        onChange={(value) => setMode(value as JsonMode)}
        data={(Object.keys(MODE_LABELS) as JsonMode[]).map((key) => ({
          value: key,
          label: MODE_LABELS[key],
        }))}
        style={{ alignSelf: 'flex-start' }}
      />
      <div style={{ flex: 1, minHeight: 0 }}>
        <ReadOnlyCode
          label={label}
          value={text}
          language={mode === 'mongosh' ? 'javascript' : 'json'}
        />
      </div>
    </Stack>
  );
}
