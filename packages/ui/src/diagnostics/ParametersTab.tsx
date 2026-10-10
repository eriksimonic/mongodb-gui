import { Group, Stack, Table, Text, TextInput } from '@mantine/core';
import { useEffect, useMemo, useState } from 'react';
import type { ServerParameter } from '@mongo-gui/core';
import { useStore } from 'zustand';
import { CopyIcon, LoadState, RefreshButton } from './common';
import type { DiagnosticsStore } from './diagnostics-store';
import { filterParameters, valueText } from './parameter-search';

const NO_PARAMETERS: readonly ServerParameter[] = [];

export interface ParametersTabProps {
  readonly store: DiagnosticsStore;
}

/** Server parameters from getParameter '*', searchable by name or value. */
export function ParametersTab({ store }: ParametersTabProps) {
  const state = useStore(store, (current) => current.parameters);
  const load = useStore(store, (current) => current.loadParameters);
  const [query, setQuery] = useState('');

  useEffect(() => {
    void load();
  }, [load]);

  const all = state.data ?? NO_PARAMETERS;
  const shown = useMemo(() => filterParameters(all, query), [all, query]);

  return (
    <Stack gap="xs" p="sm">
      <Group gap="xs" align="flex-end">
        <TextInput
          aria-label="Search parameters"
          placeholder="Search by name or value"
          value={query}
          onChange={(event) => setQuery(event.currentTarget.value)}
          w={320}
          size="xs"
        />
        <RefreshButton loading={state.loading} onRefresh={() => void load()} />
      </Group>
      <Text size="xs" c="dimmed">
        Showing {shown.length} of {all.length} parameters
      </Text>
      <LoadState state={state}>
        {() => (
          <Table withTableBorder verticalSpacing={2} fz="xs" layout="fixed" striped>
            <Table.Thead>
              <Table.Tr>
                <Table.Th w="40%">Name</Table.Th>
                <Table.Th>Value</Table.Th>
                <Table.Th w={40} />
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {shown.map((parameter) => (
                <Table.Tr key={parameter.name}>
                  <Table.Td style={{ fontFamily: 'monospace', wordBreak: 'break-all' }}>
                    {parameter.name}
                  </Table.Td>
                  <Table.Td style={{ fontFamily: 'monospace', wordBreak: 'break-all' }}>
                    {valueText(parameter)}
                  </Table.Td>
                  <Table.Td>
                    <CopyIcon
                      text={`${parameter.name}: ${valueText(parameter)}`}
                      label={`Copy ${parameter.name}`}
                    />
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        )}
      </LoadState>
    </Stack>
  );
}
