import { Box, Center, Stack, Text, Title } from '@mantine/core';
import { useEffect, useState } from 'react';
import {
  DockviewDefaultTab,
  type IDockviewPanelHeaderProps,
  type IDockviewPanelProps,
} from 'dockview-react';
import { ConnectionTree } from '../components/connections/ConnectionTree';
import { TransfersPanel } from '../components/transfers/TransfersPanel';
import { MonitorDashboard } from '../monitor/MonitorDashboard';
import { OperationsPanel } from '../monitor/OperationsPanel';

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

interface ConnectionPanelParams {
  readonly connectionId: string;
}

/** Centre panel for one connection's live metrics. Opened from the tree or the context menu. */
export function MonitorPanel(props: IDockviewPanelProps<ConnectionPanelParams>) {
  return (
    <Box h="100%" style={{ overflow: 'auto' }}>
      <MonitorDashboard connectionId={props.params.connectionId} />
    </Box>
  );
}

/** Centre panel for one connection's running operations. Polling pauses while it is hidden. */
export function OperationsPanelView(props: IDockviewPanelProps<ConnectionPanelParams>) {
  const visible = usePanelVisible(props.api);
  return (
    <Box h="100%" style={{ overflow: 'auto' }}>
      <OperationsPanel connectionId={props.params.connectionId} visible={visible} />
    </Box>
  );
}

function usePanelVisible(api: IDockviewPanelProps['api']): boolean {
  const [visible, setVisible] = useState(api.isVisible);
  useEffect(() => {
    const subscription = api.onDidVisibilityChange((event) => {
      setVisible(event.isVisible);
    });
    return () => {
      subscription.dispose();
    };
  }, [api]);
  return visible;
}

/** Bottom panel. Command output will appear here. Transfers are listed until then. */
export function OutputPanel() {
  return (
    <Box p={8} h="100%" style={{ overflow: 'auto' }}>
      <TransfersPanel />
    </Box>
  );
}
