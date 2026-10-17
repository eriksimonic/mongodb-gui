import {
  ActionIcon,
  Alert,
  Badge,
  Button,
  Code,
  Select,
  Stack,
  Switch,
  TextInput,
  Tooltip,
} from '@mantine/core';
import { useVirtualizer } from '@tanstack/react-virtual';
import { IconChevronDown, IconChevronRight, IconCopy, IconSearch } from '@tabler/icons-react';
import type { LogLine, ServerLogKind } from '@mongo-gui/core';
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from 'react';
import { useStore } from 'zustand';
import { copyText } from '../kit/copy';
import { usePolling } from '../kit/use-polling';
import { useProfilerOpener } from '../profiler';
import { CopyIcon, LoadState, Toolbar } from './common';
import type { DiagnosticsStore } from './diagnostics-store';
import { severityStyle } from './log-severity';
import { formatCount } from './format';
import { highlightJson } from './json-highlight';
import { relaxEjson } from './relax-ejson';
import { warningAdvice, warningTitle } from './log-advice';
import {
  componentsOf,
  DEFAULT_LOG_FILTER,
  filterLogLines,
  type LogFilter,
  type MinSeverity,
} from './log-filter';

const AUTO_REFRESH_MS = 5000;
const ROW_HEIGHT_PX = 28;
const WARNING_ROW_HEIGHT_PX = 52;
const ATTRIBUTES_LINE_PX = 18;
const ATTRIBUTES_PADDING_PX = 44;
const OVERSCAN_ROWS = 12;
const NO_LINES: readonly LogLine[] = [];
const GRID_TEMPLATE = '28px 110px 56px 110px minmax(0, 1fr) 36px';
const WARNING_GRID_TEMPLATE = '150px 56px 110px minmax(0, 1fr) 36px';

const LEVEL_OPTIONS: readonly { value: MinSeverity; label: string }[] = [
  { value: 'all', label: 'All levels' },
  { value: 'D', label: 'Debug and above' },
  { value: 'I', label: 'Info and above' },
  { value: 'W', label: 'Warnings and errors' },
  { value: 'E', label: 'Errors only' },
];

