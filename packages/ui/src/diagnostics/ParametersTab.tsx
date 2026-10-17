import { ActionIcon, Group, Table, TextInput, Tooltip } from '@mantine/core';
import { IconPencil } from '@tabler/icons-react';
import { useEffect, useMemo, useState } from 'react';
import type { ServerParameter } from '@mongo-gui/core';
import { useStore } from 'zustand';
import { CopyIcon, LoadState, ScrollLayout, Toolbar } from './common';
import type { DiagnosticsStore } from './diagnostics-store';
import { ParameterEditDialog } from './ParameterEditDialog';
import { editableValue, filterParameters, valueColor, valueText } from './parameter-search';

const NO_PARAMETERS: readonly ServerParameter[] = [];

export interface ParametersTabProps {
  readonly store: DiagnosticsStore;
}

/** Server parameters from getParameter '*', searchable by name or value. */
export function ParametersTab({ store }: ParametersTabProps) {
  const state = useStore(store, (current) => current.parameters);
  const load = useStore(store, (current) => current.loadParameters);
  const set = useStore(store, (current) => current.setParameter);
  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState<ServerParameter | undefined>(undefined);

  useEffect(() => {
    void load();
  }, [load]);

  const all = state.data ?? NO_PARAMETERS;
  const shown = useMemo(() => filterParameters(all, query), [all, query]);

  return (
    <ScrollLayout
      toolbar={
        <Toolbar
          loading={state.loading}
          onRefresh={() => void load()}
          status={`Showing ${shown.length} of ${all.length} parameters`}
        >
          <TextInput
            aria-label="Search parameters"
            placeholder="Search by name or value"
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
            w={320}
            size="xs"
          />
        </Toolbar>
      }
    >
      <LoadState state={state}>
        {() => (
          <Table withTableBorder stickyHeader verticalSpacing={2} fz="xs" layout="fixed" striped>
            <Table.Thead>
              <Table.Tr>
                <Table.Th w="40%">Name</Table.Th>
                <Table.Th>Value</Table.Th>
                <Table.Th w={72} />
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {shown.map((parameter) => (
                <Table.Tr key={parameter.name}>
                  <Table.Td
                    style={{
                      fontFamily: 'var(--mantine-font-family-monospace)',
                      wordBreak: 'break-all',
                    }}
                  >
                    {parameter.name}
                  </Table.Td>
                  <Table.Td
                    {...colorProps(valueText(parameter))}
                    style={{
                      fontFamily: 'var(--mantine-font-family-monospace)',
                      wordBreak: 'break-all',
                    }}
                  >
                    {valueText(parameter)}
                  </Table.Td>
                  <Table.Td>
                    <Group gap={2} wrap="nowrap">
                      <CopyIcon
                        text={`${parameter.name}: ${valueText(parameter)}`}
                        label={`Copy ${parameter.name}`}
                      />
                      <Tooltip
                        label="Only a plain value can be changed here"
                        withArrow
                        disabled={editableValue(parameter) !== undefined}
                      >
                        <ActionIcon
                          variant="subtle"
                          size="sm"
                          aria-label={`Edit ${parameter.name}`}
                          disabled={editableValue(parameter) === undefined}
                          onClick={() => setEditing(parameter)}
                        >
                          <IconPencil size={14} />
                        </ActionIcon>
                      </Tooltip>
                    </Group>
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        )}
      </LoadState>
      {editing === undefined ? null : (
        <ParameterEditDialog
          parameter={editing}
          current={editableValue(editing) ?? valueText(editing)}
          onSet={set}
          onClose={() => setEditing(undefined)}
        />
      )}
    </ScrollLayout>
  );
}

function colorProps(text: string): { c?: string } {
  const color = valueColor(text);
  return color === undefined ? {} : { c: color };
}
