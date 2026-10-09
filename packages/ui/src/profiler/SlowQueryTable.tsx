import { Badge, Box, Group, Loader, Table, Text, UnstyledButton } from '@mantine/core';
import { IconChevronDown, IconChevronUp } from '@tabler/icons-react';
import type { KeyboardEvent } from 'react';
import type { ProfileEntry, ProfilingLevel } from '@mongo-gui/core';
import {
  clientLabel,
  durationPercent,
  examinedRatio,
  isCollscan,
  type EntrySort,
  type SortKey,
} from './profiler-model';

export interface SlowQueryTableProps {
  readonly entries: readonly ProfileEntry[];
  readonly selectedId: string | undefined;
  readonly highlighted: readonly string[];
  readonly sort: EntrySort;
  readonly loading: boolean;
  readonly level: ProfilingLevel['level'] | undefined;
  readonly onSelect: (id: string) => void;
  readonly onSort: (key: SortKey) => void;
}

/**
 * The slow query table. Rows are selected by click or with the arrow keys once the table has
 * focus. Rows that arrive through the tail carry a short highlight and keep the selection.
 */
export function SlowQueryTable({
  entries,
  selectedId,
  highlighted,
  sort,
  loading,
  level,
  onSelect,
  onSort,
}: SlowQueryTableProps) {
  const maxMillis = entries.reduce((max, entry) => Math.max(max, entry.millis), 0);

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (entries.length === 0) {
      return;
    }
    const index = entries.findIndex((entry) => entry.id === selectedId);
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
      tabIndex={0}
      aria-label="Slow operations"
      className="mg-profiler-table"
      onKeyDown={handleKeyDown}
    >
      <Table
        highlightOnHover={false}
        verticalSpacing={4}
        horizontalSpacing={8}
        fz="xs"
        withTableBorder={false}
      >
        <Table.Thead>
          <Table.Tr>
            <SortableHeader label="Time" sortKey="time" sort={sort} onSort={onSort} />
            <Table.Th>Namespace</Table.Th>
            <Table.Th>Op</Table.Th>
            <SortableHeader label="Duration" sortKey="duration" sort={sort} onSort={onSort} />
            <Table.Th>Docs examined</Table.Th>
            <Table.Th>Returned</Table.Th>
            <Table.Th>Examined per returned</Table.Th>
            <Table.Th>Plan</Table.Th>
            <Table.Th>Client or app</Table.Th>
            <Table.Th>Error</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {entries.map((entry) => {
            const selected = entry.id === selectedId;
            const ratio = examinedRatio(entry);
            return (
              <Table.Tr
                key={entry.id}
                className="mg-profiler-row"
                data-selected={selected ? 'true' : undefined}
                data-highlight={highlighted.includes(entry.id) ? 'true' : undefined}
                aria-selected={selected}
                onClick={() => onSelect(entry.id)}
                style={{ cursor: 'pointer' }}
              >
                <Table.Td style={{ whiteSpace: 'nowrap' }}>{formatTime(entry.ts)}</Table.Td>
                <Table.Td>{entry.ns}</Table.Td>
                <Table.Td style={{ whiteSpace: 'nowrap', width: 1 }}>
                  <Badge
                    variant="light"
                    size="xs"
                    color="gray"
                    style={{ maxWidth: 'none', minWidth: 'max-content' }}
                  >
                    {entry.op}
                  </Badge>
                </Table.Td>
                <Table.Td>
                  <Group gap={6} wrap="nowrap">
                    <Text size="xs" ta="right" w={64} style={{ whiteSpace: 'nowrap' }}>
                      {entry.millis} ms
                    </Text>
                    <Box className="mg-profiler-bar-track">
                      <Box
                        className="mg-profiler-bar"
                        data-testid="duration-bar"
                        style={{ width: `${durationPercent(entry.millis, maxMillis)}%` }}
                      />
                    </Box>
                  </Group>
                </Table.Td>
                <Table.Td>{entry.docsExamined ?? '-'}</Table.Td>
                <Table.Td>{entry.nreturned ?? '-'}</Table.Td>
                <Table.Td>{ratio === undefined ? '-' : ratio.toFixed(1)}</Table.Td>
                <Table.Td>
                  <Group gap={4} wrap="nowrap">
                    {isCollscan(entry.planSummary) ? (
                      <Badge color="red" variant="filled" size="xs">
                        COLLSCAN
                      </Badge>
                    ) : null}
                    <Text size="xs" truncate maw={220} title={entry.planSummary}>
                      {entry.planSummary ?? '-'}
                    </Text>
                  </Group>
                </Table.Td>
                <Table.Td>{clientLabel(entry)}</Table.Td>
                <Table.Td>
                  {entry.errMsg === undefined ? null : (
                    <Badge color="red" variant="light" size="xs" title={entry.errMsg}>
                      Error
                    </Badge>
                  )}
                </Table.Td>
              </Table.Tr>
            );
          })}
        </Table.Tbody>
      </Table>
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
    <Table.Th aria-sort={ariaSort}>
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
    </Table.Th>
  );
}

/** Local time with seconds and milliseconds, the precision the tail works at. */
function formatTime(iso: string): string {
  const date = new Date(iso);
  const time = date.toLocaleTimeString(undefined, { hour12: false });
  return `${time}.${String(date.getMilliseconds()).padStart(3, '0')}`;
}
