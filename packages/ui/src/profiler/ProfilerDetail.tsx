import { Accordion, Badge, Box, Button, Code, Group, SimpleGrid, Stack, Text } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import type { ProfileEntry } from '@mongo-gui/core';
import { useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { notifyError } from '../components/notify-error';
import { JsonEditor } from '../editor/JsonEditor';
import { profilerUiEvents } from './profiler-events';
import {
  formatCommand,
  formatCommandJson,
  formatLocalTime,
  explainTarget,
  isCollscan,
  userCommand,
} from './profiler-model';

/** Height of the editable command. */
const COMMAND_HEIGHT_PX = 220;

const RESIZE_STEP_PX = 24;

export interface ProfilerDetailProps {
  readonly connectionId: string;
  readonly database: string;
  readonly entry: ProfileEntry | undefined;
  readonly width: number;
  readonly onResize: (width: number) => void;
}

/**
 * The right-hand pane for the selected operation. The splitter on its left edge resizes it with
 * the mouse or with the arrow keys.
 */
export function ProfilerDetail({
  connectionId,
  database,
  entry,
  width,
  onResize,
}: ProfilerDetailProps) {
  const dragStart = useRef<{ readonly x: number; readonly width: number } | undefined>(undefined);

  function startDrag(event: PointerEvent<HTMLDivElement>) {
    dragStart.current = { x: event.clientX, width };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function drag(event: PointerEvent<HTMLDivElement>) {
    const start = dragStart.current;
    if (start !== undefined) {
      onResize(start.width - (event.clientX - start.x));
    }
  }

  function endDrag(event: PointerEvent<HTMLDivElement>) {
    dragStart.current = undefined;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }

  function handleSplitterKey(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      onResize(width + RESIZE_STEP_PX);
    } else if (event.key === 'ArrowRight') {
      event.preventDefault();
      onResize(width - RESIZE_STEP_PX);
    }
  }

  return (
    <>
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize the detail pane"
        aria-valuenow={width}
        tabIndex={0}
        className="mg-profiler-splitter"
        onPointerDown={startDrag}
        onPointerMove={drag}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onKeyDown={handleSplitterKey}
      />
      <Box className="mg-profiler-detail" style={{ width, flex: '0 0 auto' }}>
        {entry === undefined ? (
          <Text size="sm" c="dimmed" p={8}>
            Select an operation to see its command.
          </Text>
        ) : (
          // Keyed by entry, so a newly selected operation starts from its own command text.
          <EntryDetail
            key={entry.id}
            connectionId={connectionId}
            database={database}
            entry={entry}
          />
        )}
      </Box>
    </>
  );
}

interface EntryDetailProps {
  readonly connectionId: string;
  readonly database: string;
  readonly entry: ProfileEntry;
}

function EntryDetail({ connectionId, database, entry }: EntryDetailProps) {
  // The command without the driver's session fields, as JSON the user can edit before an explain.
  const runnable = userCommand(entry.command);
  const original = formatCommandJson(runnable);
  const [text, setText] = useState(original);
  const edited = text !== original;
  const parsed = parseCommand(text);
  // The JSON view drops number types, such as a 64-bit cursor id, so an unedited command goes out
  // in its captured form.
  const command = edited ? parsed.command : runnable;
  // A getMore without its originating command, and anything else the explain cannot run, is disabled.
  const explainUnavailable = command === undefined || explainTarget(entry, command) === undefined;

  function explain() {
    if (command === undefined) {
      return;
    }
    profilerUiEvents.emit({
      type: 'profiler:explain',
      ref: { connectionId, database, entry, command },
    });
  }

  async function copyCommand() {
    try {
      // Copy gives mongosh source, so a pasted command keeps the server's types.
      await navigator.clipboard.writeText(command === undefined ? text : formatCommand(command));
      notifications.show({ title: 'Command copied', message: entry.ns, color: 'blue' });
    } catch (error) {
      notifyError(error, 'The command could not be copied');
    }
  }

  return (
    <Stack gap={8}>
      <Stack gap={4}>
        <Text fw={600} size="sm" style={{ wordBreak: 'break-all' }}>
          {entry.ns}
        </Text>
        <Group gap={6} wrap="wrap">
          <Badge tt="none" variant="light" size="sm" color="gray">
            {entry.op}
          </Badge>
          {isCollscan(entry.planSummary) ? (
            <Badge tt="none" color="red" variant="filled" size="sm">
              COLLSCAN
            </Badge>
          ) : null}
          <Text size="xs" c="dimmed">
            {formatLocalTime(entry.ts)} · {entry.millis} ms
          </Text>
        </Group>
        {entry.errMsg === undefined ? null : (
          <Text size="xs" c="red">
            {entry.errMsg}
          </Text>
        )}
      </Stack>
      <Group gap={6} wrap="wrap">
        <Button size="xs" onClick={explain} disabled={explainUnavailable}>
          Explain
        </Button>
        <Button size="xs" variant="default" onClick={() => void copyCommand()}>
          Copy
        </Button>
        <Button size="xs" variant="subtle" disabled={!edited} onClick={() => setText(original)}>
          Reset
        </Button>
      </Group>
      <Stack gap={4}>
        <Text size="xs" fw={600}>
          Command
        </Text>
        {original === '' ? (
          <Text size="xs" c="dimmed">
            No command recorded
          </Text>
        ) : (
          <>
            <Text size="xs" c="dimmed">
              Edit the command, then press Explain to run the explain on your version.
            </Text>
            {parsed.error === undefined ? null : (
              <Text size="xs" c="red" role="alert">
                {parsed.error}
              </Text>
            )}
            <JsonEditor
              label="Command"
              value={text}
              onChange={setText}
              height={COMMAND_HEIGHT_PX}
            />
          </>
        )}
      </Stack>
      <Stack gap={4}>
        <Text size="xs" fw={600}>
          Metrics
        </Text>
        <SimpleGrid cols={2} spacing={4} verticalSpacing={2}>
          <Metric label="Milliseconds" value={entry.millis} />
          <Metric label="Docs examined" value={entry.docsExamined} />
          <Metric label="Keys examined" value={entry.keysExamined} />
          <Metric label="Returned" value={entry.nreturned} />
          <Metric label="Matched" value={entry.nMatched} />
          <Metric label="Modified" value={entry.nModified} />
          <Metric label="Response bytes" value={entry.responseLength} />
          <Metric label="Plan" value={entry.planSummary} />
          <Metric label="Sort stage" value={entry.hasSortStage} />
          <Metric label="Used disk" value={entry.usedDisk} />
          <Metric label="Query hash" value={entry.queryHash} />
          <Metric label="Plan cache key" value={entry.planCacheKey} />
          <Metric label="Client" value={entry.client} />
          <Metric label="App" value={entry.appName} />
          <Metric label="User" value={entry.user} />
          <Metric label="Error code" value={entry.errCode} />
        </SimpleGrid>
      </Stack>
      <Accordion variant="contained" multiple={false}>
        <Accordion.Item value="locks">
          <Accordion.Control>Locks</Accordion.Control>
          <Accordion.Panel>
            <Code block fz="xs">
              {formatCommand(entry.locks) || 'No lock stats recorded'}
            </Code>
          </Accordion.Panel>
        </Accordion.Item>
        <Accordion.Item value="storage">
          <Accordion.Control>Storage</Accordion.Control>
          <Accordion.Panel>
            <Code block fz="xs">
              {formatCommand(entry.storage) || 'No storage stats recorded'}
            </Code>
          </Accordion.Panel>
        </Accordion.Item>
      </Accordion>
    </Stack>
  );
}

interface MetricProps {
  readonly label: string;
  readonly value: string | number | boolean | undefined;
}

function Metric({ label, value }: MetricProps) {
  const text =
    value === undefined ? '-' : typeof value === 'boolean' ? (value ? 'Yes' : 'No') : String(value);
  return (
    <Box>
      <Text size="xs" c="dimmed">
        {label}
      </Text>
      <Text size="xs" truncate title={text}>
        {text}
      </Text>
    </Box>
  );
}

interface ParsedCommand {
  readonly command?: Record<string, unknown>;
  readonly error?: string;
}

/** The edited command text as an object, or why it cannot be explained. */
function parseCommand(text: string): ParsedCommand {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { error: 'The command is not valid JSON.' };
  }
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? { command: value as Record<string, unknown> }
    : { error: 'The command must be a JSON object.' };
}
