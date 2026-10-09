import { Badge, Box, Group, Loader, Text, UnstyledButton } from '@mantine/core';
import { IconChevronDown, IconChevronUp } from '@tabler/icons-react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { memo, useEffect, useMemo, useRef, type KeyboardEvent } from 'react';
import type { ProfileEntry, ProfilingLevel } from '@mongo-gui/core';
import {
  clientLabel,
  durationPercent,
  examinedRatio,
  formatLocalTime,
  isCollscan,
  type EntrySort,
  type SortKey,
} from './profiler-model';
import type { ProfilerColumns } from './profiler-store';

/** Every row is this tall. Fixed heights keep the virtualiser exact and rows from wrapping. */
const ROW_HEIGHT_PX = 32;
const OVERSCAN_ROWS = 12;

/** Column tracks in order. The plan column takes the remaining width. */
const BASE_TRACKS = [
  '92px',
  '140px',
  '70px',
  '110px',
  '64px',
  '62px',
  '66px',
  'minmax(110px, 1fr)',
];
const CLIENT_TRACK = '140px';
const ERROR_TRACK = '64px';
/** The narrowest the grid may get before it scrolls sideways. */
const BASE_MIN_WIDTH_PX = 790;
const EXTRA_MIN_WIDTH_PX = 210;

export interface SlowQueryTableProps {
  readonly entries: readonly ProfileEntry[];
  readonly selectedId: string | undefined;
  readonly highlighted: ReadonlySet<string>;
  readonly sort: EntrySort;
  readonly loading: boolean;
  readonly level: ProfilingLevel['level'] | undefined;
  readonly columns: ProfilerColumns;
  readonly onSelect: (id: string) => void;
  readonly onSort: (key: SortKey) => void;
}

function gridTemplate(columns: ProfilerColumns): string {
  const tracks = [...BASE_TRACKS];
  if (columns.client) {
    tracks.push(CLIENT_TRACK);
  }
  if (columns.error) {
    tracks.push(ERROR_TRACK);
  }
  return tracks.join(' ');
}

function minWidthPx(columns: ProfilerColumns): number {
  let width = BASE_MIN_WIDTH_PX;
  if (columns.client) {
    width += 140;
  }
  if (columns.error) {
    width += EXTRA_MIN_WIDTH_PX - 140;
  }
  return width;
}

/**
 * The slow query table. Rows are virtualised at a fixed height. Keyboard navigation moves the
 * selection with the arrow keys, and the selected row is scrolled into view. Rows that arrived
 * through the tail carry a short highlight.
 */
export function SlowQueryTable({
  entries,
  selectedId,
  highlighted,
  sort,
  loading,
  level,
  columns,
  onSelect,
  onSort,
}: SlowQueryTableProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const template = useMemo(() => gridTemplate(columns), [columns]);
  const width = minWidthPx(columns);
  const maxMillis = useMemo(
    () => entries.reduce((max, entry) => Math.max(max, entry.millis), 0),
    [entries],
  );
  const selectedIndex = useMemo(
    () => entries.findIndex((entry) => entry.id === selectedId),
    [entries, selectedId],
  );
  const indexRef = useRef(selectedIndex);
  indexRef.current = selectedIndex;

  const virtualizer = useVirtualizer({
    count: entries.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT_PX,
    overscan: OVERSCAN_ROWS,
  });

  // Scroll only when the selection changes. A tail that prepends rows must not move the view.
  useEffect(() => {
    const index = indexRef.current;
    if (index >= 0) {
      virtualizer.scrollToIndex(index, { align: 'auto' });
    }
  }, [selectedId, virtualizer]);

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (entries.length === 0) {
      return;
    }
    const index = selectedIndex;
    let next: number | undefined;
    if (event.key === 'ArrowDown') {
      next = Math.min(entries.length - 1, index + 1);
    } else if (event.key === 'ArrowUp') {
      next = index <= 0 ? 0 : index - 1;
    } else if (event.key === 'Home') {
      next = 0;
    } else if (event.key === 'End') {
      next = entries.length - 1;
    }
    if (next !== undefined) {
      event.preventDefault();
      const target = entries[next];
      if (target !== undefined) {
        onSelect(target.id);
      }
    }
  }

  if (entries.length === 0) {
    return (
      <Box p={12}>
        {loading ? (
          <Group gap={8}>
            <Loader size="xs" aria-label="Loading operations" />
            <Text size="sm" c="dimmed">
              Loading operations
            </Text>
          </Group>
        ) : (
          <Text size="sm" c="dimmed">
            {level === 0
              ? 'Profiling is off. Set the level to Slow only or All to record operations.'
              : 'No operations match these filters.'}
          </Text>
        )}
      </Box>
    );
  }

  return (
    <div
      ref={scrollRef}
      role="grid"
      aria-label="Slow operations"
      aria-rowcount={entries.length + 1}
      tabIndex={0}
      className="mg-profiler-scroll"
      onKeyDown={handleKeyDown}
    >
      <div style={{ minWidth: width }}>
        <div role="row" className="mg-profiler-head" style={{ gridTemplateColumns: template }}>
          <SortableHeader label="Time" sortKey="time" sort={sort} onSort={onSort} />
          <HeaderCell>Namespace</HeaderCell>
          <HeaderCell>Op</HeaderCell>
          <SortableHeader label="Duration" sortKey="duration" sort={sort} onSort={onSort} />
          <HeaderCell title="Documents examined">Examined</HeaderCell>
          <HeaderCell title="Documents returned">Returned</HeaderCell>
          <HeaderCell title="Documents examined per document returned">Ratio</HeaderCell>
          <HeaderCell>Plan</HeaderCell>
          {columns.client ? <HeaderCell>Client or app</HeaderCell> : null}
          {columns.error ? <HeaderCell>Error</HeaderCell> : null}
        </div>
        <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
          {virtualizer.getVirtualItems().map((item) => {
            const entry = entries[item.index];
            if (entry === undefined) {
              return null;
            }
            return (
              <SlowQueryRow
                key={entry.id}
                entry={entry}
                index={item.index}
                top={item.start}
                template={template}
                selected={entry.id === selectedId}
                highlighted={highlighted.has(entry.id)}
                maxMillis={maxMillis}
                columns={columns}
                onSelect={onSelect}
              />
            );
          })}
        </div>
      </div>
    </div>
  );
}

