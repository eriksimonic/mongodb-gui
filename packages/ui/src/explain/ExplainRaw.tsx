import { ActionIcon, Box, Button, Group, Stack, Text, TextInput, Tooltip } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconChevronDown, IconChevronUp, IconCopy } from '@tabler/icons-react';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { notifyError } from '../components/notify-error';
import { JsonEditor, type JsonEditorHandle } from '../editor/JsonEditor';
import { findTextMatches, nextMatchIndex, previousMatchIndex, type TextSpan } from './stage-view';

/** The editor never gets shorter than this, so a short panel scrolls instead of squashing it. */
const MIN_EDITOR_HEIGHT_PX = 240;

export interface ExplainRawProps {
  /** The server's explain document as canonical EJSON. Copied and searched as it is. */
  readonly text: string;
}

/**
 * The raw explain document with search, next and previous match, folding and copy. The editor
 * takes the height its panel leaves after the search row, with a floor for a short panel.
 */
export function ExplainRaw({ text }: ExplainRawProps) {
  const [query, setQuery] = useState('');
  const [current, setCurrent] = useState(0);
  const handle = useRef<JsonEditorHandle | undefined>(undefined);
  const matches = useMemo(() => findTextMatches(text, query), [text, query]);
  const index = matches.length === 0 ? -1 : Math.min(current, matches.length - 1);
  const active: TextSpan | undefined = index === -1 ? undefined : matches[index];

  // Scrolls the editor to the current match whenever the match changes.
  useEffect(() => {
    if (active !== undefined) {
      handle.current?.reveal(active);
    }
  }, [active]);

  function step(next: number): void {
    setCurrent(next);
  }

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      notifications.show({ title: 'Raw output copied', message: 'EJSON', color: 'teal' });
    } catch (error) {
      notifyError(error, 'The raw output could not be copied');
    }
  }

  function handleSearchKey(event: KeyboardEvent<HTMLInputElement>): void {
    if (event.key === 'Enter') {
      event.preventDefault();
      step(
        event.shiftKey
          ? previousMatchIndex(index, matches.length)
          : nextMatchIndex(index, matches.length),
      );
    }
  }

  const hasQuery = query !== '';
  return (
    <Stack gap="xs" style={{ flex: 1, minHeight: 0 }}>
      <Group gap="xs" wrap="nowrap" align="flex-end">
        <TextInput
          size="xs"
          aria-label="Search raw output"
          placeholder="Search"
          value={query}
          onChange={(event) => {
            setQuery(event.currentTarget.value);
            setCurrent(0);
          }}
          onKeyDown={handleSearchKey}
          style={{ flex: 1, minWidth: 0 }}
        />
        <Text size="xs" c="dimmed" aria-live="polite" style={{ whiteSpace: 'nowrap' }}>
          {hasQuery
            ? matches.length === 0
              ? 'No matches'
              : `${index + 1} of ${matches.length}`
            : ''}
        </Text>
        <Tooltip label="Previous match" withArrow>
          <ActionIcon
            size="sm"
            variant="default"
            aria-label="Previous match"
            disabled={matches.length === 0}
            onClick={() => step(previousMatchIndex(index, matches.length))}
          >
            <IconChevronUp size={14} aria-hidden="true" />
          </ActionIcon>
        </Tooltip>
        <Tooltip label="Next match" withArrow>
          <ActionIcon
            size="sm"
            variant="default"
            aria-label="Next match"
            disabled={matches.length === 0}
            onClick={() => step(nextMatchIndex(index, matches.length))}
          >
            <IconChevronDown size={14} aria-hidden="true" />
          </ActionIcon>
        </Tooltip>
        <Button
          size="xs"
          variant="default"
          leftSection={<IconCopy size={14} aria-hidden="true" />}
          onClick={() => void copy()}
        >
          Copy
        </Button>
      </Group>
      <Box style={{ flex: 1, minHeight: MIN_EDITOR_HEIGHT_PX }}>
        <JsonEditor
          label="Raw explain output"
          readOnly
          height="100%"
          value={text}
          onEditorReady={(editorHandle) => {
            handle.current = editorHandle;
          }}
        />
      </Box>
    </Stack>
  );
}
