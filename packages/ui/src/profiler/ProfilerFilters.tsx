import { Autocomplete, Button, Group, NumberInput, Select, TextInput } from '@mantine/core';
import { IconSearch } from '@tabler/icons-react';
import type { ProfilerPanelState } from './profiler-store';
import { useProfilerStore } from './profiler-store-context';
import { OP_CHOICES, TIME_RANGES, type OpChoice, type ProfilerFilters } from './profiler-model';

const OP_LABELS: Readonly<Record<OpChoice, string>> = {
  all: 'All operations',
  query: 'query',
  insert: 'insert',
  update: 'update',
  remove: 'remove',
  getmore: 'getmore',
  command: 'command',
  other: 'other',
};

const OP_DATA = OP_CHOICES.map((op) => ({ value: op, label: OP_LABELS[op] }));
const RANGE_DATA = TIME_RANGES.map((range) => ({ value: range.value, label: range.label }));

export interface ProfilerFilterRowProps {
  readonly panelId: string;
  readonly panel: ProfilerPanelState;
  /** The namespaces of the database's collections, offered as suggestions. */
  readonly namespaces: readonly string[];
}

/**
 * The filters of one panel. Edits change the form state at once. The Refresh button runs the
 * query, and a running tail restarts with the new filters.
 */
export function ProfilerFilterRow({ panelId, panel, namespaces }: ProfilerFilterRowProps) {
  const setFilters = useProfilerStore((state) => state.setFilters);
  const refresh = useProfilerStore((state) => state.refresh);
  const filters = panel.filters;

  function patch(change: Partial<ProfilerFilters>) {
    setFilters(panelId, change);
  }

  function numberOrUndefined(value: string | number): number | undefined {
    return typeof value === 'number' ? value : undefined;
  }

  return (
    <Group gap={8} align="flex-end" wrap="wrap">
      <Autocomplete
        label="Namespace"
        placeholder="All collections"
        data={[...namespaces]}
        value={filters.namespace}
        onChange={(value) => patch({ namespace: value })}
        w={200}
      />
      <Select
        label="Operation"
        data={OP_DATA}
        value={filters.op}
        onChange={(value) => {
          const op = OP_CHOICES.find((choice) => choice === value);
          if (op !== undefined) {
            patch({ op });
          }
        }}
        allowDeselect={false}
        w={150}
      />
      <NumberInput
        label="Min duration (ms)"
        min={0}
        value={filters.minMillis ?? ''}
        onChange={(value) => patch({ minMillis: numberOrUndefined(value) })}
        w={130}
      />
      <Select
        label="Time range"
        data={RANGE_DATA}
        value={filters.range}
        onChange={(value) => {
          const range = TIME_RANGES.find((item) => item.value === value);
          if (range !== undefined) {
            patch({ range: range.value });
          }
        }}
        allowDeselect={false}
        w={140}
      />
      {filters.range === 'custom' ? (
        <TextInput
          label="Since"
          type="datetime-local"
          value={filters.since}
          onChange={(event) => patch({ since: event.currentTarget.value })}
          w={190}
        />
      ) : null}
      {filters.range === 'custom' ? (
        <TextInput
          label="Until"
          type="datetime-local"
          value={filters.until}
          onChange={(event) => patch({ until: event.currentTarget.value })}
          w={190}
        />
      ) : null}
      <TextInput
        label="Text search"
        placeholder="Command, plan or error"
        leftSection={<IconSearch size={14} aria-hidden="true" />}
        value={filters.textSearch}
        onChange={(event) => patch({ textSearch: event.currentTarget.value })}
        w={220}
      />
      <NumberInput
        label="Limit"
        min={1}
        max={5000}
        value={filters.limit}
        onChange={(value) => {
          const limit = numberOrUndefined(value);
          if (limit !== undefined) {
            patch({ limit });
          }
        }}
        w={100}
      />
      <Button loading={panel.loading} onClick={() => void refresh(panelId)}>
        Refresh
      </Button>
    </Group>
  );
}
