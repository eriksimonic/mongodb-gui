import {
  ActionIcon,
  Alert,
  Code,
  Group,
  Loader,
  Select,
  Stack,
  Switch,
  Text,
  TextInput,
} from '@mantine/core';
import { useVirtualizer } from '@tanstack/react-virtual';
import { IconChevronDown, IconChevronRight } from '@tabler/icons-react';
import type { LogLine, ServerLogKind } from '@mongo-gui/core';
import { memo, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { useStore } from 'zustand';
import { CopyIcon, LoadState, RefreshButton } from './common';
import type { DiagnosticsStore } from './diagnostics-store';
import { formatTimestamp } from './format';
import {
  componentsOf,
  DEFAULT_LOG_FILTER,
  filterLogLines,
  type LogFilter,
  type MinSeverity,
} from './log-filter';

const AUTO_REFRESH_MS = 5000;
const ROW_HEIGHT_PX = 28;
const ATTRIBUTES_HEIGHT_PX = 160;
const OVERSCAN_ROWS = 12;
const NO_LINES: readonly LogLine[] = [];
const GRID_TEMPLATE = '28px 170px 64px 130px minmax(0, 1fr) 36px';

const LEVEL_OPTIONS: readonly { value: MinSeverity; label: string }[] = [
  { value: 'all', label: 'All levels' },
  { value: 'D', label: 'Debug and above' },
  { value: 'I', label: 'Info and above' },
  { value: 'W', label: 'Warnings and errors' },
  { value: 'E', label: 'Errors only' },
];

export interface LogsTabProps {
  readonly store: DiagnosticsStore;
  readonly kind: ServerLogKind;
}

/** One row of the virtual list: a log line, or the attributes of a line that is expanded. */
interface ListItem {
  readonly key: string;
  readonly index: number;
  readonly line: LogLine;
  readonly attributes: boolean;
}

/** The global log or the startup warnings. Newest lines first, with a filter bar on top. */
export function LogsTab({ store, kind }: LogsTabProps) {
  const state = useStore(store, (current) => current.logs[kind]);
  const loadLog = useStore(store, (current) => current.loadLog);
  const [filter, setFilter] = useState<LogFilter>(DEFAULT_LOG_FILTER);
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [open, setOpen] = useState<ReadonlySet<number>>(new Set());
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void loadLog(kind);
  }, [kind, loadLog]);

  useEffect(() => {
    if (!autoRefresh || kind !== 'global') {
      return undefined;
    }
    const timer = setInterval(() => void loadLog(kind), AUTO_REFRESH_MS);
    return () => clearInterval(timer);
  }, [autoRefresh, kind, loadLog]);

  const lines = state.data?.lines ?? NO_LINES;
  const components = useMemo(() => componentsOf(lines), [lines]);
  const shown = useMemo(() => filterLogLines(lines, filter), [lines, filter]);
  const items = useMemo<ListItem[]>(() => {
    const list: ListItem[] = [];
    for (const { index, line } of shown) {
      list.push({ key: `line-${index}`, index, line, attributes: false });
      if (open.has(index)) {
        list.push({ key: `attr-${index}`, index, line, attributes: true });
      }
    }
    return list;
  }, [shown, open]);

  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (position) =>
      items[position]?.attributes === true ? ATTRIBUTES_HEIGHT_PX : ROW_HEIGHT_PX,
    overscan: OVERSCAN_ROWS,
  });

  const toggle = useCallback((index: number) => {
    setOpen((current) => {
      const next = new Set(current);
      if (next.has(index)) {
        next.delete(index);
      } else {
        next.add(index);
      }
      return next;
    });
  }, []);

  return (
    <Stack gap="xs" p="sm">
      <Group gap="xs" align="flex-end" wrap="wrap">
        <Select
          aria-label="Level"
          data={LEVEL_OPTIONS.map((option) => ({ value: option.value, label: option.label }))}
          value={filter.minSeverity}
          onChange={(value) =>
            setFilter({ ...filter, minSeverity: (value ?? 'all') as MinSeverity })
          }
          allowDeselect={false}
          w={170}
          size="xs"
        />
        <Select
          aria-label="Component"
          data={[
            { value: 'all', label: 'All components' },
            ...components.map((name) => ({ value: name, label: name })),
          ]}
          value={filter.component}
          onChange={(value) => setFilter({ ...filter, component: value ?? 'all' })}
          allowDeselect={false}
          searchable
          w={190}
          size="xs"
        />
        <TextInput
          aria-label="Search log"
          placeholder="Search message or attributes"
          value={filter.text}
          onChange={(event) => setFilter({ ...filter, text: event.currentTarget.value })}
          w={260}
          size="xs"
        />
        {kind === 'global' ? (
          <Switch
            label="Auto refresh (5 s)"
            aria-label="Auto refresh every 5 seconds"
            checked={autoRefresh}
            onChange={(event) => setAutoRefresh(event.currentTarget.checked)}
            size="xs"
          />
        ) : null}
        <RefreshButton loading={state.loading} onRefresh={() => void loadLog(kind)} />
        {state.loading && state.data !== undefined ? <Loader size="xs" /> : null}
      </Group>
      <Text size="xs" c="dimmed">
        Showing {shown.length} of {lines.length} lines
        {state.data === undefined ? '' : `, ${state.data.total} written since start`}
      </Text>
      <LoadState state={state}>
        {() =>
          shown.length === 0 ? (
            <Alert variant="light" color="gray">
              No log lines match the filter.
            </Alert>
          ) : (
            <>
              <div
                role="row"
                className="mg-log-head"
                style={{ ...rowStyle(), fontWeight: 600, fontSize: 12 }}
              >
                <span />
                <span>Time</span>
                <span>Severity</span>
                <span>Component</span>
                <span>Message</span>
                <span />
              </div>
              <div
                ref={scrollRef}
                role="grid"
                aria-label="Server log lines"
                className="mg-virtual-scroll"
                style={{ height: 'min(70vh, 640px)', overflow: 'auto', position: 'relative' }}
              >
                <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
                  {virtualizer.getVirtualItems().map((virtualRow) => {
                    const item = items[virtualRow.index];
                    if (item === undefined) {
                      return null;
                    }
                    return (
                      <LogRow
                        key={item.key}
                        item={item}
                        expanded={open.has(item.index)}
                        onToggle={toggle}
                        style={{
                          position: 'absolute',
                          top: 0,
                          left: 0,
                          width: '100%',
                          height: virtualRow.size,
                          transform: `translateY(${virtualRow.start}px)`,
                        }}
                      />
                    );
                  })}
                </div>
              </div>
            </>
          )
        }
      </LoadState>
    </Stack>
  );
}

