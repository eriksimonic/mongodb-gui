import { Box, Center, Stack, Text, Title } from '@mantine/core';
import { useEffect, useState } from 'react';
import {
  DockviewDefaultTab,
  type IDockviewPanelHeaderProps,
  type IDockviewPanelProps,
} from 'dockview-react';
import { ConnectionTree } from '../components/connections/ConnectionTree';
import { TransfersPanel } from '../components/transfers/TransfersPanel';
import { DocumentsPanel } from '../components/management/DocumentsPanel';
import { IndexesPanel } from '../components/management/IndexesPanel';
import { ValidationPanel } from '../components/management/ValidationPanel';
import { ExplainPanel } from '../explain/ExplainPanel';
import { ProfilerPanel } from '../profiler/ProfilerPanel';
import { SchemaPanel } from '../schema/SchemaPanel';
import { MonitorDashboard } from '../monitor/MonitorDashboard';
import { OperationsPanel } from '../monitor/OperationsPanel';

/** The params every collection panel gets from the dock. */
export interface CollectionPanelParams {
  readonly connectionId: string;
  readonly database: string;
  readonly collection: string;
}

/** Params of a profiler panel. The shell sets them when it opens the panel. */
export interface ProfilerPanelParams {
  readonly connectionId: string;
  readonly database: string;
}

/** Params of an explain panel. The id names the panel in the app store. */
export interface ExplainPanelParams {
  readonly panelId: string;
}

/** An explain panel in the centre group. Its request and result live in the app store. */
export function ExplainDockPanel({ params }: IDockviewPanelProps<ExplainPanelParams>) {
  return (
    <Box h="100%" style={{ overflow: 'auto' }}>
      <ExplainPanel panelId={params.panelId} />
    </Box>
  );
}

/** A profiler panel of one database. Closing the tab drops its state and stops its tail. */
export function ProfilerDockPanel({ params }: IDockviewPanelProps<ProfilerPanelParams>) {
  return <ProfilerPanel connectionId={params.connectionId} database={params.database} />;
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

/** Dock panel: schema analysis of one collection. The panel scrolls its own table. */
export function SchemaDockPanel({ params }: IDockviewPanelProps<CollectionPanelParams>) {
  return (
    <Box h="100%" style={{ overflow: 'hidden' }}>
      <SchemaPanel {...params} />
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
