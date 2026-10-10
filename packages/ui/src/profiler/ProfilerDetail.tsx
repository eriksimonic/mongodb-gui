import {
  Accordion,
  Badge,
  Box,
  Button,
  Code,
  Group,
  SegmentedControl,
  SimpleGrid,
  Stack,
  Text,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import type { ProfileEntry } from '@mongo-gui/core';
import { useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { notifyError } from '../components/notify-error';
import { profilerUiEvents } from './profiler-events';
import {
  formatCommand,
  formatCommandJson,
  formatLocalTime,
  explainTarget,
  isCollscan,
  userCommand,
} from './profiler-model';

type CommandView = 'mongosh' | 'json';

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
          <EntryDetail connectionId={connectionId} database={database} entry={entry} />
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
  // Copy always gives mongosh source. The view toggle only changes what is on screen.
  const [view, setView] = useState<CommandView>('mongosh');
  const command = formatCommand(entry.command);
  const shownCommand = view === 'mongosh' ? command : formatCommandJson(entry.command);

  // Copy and the editor get the command without the driver's session fields.
  const runnable = userCommand(entry.command);
  const runnableText = formatCommand(runnable);
  // A getMore without its originating command, and anything else the explain cannot run, is disabled.
  const explainUnavailable = explainTarget(entry, runnable) === undefined;

  function explain() {
    profilerUiEvents.emit({
      type: 'profiler:explain',
      ref: { connectionId, database, entry, command: runnable },
    });
  }

  function openInEditor() {
    profilerUiEvents.emit({
      type: 'profiler:open',
      ref: { connectionId, database, entry, command: runnable },
    });
    notifications.show({ title: 'Open in editor', message: 'Open in editor arrives in phase 2.' });
  }

  async function copyCommand() {
    try {
      await navigator.clipboard.writeText(runnableText);
      notifications.show({ title: 'Command copied', message: entry.ns, color: 'teal' });
    } catch (error) {
      notifyError(error, 'The command could not be copied');
    }
  }

  return (
    <Stack gap={8}>
      <Stack gap={2}>
        <Group gap={6} wrap="nowrap">
          <Text fw={600} size="sm" truncate>
            {entry.ns}
          </Text>
          <Badge tt="none" variant="light" size="xs" color="gray">
            {entry.op}
          </Badge>
          {isCollscan(entry.planSummary) ? (
            <Badge tt="none" color="red" variant="filled" size="xs">
              COLLSCAN
            </Badge>
          ) : null}
        </Group>
        <Text size="xs" c="dimmed">
          {formatLocalTime(entry.ts)} · {entry.millis} ms
        </Text>
        {entry.errMsg === undefined ? null : (
          <Text size="xs" c="red">
            {entry.errMsg}
          </Text>
        )}
      </Stack>
      <Group gap={6}>
        <Button size="xs" onClick={explain} disabled={explainUnavailable}>
          Explain this
        </Button>
        <Button size="xs" variant="default" onClick={openInEditor}>
          Open in editor
        </Button>
        <Button size="xs" variant="default" onClick={() => void copyCommand()}>
          Copy command
        </Button>
      </Group>
      <Stack gap={4}>
        <Text size="xs" fw={600}>
          Command
        </Text>
        <SegmentedControl
          size="xs"
          aria-label="Command view"
          value={view}
          onChange={(value) => setView(value === 'json' ? 'json' : 'mongosh')}
          data={[
            { label: 'Mongosh', value: 'mongosh' },
            { label: 'JSON', value: 'json' },
          ]}
        />
        <Code block fz="xs" style={{ maxHeight: 240, overflow: 'auto' }}>
          {shownCommand === '' ? 'No command recorded' : shownCommand}
        </Code>
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
