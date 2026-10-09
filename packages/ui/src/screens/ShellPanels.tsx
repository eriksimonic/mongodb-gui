import { Box, Center, Stack, Text, Title } from '@mantine/core';
import {
  DockviewDefaultTab,
  type IDockviewPanelProps,
  type IDockviewPanelHeaderProps,
} from 'dockview-react';
import { ConnectionTree } from '../components/connections/ConnectionTree';
import { DocumentsPanel } from '../components/management/DocumentsPanel';
import { IndexesPanel } from '../components/management/IndexesPanel';
import { ValidationPanel } from '../components/management/ValidationPanel';

/** The params every collection panel gets from the dock. */
export interface CollectionPanelParams {
  readonly connectionId: string;
  readonly database: string;
  readonly collection: string;
}

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

/** Dock panel: indexes of one collection. */
export function IndexesDockPanel({ params }: IDockviewPanelProps<CollectionPanelParams>) {
  return (
    <Box h="100%" style={{ overflow: 'auto' }}>
      <IndexesPanel {...params} />
    </Box>
  );
}

/** Dock panel: validator of one collection. */
export function ValidationDockPanel({ params }: IDockviewPanelProps<CollectionPanelParams>) {
  return (
    <Box h="100%" style={{ overflow: 'auto' }}>
      <ValidationPanel {...params} />
    </Box>
  );
}

/** Dock panel: sampled documents of one collection. */
export function DocumentsDockPanel({ params }: IDockviewPanelProps<CollectionPanelParams>) {
  return (
    <Box h="100%" style={{ overflow: 'auto' }}>
      <DocumentsPanel {...params} />
    </Box>
  );
}