interface SlowQueryRowProps {
  readonly entry: ProfileEntry;
  readonly index: number;
  readonly top: number;
  readonly template: string;
  readonly selected: boolean;
  readonly highlighted: boolean;
  readonly maxMillis: number;
  readonly columns: ProfilerColumns;
  readonly onSelect: (id: string) => void;
}

/**
 * One table row. Memoised on its own props, so selecting a row or a tail batch re-renders only
 * the rows whose selection or highlight changed.
 */
const SlowQueryRow = memo(function SlowQueryRow({
  entry,
  index,
  top,
  template,
  selected,
  highlighted,
  maxMillis,
  columns,
  onSelect,
}: SlowQueryRowProps) {
  const ratio = examinedRatio(entry);
  return (
    <div
      role="row"
      aria-rowindex={index + 2}
      aria-selected={selected}
      data-row-index={index}
      data-highlight={highlighted ? 'true' : undefined}
      className="mg-profiler-row"
      style={{ gridTemplateColumns: template, transform: `translateY(${top}px)` }}
      onClick={() => onSelect(entry.id)}
    >
      <div role="gridcell" className="mg-profiler-cell">
        {formatLocalTime(entry.ts)}
      </div>
      <div role="gridcell" className="mg-profiler-cell" title={entry.ns}>
        {entry.ns}
      </div>
      <div role="gridcell" className="mg-profiler-cell">
        <Badge variant="light" size="xs" color="gray" style={{ flexShrink: 0, maxWidth: 'none' }}>
          {entry.op}
        </Badge>
      </div>
      <div role="gridcell" className="mg-profiler-cell">
        <span className="mg-profiler-duration">
          <span className="mg-profiler-duration-label">{entry.millis} ms</span>
          <span className="mg-profiler-bar-track">
            <span
              className="mg-profiler-bar"
              data-testid="duration-bar"
              style={{ width: `${durationPercent(entry.millis, maxMillis)}%` }}
            />
          </span>
        </span>
      </div>
      <div role="gridcell" className="mg-profiler-cell">
        {entry.docsExamined ?? '-'}
      </div>
      <div role="gridcell" className="mg-profiler-cell">
        {entry.nreturned ?? '-'}
      </div>
      <div role="gridcell" className="mg-profiler-cell">
        {ratio === undefined ? '-' : ratio.toFixed(1)}
      </div>
      <div role="gridcell" className="mg-profiler-cell mg-profiler-plan" title={entry.planSummary}>
        {isCollscan(entry.planSummary) ? (
          <Badge color="red" variant="filled" size="xs" style={{ flexShrink: 0, maxWidth: 'none' }}>
            COLLSCAN
          </Badge>
        ) : null}
        <span className="mg-profiler-cell">{entry.planSummary ?? '-'}</span>
      </div>
      {columns.client ? (
        <div role="gridcell" className="mg-profiler-cell" title={clientLabel(entry)}>
          {clientLabel(entry)}
        </div>
      ) : null}
      {columns.error ? (
        <div role="gridcell" className="mg-profiler-cell">
          {entry.errMsg === undefined ? null : (
            <Badge
              color="red"
              variant="light"
              size="xs"
              title={entry.errMsg}
              style={{ maxWidth: 'none' }}
            >
              Error
            </Badge>
          )}
        </div>
      ) : null}
    </div>
  );
});

function HeaderCell({ children, title }: { readonly children: string; readonly title?: string }) {
  return (
    <div role="columnheader" className="mg-profiler-cell" title={title}>
      <Text size="xs" fw={600} span>
        {children}
      </Text>
    </div>
  );
}

interface SortableHeaderProps {
  readonly label: string;
  readonly sortKey: SortKey;
  readonly sort: EntrySort;
  readonly onSort: (key: SortKey) => void;
}

function SortableHeader({ label, sortKey, sort, onSort }: SortableHeaderProps) {
  const active = sort.key === sortKey;
  const ariaSort = active ? (sort.direction === 'asc' ? 'ascending' : 'descending') : 'none';
  return (
    <div role="columnheader" aria-sort={ariaSort} className="mg-profiler-cell">
      <UnstyledButton onClick={() => onSort(sortKey)} aria-label={`Sort by ${label.toLowerCase()}`}>
        <Group gap={2} wrap="nowrap">
          <Text size="xs" fw={600}>
            {label}
          </Text>
          {active ? (
            sort.direction === 'asc' ? (
              <IconChevronUp size={12} aria-hidden="true" />
            ) : (
              <IconChevronDown size={12} aria-hidden="true" />
            )
          ) : null}
        </Group>
      </UnstyledButton>
    </div>
  );
}