function rowStyle(): CSSProperties {
  return {
    display: 'grid',
    gridTemplateColumns: GRID_TEMPLATE,
    alignItems: 'center',
    columnGap: 8,
    padding: '0 6px',
    fontSize: 12,
  };
}

interface LogRowProps {
  readonly item: ListItem;
  readonly expanded: boolean;
  readonly onToggle: (index: number) => void;
  readonly style: CSSProperties;
}

/** One line, or the attributes of a line. Memoised, so a refresh does not repaint unchanged rows. */
const LogRow = memo(function LogRow({ item, expanded, onToggle, style }: LogRowProps) {
  const { line, index } = item;
  if (item.attributes) {
    return (
      <div role="row" style={{ ...style, ...rowStyle(), gridTemplateColumns: '1fr' }}>
        <Code block fz="xs" style={{ maxHeight: ATTRIBUTES_HEIGHT_PX - 12, overflow: 'auto' }}>
          {JSON.stringify(line.attributes, null, 2)}
        </Code>
      </div>
    );
  }
  return (
    <div role="row" style={{ ...style, ...rowStyle() }}>
      {line.attributes === undefined ? (
        <span />
      ) : (
        <ActionIcon
          variant="subtle"
          size="xs"
          aria-label={expanded ? 'Hide attributes' : 'Show attributes'}
          aria-expanded={expanded}
          onClick={() => onToggle(index)}
        >
          {expanded ? <IconChevronDown size={12} /> : <IconChevronRight size={12} />}
        </ActionIcon>
      )}
      <span role="gridcell">{formatTimestamp(line.ts)}</span>
      <span role="gridcell">{line.severity ?? ''}</span>
      <span role="gridcell">{line.component ?? ''}</span>
      <span
        role="gridcell"
        style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
      >
        {line.message}
      </span>
      <CopyIcon text={line.raw} label="Copy line" />
    </div>
  );
});
