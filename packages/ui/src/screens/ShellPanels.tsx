import { Box, Center, Stack, Text, Title } from '@mantine/core';
import { DockviewDefaultTab, type IDockviewPanelHeaderProps } from 'dockview-react';
import { ConnectionTree } from '../components/connections/ConnectionTree';

/** Tab for the three fixed panels. Same as dockview's default tab without the close button. */
export function FixedTab(props: IDockviewPanelHeaderProps) {
  return <DockviewDefaultTab {...props} hideClose />;
}

/** Left panel: the connection tree. */
export function ConnectionsPanel() {
  return (
    <Box p={8} h="100%" style={{ overflow: 'auto' }}>
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
    <Box p={8}>
      <Text size="sm" c="dimmed">
        No output yet.
      </Text>
    </Box>
  );
}
