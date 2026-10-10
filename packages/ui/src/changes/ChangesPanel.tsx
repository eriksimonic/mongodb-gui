import {
  Alert,
  Badge,
  Box,
  Button,
  Flex,
  Group,
  SegmentedControl,
  Select,
  Stack,
  Text,
  TextInput,
} from '@mantine/core';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { ChangeTarget, ChangeWatchPushPhase } from '@mongo-gui/core';
import { useEffect, useMemo, useRef, type KeyboardEvent } from 'react';
import { JsonEditor } from '../editor/JsonEditor';
import { ChangeDetail } from './ChangeDetail';
import { useChangesStore } from './changes-store-context';
import type { ChangesPanelState, ChangesSeed } from './changes-store';
import {
  FULL_DOCUMENT_BEFORE_LABELS,
  FULL_DOCUMENT_LABELS,
  namespaceText,
  operationColor,
  targetKeyOf,
  targetLabelOf,
  visibleRows,
  wallTimeText,
  type ChangeOrder,
  type ChangeRow,
  type FullDocumentBeforeMode,
  type FullDocumentMode,
} from './changes-model';

const ROW_HEIGHT_PX = 30;
const OVERSCAN_ROWS = 12;
const PIPELINE_HEIGHT_PX = 96;
const DETAIL_WIDTH_PX = 420;

const PHASE_LABELS: Readonly<Record<ChangeWatchPushPhase | 'idle', string>> = {
  idle: 'Not started',
  opening: 'Opening',
  live: 'Live',
  paused: 'Paused',
  resuming: 'Resuming',
  error: 'Error',
  closed: 'Closed',
};

const PHASE_COLORS: Readonly<Record<ChangeWatchPushPhase | 'idle', string>> = {
  idle: 'gray',
  opening: 'blue',
  live: 'teal',
  paused: 'yellow',
  resuming: 'blue',
  error: 'red',
  closed: 'gray',
};

export interface ChangesPanelProps {
  readonly panelId: string;
  readonly connectionId: string;
  readonly target: ChangeTarget;
  /** Startup values for stories and tests. The panel reads them once, when it opens. */
  readonly seed?: ChangesSeed | undefined;
}

/**
 * The change stream of one deployment, database or collection. The panel opens its state on
 * mount and stops its watch on unmount, so closing the panel ends the watch.
 */
export function ChangesPanel({ panelId, connectionId, target, seed }: ChangesPanelProps) {
  const open = useChangesStore((state) => state.open);
  const close = useChangesStore((state) => state.close);
  const panel = useChangesStore((state) => state.panels[panelId]);
  const targetRef = useRef(target);
  const seedRef = useRef(seed);
  const targetKey = targetKeyOf(target);

  useEffect(() => {
    open(panelId, connectionId, targetRef.current, seedRef.current);
    return () => {
      void close(panelId);
    };
  }, [panelId, connectionId, targetKey, open, close]);

  if (panel === undefined) {
    return (
      <Text size="sm" c="dimmed" p={8}>
        Opening the change stream
      </Text>
    );
  }
  return <ChangesBody panelId={panelId} panel={panel} />;
}

interface ChangesBodyProps {
  readonly panelId: string;
  readonly panel: ChangesPanelState;
}

