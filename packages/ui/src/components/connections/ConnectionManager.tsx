import { ActionIcon, Button, Code, ColorSwatch, Group, Modal, Stack, Text } from '@mantine/core';
import { modals } from '@mantine/modals';
import type { ConnectionProfileSummary } from '@mongo-gui/core';
import { IconPencil, IconPlus, IconTrash } from '@tabler/icons-react';
import { useAppStore } from '../../state/app-store-context';
import { runReported } from '../notify-error';

/** Modal list of saved connections. Edit and delete live here; connecting happens in the tree. */
export function ConnectionManager() {
  const open = useAppStore((state) => state.managerOpen);
  const setManagerOpen = useAppStore((state) => state.setManagerOpen);
  const connections = useAppStore((state) => state.connections);
  const setDialog = useAppStore((state) => state.setDialog);
  const removeConnection = useAppStore((state) => state.removeConnection);

  function confirmRemove(connection: ConnectionProfileSummary) {
    modals.openConfirmModal({
      title: 'Remove connection',
      centered: true,
      children: (
        <Text size="sm">
          Remove {connection.name}? Its saved URI is deleted. This cannot be undone.
        </Text>
      ),
      labels: { confirm: 'Remove', cancel: 'Cancel' },
      confirmProps: { color: 'red' },
      onConfirm: () => {
        void runReported(() => removeConnection(connection.id));
      },
    });
  }

  return (
    <Modal
      opened={open}
      onClose={() => setManagerOpen(false)}
      title="Connections"
      size="lg"
      centered
    >
      <Stack gap="sm">
        <Group justify="flex-end">
          <Button
            size="xs"
            leftSection={<IconPlus size={14} />}
            onClick={() => setDialog({ kind: 'create' })}
          >
            New connection
          </Button>
        </Group>
        {connections.state !== 'ready' ? (
          <Text size="sm" c="dimmed">
            {connections.state === 'error' ? connections.error.message : 'Loading connections'}
          </Text>
        ) : (
          connections.data.map((connection) => (
            <Group key={connection.id} justify="space-between" wrap="nowrap" gap="sm">
              <Group gap="sm" wrap="nowrap" miw={0}>
                <ColorSwatch color={connection.color ?? 'gray'} size={12} />
                <Stack gap={0} miw={0}>
                  <Text size="sm" fw={500} truncate="end">
                    {connection.name}
                  </Text>
                  <Code>{connection.uriRedacted}</Code>
                </Stack>
              </Group>
              <Group gap={4} wrap="nowrap">
                <ActionIcon
                  aria-label={`Edit ${connection.name}`}
                  onClick={() => setDialog({ kind: 'edit', connectionId: connection.id })}
                >
                  <IconPencil size={14} />
                </ActionIcon>
                <ActionIcon
                  aria-label={`Delete ${connection.name}`}
                  color="red"
                  onClick={() => confirmRemove(connection)}
                >
                  <IconTrash size={14} />
                </ActionIcon>
              </Group>
            </Group>
          ))
        )}
      </Stack>
    </Modal>
  );
}
