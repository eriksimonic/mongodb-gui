import { Badge, Button, Group, Modal, Paper, Stack, Text, TextInput } from '@mantine/core';
import {
  PANEL_CATALOG,
  REQUIREMENT_LABELS,
  unmetRequirement,
  type PanelSpec,
  type ServerCapabilities,
} from '@mongo-gui/core';
import { useMemo, useState } from 'react';
import { groupByCategory, searchPanels } from './panel-picker';

export interface AddPanelPickerProps {
  readonly opened: boolean;
  readonly onClose: () => void;
  /** Catalogue ids already on the dashboard. Those rows are marked and cannot be added twice. */
  readonly addedIds: ReadonlySet<string>;
  readonly capabilities: ServerCapabilities;
  readonly onAdd: (panel: PanelSpec) => void;
}

export function AddPanelPicker({
  opened,
  onClose,
  addedIds,
  capabilities,
  onAdd,
}: AddPanelPickerProps) {
  const [query, setQuery] = useState('');
  const groups = useMemo(() => groupByCategory(searchPanels(PANEL_CATALOG, query)), [query]);

  return (
    <Modal opened={opened} onClose={onClose} title="Add panel" size="lg" centered>
      <Stack gap="sm">
        <TextInput
          label="Search panels"
          placeholder="Search by name, metric or description"
          value={query}
          onChange={(event) => setQuery(event.currentTarget.value)}
          data-testid="panel-search"
        />
        {groups.length === 0 ? (
          <Text size="sm" c="dimmed">
            No panels match this search.
          </Text>
        ) : null}
        {groups.map((group) => (
          <Stack
            key={group.category}
            gap={6}
            data-testid="picker-group"
            data-category={group.category}
          >
            <Text size="sm" fw={600}>
              {group.label}
            </Text>
            {group.panels.map((panel) => (
              <PickerRow
                key={panel.id}
                panel={panel}
                added={addedIds.has(panel.id)}
                capabilities={capabilities}
                onAdd={onAdd}
              />
            ))}
          </Stack>
        ))}
      </Stack>
    </Modal>
  );
}

interface PickerRowProps {
  readonly panel: PanelSpec;
  readonly added: boolean;
  readonly capabilities: ServerCapabilities;
  readonly onAdd: (panel: PanelSpec) => void;
}

function PickerRow({ panel, added, capabilities, onAdd }: PickerRowProps) {
  const unmet = unmetRequirement(panel, capabilities);
  const reasonId = `picker-reason-${panel.id}`;
  return (
    <Paper withBorder p="sm" radius="sm" data-testid="picker-row" data-panel-id={panel.id}>
      <Group justify="space-between" wrap="nowrap" align="flex-start" gap="sm">
        <Stack gap={2} style={{ minWidth: 0 }}>
          <Group gap="xs">
            <Text size="sm" fw={600}>
              {panel.title}
            </Text>
            {added ? (
              <Badge size="xs" variant="light">
                {unmet === undefined ? 'On the dashboard' : 'Saved, hidden on this server'}
              </Badge>
            ) : null}
          </Group>
          <Text size="xs" c="dimmed">
            {panel.description}
          </Text>
          {unmet === undefined ? null : (
            <Text size="xs" c="yellow.7" id={reasonId}>
              {REQUIREMENT_LABELS[unmet]}
            </Text>
          )}
        </Stack>
        <Button
          size="xs"
          variant="light"
          disabled={added || unmet !== undefined}
          aria-describedby={unmet === undefined ? undefined : reasonId}
          aria-label={`Add ${panel.title}`}
          onClick={() => onAdd(panel)}
        >
          Add
        </Button>
      </Group>
    </Paper>
  );
}