function ChangesBody({ panelId, panel }: ChangesBodyProps) {
  const setPipeline = useChangesStore((state) => state.setPipeline);
  const setFullDocument = useChangesStore((state) => state.setFullDocument);
  const setFullDocumentBeforeChange = useChangesStore((state) => state.setFullDocumentBeforeChange);
  const setResumeToken = useChangesStore((state) => state.setResumeToken);
  const start = useChangesStore((state) => state.start);
  const pause = useChangesStore((state) => state.pause);
  const resume = useChangesStore((state) => state.resume);
  const stop = useChangesStore((state) => state.stop);
  const resumeFrom = useChangesStore((state) => state.resumeFrom);
  const clear = useChangesStore((state) => state.clear);
  const setOrder = useChangesStore((state) => state.setOrder);
  const setFilter = useChangesStore((state) => state.setFilter);
  const select = useChangesStore((state) => state.select);

  const phase = panel.phase ?? 'idle';
  const hasWatch = panel.watchId !== undefined;
  const startable = hasWatch
    ? phase === 'closed' || phase === 'error'
    : phase !== 'opening' && phase !== 'live' && phase !== 'paused';
  const pausable = hasWatch && (phase === 'live' || phase === 'opening');
  const resumable = hasWatch && phase === 'paused';
  const selected = useMemo(
    () => panel.rows.find((row) => row.key === panel.selectedKey),
    [panel.rows, panel.selectedKey],
  );

  return (
    <Stack gap={8} h="100%" p={8} style={{ minHeight: 0 }}>
      <Group align="flex-end" gap={8} wrap="wrap">
        <TextInput label="Target" size="xs" value={targetLabelOf(panel.target)} readOnly w={240} />
        <Select
          label="Full document"
          size="xs"
          w={170}
          allowDeselect={false}
          value={panel.fullDocument}
          onChange={(value) => {
            if (value !== null) {
              setFullDocument(panelId, value as FullDocumentMode);
            }
          }}
          data={toOptions(FULL_DOCUMENT_LABELS)}
        />
        <Select
          label="Full document before change"
          size="xs"
          w={190}
          allowDeselect={false}
          value={panel.fullDocumentBeforeChange}
          onChange={(value) => {
            if (value !== null) {
              setFullDocumentBeforeChange(panelId, value as FullDocumentBeforeMode);
            }
          }}
          data={toOptions(FULL_DOCUMENT_BEFORE_LABELS)}
        />
        <TextInput
          label="Resume token"
          size="xs"
          placeholder='{"_data": "..."}'
          value={panel.resumeToken}
          error={panel.resumeTokenError}
          onChange={(event) => setResumeToken(panelId, event.currentTarget.value)}
          style={{ flex: 1, minWidth: 220 }}
        />
      </Group>

      <Flex gap={8} align="flex-start" wrap="wrap">
        <Box style={{ flex: 1, minWidth: 320 }}>
          <Text size="xs" fw={500} mb={4}>
            Pipeline
          </Text>
          <JsonEditor
            label="Change stream pipeline"
            value={panel.pipelineText}
            onChange={(value) => setPipeline(panelId, value)}
            height={PIPELINE_HEIGHT_PX}
          />
          {panel.pipelineError === undefined ? null : (
            <Text size="xs" c="red" mt={4}>
              {panel.pipelineError}
            </Text>
          )}
        </Box>
        <Group gap={6} wrap="nowrap">
          <Button size="xs" disabled={!startable} onClick={() => void start(panelId)}>
            Start
          </Button>
          <Button
            size="xs"
            variant="default"
            disabled={!pausable}
            onClick={() => void pause(panelId)}
          >
            Pause
          </Button>
          <Button
            size="xs"
            variant="default"
            disabled={!resumable}
            onClick={() => void resume(panelId)}
          >
            Resume
          </Button>
          <Button
            size="xs"
            variant="default"
            color="red"
            disabled={!hasWatch}
            onClick={() => void stop(panelId)}
          >
            Stop
          </Button>
          <Button size="xs" variant="subtle" onClick={() => clear(panelId)}>
            Clear
          </Button>
        </Group>
      </Flex>

      <Group gap={12} wrap="wrap" aria-label="Change stream state">
        <Badge color={PHASE_COLORS[phase]} variant="light">
          {PHASE_LABELS[phase]}
        </Badge>
        <Text size="xs">Received {panel.eventsSeen}</Text>
        <Text size="xs">Dropped {panel.eventsDropped}</Text>
        {panel.trimmed === 0 ? null : (
          <Text size="xs" c="dimmed">
            Trimmed {panel.trimmed} from the list
          </Text>
        )}
      </Group>
      {panel.error === undefined ? null : (
        <Alert color="red" variant="light" title="The change stream stopped" p="xs">
          {panel.error.message}
          {panel.error.detail === undefined ? null : ` ${panel.error.detail}`}
        </Alert>
      )}

      <Group gap={8} wrap="nowrap" align="flex-end">
        <SegmentedControl
          size="xs"
          aria-label="Event order"
          value={panel.order}
          onChange={(value) => setOrder(panelId, value as ChangeOrder)}
          data={[
            { value: 'newest', label: 'Newest first' },
            { value: 'oldest', label: 'Oldest first' },
          ]}
        />
        <TextInput
          aria-label="Filter events"
          placeholder="Filter by namespace, operation or document key"
          size="xs"
          value={panel.filter}
          onChange={(event) => setFilter(panelId, event.currentTarget.value)}
          style={{ flex: 1 }}
        />
      </Group>

      <Flex style={{ flex: 1, minHeight: 0 }} gap={8}>
        <EventList
          rows={panel.rows}
          order={panel.order}
          filter={panel.filter}
          selectedKey={panel.selectedKey}
          onSelect={(key) => select(panelId, key)}
        />
        <Box
          style={{
            width: DETAIL_WIDTH_PX,
            flex: '0 0 auto',
            minHeight: 0,
            borderLeft: '1px solid var(--mg-border)',
            paddingLeft: 8,
            overflow: 'auto',
          }}
        >
          <ChangeDetail row={selected} onResumeFrom={(key) => void resumeFrom(panelId, key)} />
        </Box>
      </Flex>
    </Stack>
  );
}