export interface LogsTabProps {
  readonly store: DiagnosticsStore;
  readonly connectionId: string;
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
export function LogsTab({ store, connectionId, kind }: LogsTabProps) {
  const state = useStore(store, (current) => current.logs[kind]);
  const loadLog = useStore(store, (current) => current.loadLog);
  const [filter, setFilter] = useState<LogFilter>(DEFAULT_LOG_FILTER);
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [open, setOpen] = useState<ReadonlySet<number>>(new Set());
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void loadLog(kind);
  }, [kind, loadLog]);

  const pollLog = useCallback(() => void loadLog(kind), [kind, loadLog]);
  usePolling(pollLog, autoRefresh && kind === 'global' ? AUTO_REFRESH_MS : undefined);

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

  const estimateRow = (position: number): number =>
    items[position]?.attributes === true
      ? attributesHeight(items[position]?.line)
      : kind === 'startupWarnings'
        ? WARNING_ROW_HEIGHT_PX
        : ROW_HEIGHT_PX;

  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: estimateRow,
    // Measured heights follow the row, not its position, so a collapse leaves no stale height.
    getItemKey: (position) => items[position]?.key ?? position,
    overscan: OVERSCAN_ROWS,
    // An element with no layout, as in a test, keeps its estimated height.
    measureElement: (element) => {
      const height = element.getBoundingClientRect().height;
      return height > 0 ? height : estimateRow(Number(element.getAttribute('data-index')));
    },
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
    <Stack gap="sm" p="md" style={{ flex: 1, minHeight: 0 }}>
      <Toolbar
        loading={state.loading}
        onRefresh={() => void loadLog(kind)}
        status={
          kind === 'startupWarnings'
            ? `Showing ${shown.length} of ${lines.length} · logged once at server start`
            : `${shown.length === lines.length ? '' : `Showing ${shown.length} of `}${formatCount(lines.length)} lines${state.data === undefined ? '' : ` · ${formatCount(state.data.total)} written`}`
        }
      >
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
          leftSection={<IconSearch size={14} />}
          value={filter.text}
          onChange={(event) => setFilter({ ...filter, text: event.currentTarget.value })}
          w={300}
          size="xs"
        />
        {kind === 'global' ? (
          <Switch
            label="Auto refresh 5 s"
            aria-label="Auto refresh every 5 seconds"
            checked={autoRefresh}
            onChange={(event) => setAutoRefresh(event.currentTarget.checked)}
            size="xs"
          />
        ) : null}
      </Toolbar>
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
                style={{
                  ...rowStyle(kind),
                  fontWeight: 600,
                  color: 'var(--mg-text-muted)',
                  fontSize: 'calc(var(--mg-font-scale, 1) * 12px)',
                }}
              >
                {kind === 'global' ? <span /> : null}
                <span>Time</span>
                <span>Level</span>
                <span>Component</span>
                <span>{kind === 'global' ? 'Message' : 'Warning'}</span>
                <span />
              </div>
              <div
                ref={scrollRef}
                role="grid"
                aria-label="Server log lines"
                className="mg-virtual-scroll"
                style={{ flex: 1, minHeight: 240, overflow: 'auto', position: 'relative' }}
              >
                <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
                  {virtualizer.getVirtualItems().map((virtualRow) => {
                    const item = items[virtualRow.index];
                    if (item === undefined) {
                      return null;
                    }
                    return (
                      <div
                        key={item.key}
                        ref={virtualizer.measureElement}
                        data-index={virtualRow.index}
                        style={{
                          position: 'absolute',
                          top: 0,
                          left: 0,
                          width: '100%',
                          transform: `translateY(${virtualRow.start}px)`,
                        }}
                      >
                        <LogRow
                          item={item}
                          kind={kind}
                          connectionId={connectionId}
                          expanded={open.has(item.index)}
                          onToggle={toggle}
                          style={item.attributes ? {} : { height: estimateRow(virtualRow.index) }}
                        />
                      </div>
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

function rowStyle(kind: ServerLogKind): CSSProperties {
  return {
    display: 'grid',
    gridTemplateColumns: kind === 'global' ? GRID_TEMPLATE : WARNING_GRID_TEMPLATE,
    alignItems: 'center',
    columnGap: 8,
    padding: '0 12px',
    fontSize: 'calc(var(--mg-font-scale, 1) * 12px)',
  };
}

/** The attributes as plain JSON text, with numbers and dates relaxed from their EJSON form. */
function attributesText(line: LogLine): string {
  return JSON.stringify(relaxEjson(line.attributes), null, 2) ?? '';
}

/** A first guess at the height of an attributes row. The list measures the real height. */
function attributesHeight(line: LogLine | undefined): number {
  const lines = line === undefined ? 1 : attributesText(line).split('\n').length;
  return lines * ATTRIBUTES_LINE_PX + ATTRIBUTES_PADDING_PX;
}

/** Time of day for the running log. A startup warning has a date, since it is old. */
function timeOf(iso: string | undefined, kind: ServerLogKind): string {
  if (iso === undefined) {
    return '';
  }
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return iso;
  }
  return kind === 'global'
    ? date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' })
    : date.toLocaleString([], {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      });
}

interface LogRowProps {
  readonly item: ListItem;
  readonly kind: ServerLogKind;
  readonly connectionId: string;
  readonly expanded: boolean;
  readonly onToggle: (index: number) => void;
  readonly style: CSSProperties;
}

/** The database of a namespace such as "shop.orders", when the attributes name one. */
function databaseOf(attributes: unknown): string | undefined {
  const ns = (attributes as { ns?: unknown } | undefined)?.ns;
  return typeof ns === 'string' && ns.includes('.') ? ns.slice(0, ns.indexOf('.')) : undefined;
}

/** One line, or the attributes of a line. Memoised, so a refresh does not repaint unchanged rows. */
const LogRow = memo(function LogRow({
  item,
  kind,
  connectionId,
  expanded,
  onToggle,
  style,
}: LogRowProps) {
  const profiler = useProfilerOpener();
  const { line, index } = item;
  if (item.attributes) {
    const json = attributesText(line);
    const database = databaseOf(line.attributes);
    return (
      <div
        role="row"
        style={{
          ...style,
          ...rowStyle(kind),
          gridTemplateColumns: 'minmax(0, 1fr) 180px',
          alignItems: 'start',
          columnGap: 16,
          paddingTop: 10,
          paddingBottom: 10,
          background: 'var(--mg-surface-2)',
        }}
      >
        <Code
          block
          fz="xs"
          aria-label="Attributes"
          style={{
            whiteSpace: 'pre-wrap',
            overflowWrap: 'anywhere',
            background: 'var(--mg-surface-1)',
            border: '1px solid var(--mg-border)',
            borderRadius: 6,
            padding: '10px 12px',
            marginLeft: 28,
          }}
        >
          {highlightJson(json)}
        </Code>
        <Stack gap={6}>
          <Button
            size="xs"
            variant="default"
            fullWidth
            justify="flex-start"
            leftSection={<IconCopy size={14} />}
            onClick={() => void copyText(json, 'Copied')}
          >
            Copy as JSON
          </Button>
          {database === undefined || profiler === undefined ? null : (
            <Button
              size="xs"
              variant="default"
              onClick={() => profiler.open(connectionId, database)}
            >
              Show in profiler
            </Button>
          )}
        </Stack>
      </div>
    );
  }
  const severity = severityStyle(line.severity);
  const warning = kind === 'startupWarnings';
  const advice = warning ? warningAdvice(line.message) : undefined;
  return (
    <div
      role="row"
      style={{
        ...style,
        ...rowStyle(kind),
        borderBottom: '1px solid var(--mg-border)',
        background: expanded
          ? 'var(--mg-surface-2)'
          : severity.tint
            ? `var(--mantine-color-${severity.color}-light)`
            : undefined,
        borderLeft: warning ? '3px solid var(--mg-warn)' : undefined,
      }}
    >
      {warning ? null : line.attributes === undefined ? (
        <span />
      ) : (
        <ActionIcon
          variant="transparent"
          color="gray"
          size="xs"
          aria-label={expanded ? 'Hide attributes' : 'Show attributes'}
          aria-expanded={expanded}
          onClick={() => onToggle(index)}
        >
          {expanded ? <IconChevronDown size={12} /> : <IconChevronRight size={12} />}
        </ActionIcon>
      )}
      <span role="gridcell" style={{ color: 'var(--mg-text-muted)' }}>
        {timeOf(line.ts, kind)}
      </span>
      <span role="gridcell">
        {line.severity === undefined ? null : (
          <Tooltip label={severity.label} withArrow>
            <Badge size="xs" variant="light" color={severity.color} radius="sm" h={18} px={6}>
              {line.severity}
            </Badge>
          </Tooltip>
        )}
      </span>
      <span role="gridcell">
        {line.component === undefined || line.component === '-' ? null : (
          <Badge size="xs" variant="light" color="gray" radius="sm" h={18} px={6}>
            {line.component}
          </Badge>
        )}
      </span>
      <span
        role="gridcell"
        style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
      >
        {warning ? warningTitle(line.message) : line.message}
        {advice === undefined ? null : (
          <span style={{ display: 'block', color: 'var(--mg-text-muted)' }}>{advice}</span>
        )}
      </span>
      <CopyIcon text={line.raw} label="Copy line" />
    </div>
  );
});
