import { Alert, Button, Loader, Stack, Text } from '@mantine/core';
import { IconPlus } from '@tabler/icons-react';
import { useAppStore } from '../../state/app-store-context';
import { ConnectionNode } from './ConnectionNode';

/** The Connections panel: every saved connection, with lazy-loaded databases and collections. */
export function ConnectionTree() {
  const connections = useAppStore((state) => state.connections);
  const setDialog = useAppStore((state) => state.setDialog);

  if (connections.state === 'loading') {
    return <Loader size="xs" aria-label="Loading connections" />;
  }
  if (connections.state === 'error') {
    return (
      <Alert color="red" variant="light" p="xs">
        {connections.error.message}
      </Alert>
    );
  }
  if (connections.data.length === 0) {
    return (
      <Stack gap="xs" align="flex-start">
        <Text size="sm" c="dimmed">
          No connections yet.
        </Text>
        <Button
          size="xs"
          variant="light"
          leftSection={<IconPlus size={14} />}
          onClick={() => setDialog({ kind: 'create' })}
        >
          New connection
        </Button>
      </Stack>
    );
  }
  return (
    <Stack gap={0} aria-label="Connections">
      {connections.data.map((connection) => (
        <ConnectionNode key={connection.id} connection={connection} />
      ))}
    </Stack>
  );
}