interface EventListProps {
  readonly rows: readonly ChangeRow[];
  readonly order: ChangeOrder;
  readonly filter: string;
  readonly selectedKey: string | undefined;
  readonly onSelect: (key: string) => void;
}

/** The events as a virtualised list. Newest first is the default. */
function EventList({ rows, order, filter, selectedKey, onSelect }: EventListProps) {
  const scroller = useRef<HTMLDivElement>(null);
  const visible = useMemo(() => visibleRows(rows, order, filter), [rows, order, filter]);
  const virtualizer = useVirtualizer({
    count: visible.length,
    getScrollElement: () => scroller.current,
    estimateSize: () => ROW_HEIGHT_PX,
    overscan: OVERSCAN_ROWS,
  });

  if (rows.length === 0) {
    return (
      <Text size="sm" c="dimmed" p={8} style={{ flex: 1 }}>
        No events yet. Start the watch, then change a document in its scope.
      </Text>
    );
  }
  if (visible.length === 0) {
    return (
      <Text size="sm" c="dimmed" p={8} style={{ flex: 1 }}>
        No event matches the filter.
      </Text>
    );
  }

  return (
    <Box
      ref={scroller}
      className="mg-virtual-scroll"
      role="listbox"
      aria-label="Change events"
      style={{ flex: 1, minWidth: 0, minHeight: 0, overflow: 'auto', position: 'relative' }}
    >
      <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
        {virtualizer.getVirtualItems().map((item) => {
          const row = visible[item.index];
          if (row === undefined) {
            return null;
          }
          return (
            <EventRow
              key={row.key}
              row={row}
              index={item.index}
              start={item.start}
              selected={row.key === selectedKey}
              onSelect={onSelect}
            />
          );
        })}
      </div>
    </Box>
  );
}

interface EventRowProps {
  readonly row: ChangeRow;
  readonly index: number;
  readonly start: number;
  readonly selected: boolean;
  readonly onSelect: (key: string) => void;
}

function EventRow({ row, index, start, selected, onSelect }: EventRowProps) {
  const { event } = row;
  function onKeyDown(keyEvent: KeyboardEvent<HTMLDivElement>) {
    if (keyEvent.key === 'Enter' || keyEvent.key === ' ') {
      keyEvent.preventDefault();
      onSelect(row.key);
    }
  }
  return (
    <div
      role="option"
      aria-selected={selected}
      tabIndex={0}
      data-row-index={index}
      onClick={() => onSelect(row.key)}
      onKeyDown={onKeyDown}
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        width: '100%',
        height: ROW_HEIGHT_PX,
        transform: `translateY(${start}px)`,
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '0 8px',
        cursor: 'pointer',
        background: selected ? 'var(--mantine-color-default-hover)' : undefined,
      }}
    >
      <Badge
        size="sm"
        variant="light"
        color={operationColor(event.operationType)}
        style={{ flex: '0 0 auto', width: 84 }}
      >
        {event.operationType}
      </Badge>
      <Text size="xs" ff="monospace" truncate style={{ flex: '0 1 220px', minWidth: 0 }}>
        {namespaceText(event) || '-'}
      </Text>
      <Text size="xs" ff="monospace" c="dimmed" truncate style={{ flex: 1, minWidth: 0 }}>
        {event.documentKeyEjson ?? ''}
      </Text>
      <Text size="xs" ff="monospace" c="dimmed" style={{ flex: '0 0 auto' }}>
        {wallTimeText(event.wallTime)}
      </Text>
    </div>
  );
}

function toOptions(labels: Readonly<Record<string, string>>): { value: string; label: string }[] {
  return Object.entries(labels).map(([value, label]) => ({ value, label }));
}
