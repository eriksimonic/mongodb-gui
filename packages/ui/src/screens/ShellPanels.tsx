import { Box, Center, Stack, Text, Title } from '@mantine/core';
import { ConnectionTree } from '../components/connections/ConnectionTree';

/** Left panel: the connection tree. */
export function ConnectionsPanel() {
  return (
    <Box p="xs" h="100%" style={{ overflow: 'auto' }}>
      <ConnectionTree />
    </Box>
  );
}

/** Centre panel placeholder until the editor arrives in phase 2. */
export function WelcomePanel() {
  return (
    <Center h="100%" p="md">
      <Stack gap="xs" maw={420}>
        <Title order={4}>Welcome</Title>
        <Text size="sm" c="dimmed">
          Expand a connection in the Connections panel to browse its databases and collections. The
          query editor arrives in a later phase.
        </Text>
      </Stack>
    </Center>
  );
}

/** Bottom panel placeholder. Command output will appear here. */
export function OutputPanel() {
  return (
    <Box p="xs">
      <Text size="sm" c="dimmed">
        No output yet.
      </Text>
    </Box>
  );
}
