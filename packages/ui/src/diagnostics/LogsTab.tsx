import {
  ActionIcon,
  Alert,
  Code,
  Group,
  Loader,
  Select,
  Stack,
  Switch,
  Table,
  Text,
  TextInput,
} from '@mantine/core';
import { IconChevronDown, IconChevronRight } from '@tabler/icons-react';
import type { LogLine, ServerLogKind } from '@mongo-gui/core';
import { Fragment, useEffect, useMemo, useState } from 'react';
import { useStore } from 'zustand';
import { CopyIcon, LoadState, RefreshButton } from './common';
import type { DiagnosticsStore } from './diagnostics-store';
import {
  componentsOf,
  DEFAULT_LOG_FILTER,
  filterLogLines,
  type LogFilter,
  type MinSeverity,
} from './log-filter';
import { formatTimestamp } from './format';

const AUTO_REFRESH_MS = 5000;
const NO_LINES: readonly LogLine[] = [];

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

/** The global log or the startup warnings. Newest lines first, with a filter bar on top. */
export function LogsTab({ store, kind }: LogsTabProps) {
  const state = useStore(store, (current) => current.logs[kind]);
  const loadLog = useStore(store, (current) => current.loadLog);
  const [filter, setFilter] = useState<LogFilter>(DEFAULT_LOG_FILTER);
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [open, setOpen] = useState<ReadonlySet<number>>(new Set());

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

  function toggle(index: number) {
    setOpen((current) => {
      const next = new Set(current);
      if (next.has(index)) {
        next.delete(index);
      } else {
        next.add(index);
      }
      return next;
    });
  }

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
            <Table withTableBorder verticalSpacing={2} fz="xs" layout="fixed" striped>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th w={28} />
                  <Table.Th w={170}>Time</Table.Th>
                  <Table.Th w={64}>Severity</Table.Th>
                  <Table.Th w={130}>Component</Table.Th>
                  <Table.Th>Message</Table.Th>
                  <Table.Th w={40} />
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {shown.map(({ index, line }) => {
                  const expanded = open.has(index);
                  return (
                    <Fragment key={index}>
                      <Table.Tr>
                        <Table.Td>
                          {line.attributes === undefined ? null : (
                            <ActionIcon
                              variant="subtle"
                              size="xs"
                              aria-label={expanded ? 'Hide attributes' : 'Show attributes'}
                              aria-expanded={expanded}
                              onClick={() => toggle(index)}
                            >
                              {expanded ? (
                                <IconChevronDown size={12} />
                              ) : (
                                <IconChevronRight size={12} />
                              )}
                            </ActionIcon>
                          )}
                        </Table.Td>
                        <Table.Td>{formatTimestamp(line.ts)}</Table.Td>
                        <Table.Td>{line.severity ?? ''}</Table.Td>
                        <Table.Td>{line.component ?? ''}</Table.Td>
                        <Table.Td style={{ wordBreak: 'break-word' }}>{line.message}</Table.Td>
                        <Table.Td>
                          <CopyIcon text={line.raw} label="Copy line" />
                        </Table.Td>
                      </Table.Tr>
                      {expanded ? (
                        <Table.Tr>
                          <Table.Td colSpan={6}>
                            <Code block fz="xs">
                              {JSON.stringify(line.attributes, null, 2)}
                            </Code>
                          </Table.Td>
                        </Table.Tr>
                      ) : null}
                    </Fragment>
                  );
                })}
              </Table.Tbody>
            </Table>
          )
        }
      </LoadState>
    </Stack>
  );
}
