import { Box, Group, Paper, SimpleGrid, Stack, Text, ThemeIcon, Title } from '@mantine/core';
import {
  IconBrandDocker,
  IconKeyboard,
  IconLock,
  IconPlus,
  IconSettings,
} from '@tabler/icons-react';
import { useEffect, useState } from 'react';
import {
  DockviewDefaultTab,
  type IDockviewPanelHeaderProps,
  type IDockviewPanelProps,
} from 'dockview-react';
import { ConnectionTree } from '../components/connections/ConnectionTree';
import { DocumentsPanel } from '../components/management/DocumentsPanel';
import { GridFsPanel } from '../components/gridfs/GridFsPanel';
import { IndexesPanel } from '../components/management/IndexesPanel';
import { UsersRolesPanel } from '../components/security/UsersRolesPanel';
import { ValidationPanel } from '../components/management/ValidationPanel';
import { ExplainPanel } from '../explain/ExplainPanel';
import { ProfilerPanel } from '../profiler/ProfilerPanel';
import { ReplicationPanel } from '../replication/ReplicationPanel';
import { EditorView } from '../components/editor/EditorView';
import { DiagnosticsPanel } from '../diagnostics/DiagnosticsPanel';
import { CollectionStatsPanel, DatabaseStatsPanel } from '../diagnostics/StatsPanels';

export { OutputPanel } from '../components/editor/OutputPanel';
import { SchemaPanel } from '../schema/SchemaPanel';
import { MonitorDashboard } from '../monitor/MonitorDashboard';
import { OperationsPanel } from '../monitor/OperationsPanel';
import { useAppStore } from '../state/app-store-context';
import { runReported } from '../components/notify-error';
import { idleLockHint, recentConnections } from './welcome-model';

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

/** Params of a replica set panel. The shell sets the connection when it opens the panel. */
export interface ReplicationPanelParams {
  readonly connectionId: string;
}

/** The replica set panel of one connection. Closing the tab drops its state and stops auto refresh. */
export function ReplicationDockPanel({ params }: IDockviewPanelProps<ReplicationPanelParams>) {
  return <ReplicationPanel connectionId={params.connectionId} />;
}

/** Params of an editor panel. The tab's state lives in the store, so only its id is passed. */
export interface EditorPanelParams {
  readonly tabId: string;
}

/** A query editor tab. Closing the tab removes the editor from the store. */
export function EditorDockPanel({ params }: IDockviewPanelProps<EditorPanelParams>) {
  return <EditorView tabId={params.tabId} />;
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

/** Centre panel shown until a collection or monitor opens. Quick actions, recent connections and a hint. */
export function WelcomePanel(props: IDockviewPanelProps) {
  const connections = useAppStore((state) => state.connections);
  const idleLockMinutes = useAppStore((state) => state.idleLockMinutes);
  const setDialog = useAppStore((state) => state.setDialog);
  const setSettingsOpen = useAppStore((state) => state.setSettingsOpen);
  const setShortcutsOpen = useAppStore((state) => state.setShortcutsOpen);
  const expandConnection = useAppStore((state) => state.expandConnection);
  const recent = connections.state === 'ready' ? recentConnections(connections.data) : [];

  const actions: readonly WelcomeAction[] = [
    {
      id: 'new-connection',
      title: 'New connection',
      description: 'Add a server by URI, with TLS and read preference options.',
      icon: IconPlus,
      run: () => setDialog({ kind: 'create' }),
    },
    {
      id: 'docker',
      title: 'Docker instances',
      description: 'Find MongoDB containers on this machine and connect them.',
      icon: IconBrandDocker,
      run: () => props.containerApi.getPanel('connections')?.api.setActive(),
    },
    {
      id: 'settings',
      title: 'Open settings',
      description: 'Theme, idle lock, editor size, updates and the master password.',
      icon: IconSettings,
      run: () => setSettingsOpen(true),
    },
    {
      id: 'shortcuts',
      title: 'Shortcut reference',
      description: 'The keys for the tree, dialogs and editors. Press ? anywhere.',
      icon: IconKeyboard,
      run: () => setShortcutsOpen(true),
    },
  ];

  return (
    <Box h="100%" style={{ overflow: 'auto' }}>
      <Stack gap="lg" maw={720} mx="auto" p="lg">
        <Stack gap={4}>
          <Title order={3}>Welcome to Mongo GUI</Title>
          <Text size="sm" c="dimmed">
            Connect to a server, browse its databases, and watch it live.
          </Text>
        </Stack>

        <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="sm">
          {actions.map((action) => (
            <Paper
              key={action.id}
              component="button"
              type="button"
              withBorder
              p="sm"
              radius="sm"
              onClick={() => action.run()}
              style={{ textAlign: 'left', cursor: 'pointer', font: 'inherit', color: 'inherit' }}
            >
              <Group gap="sm" wrap="nowrap" align="flex-start">
                <ThemeIcon variant="light" size={30} radius="sm">
                  <action.icon size={16} aria-hidden="true" />
                </ThemeIcon>
                <Stack gap={2}>
                  <Text size="sm" fw={600}>
                    {action.title}
                  </Text>
                  <Text size="xs" c="dimmed">
                    {action.description}
                  </Text>
                </Stack>
              </Group>
            </Paper>
          ))}
        </SimpleGrid>

        <Stack gap="xs">
          <Title order={5}>Recent connections</Title>
          {connections.state === 'loading' ? (
            <Text size="sm" c="dimmed">
              Loading connections
            </Text>
          ) : null}
          {connections.state === 'ready' && recent.length === 0 ? (
            <Text size="sm" c="dimmed">
              No connections yet. Create one to get started.
            </Text>
          ) : null}
          {recent.map((connection) => (
            <Paper
              key={connection.id}
              component="button"
              type="button"
              withBorder
              px="sm"
              py={6}
              radius="sm"
              onClick={() => void runReported(() => expandConnection(connection.id))}
              style={{ textAlign: 'left', cursor: 'pointer', font: 'inherit', color: 'inherit' }}
            >
              <Group gap="sm" wrap="nowrap">
                <Box
                  aria-hidden="true"
                  w={8}
                  h={8}
                  style={{
                    borderRadius: '50%',
                    flex: 'none',
                    background: connection.color ?? 'var(--mg-accent)',
                  }}
                />
                <Stack gap={0} miw={0} style={{ flex: 1 }}>
                  <Text size="sm" fw={500} truncate="end">
                    {connection.name}
                  </Text>
                  <Text size="xs" c="dimmed" ff="monospace" truncate="end">
                    {connection.uriRedacted}
                  </Text>
                </Stack>
                <Text size="xs" c="dimmed" style={{ whiteSpace: 'nowrap' }}>
                  {formatUpdated(connection.updatedAt)}
                </Text>
              </Group>
            </Paper>
          ))}
        </Stack>

        <Group gap="xs" wrap="nowrap" align="flex-start">
          <IconLock size={14} aria-hidden="true" style={{ flex: 'none', marginTop: 2 }} />
          <Text size="xs" c="dimmed">
            {idleLockHint(idleLockMinutes)}
          </Text>
        </Group>
      </Stack>
    </Box>
  );
}

interface WelcomeAction {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly icon: typeof IconPlus;
  readonly run: () => void;
}

function formatUpdated(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString();
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

/** Dock panel: indexes of one collection. */
export function IndexesDockPanel({ params }: IDockviewPanelProps<CollectionPanelParams>) {
  return (
    <Box h="100%" style={{ overflow: 'auto' }}>
      <IndexesPanel {...params} />
    </Box>
  );
}

/** Params of a users and roles panel. The shell sets them when it opens the panel. */
export interface UsersPanelParams {
  readonly connectionId: string;
  readonly database: string;
}

/** Dock panel: users and custom roles of one database. */
export function UsersDockPanel({ params }: IDockviewPanelProps<UsersPanelParams>) {
  return (
    <Box h="100%" style={{ overflow: 'auto' }}>
      <UsersRolesPanel connectionId={params.connectionId} database={params.database} />
    </Box>
  );
}

/** Params of the server diagnostics panel of a connection. */
export interface DiagnosticsPanelParams {
  readonly connectionId: string;
}

/** Dock panel: server logs, parameters, status, host, top, pools and sessions. */
export function DiagnosticsDockPanel({ params }: IDockviewPanelProps<DiagnosticsPanelParams>) {
  return <DiagnosticsPanel connectionId={params.connectionId} />;
}

/** Params of a database statistics panel. */
export interface DatabaseStatsPanelParams {
  readonly connectionId: string;
  readonly database: string;
}

/** Dock panel: storage statistics of one database. */
export function DatabaseStatsDockPanel({ params }: IDockviewPanelProps<DatabaseStatsPanelParams>) {
  return (
    <Box h="100%" style={{ overflow: 'auto' }}>
      <DatabaseStatsPanel connectionId={params.connectionId} database={params.database} />
    </Box>
  );
}

/** Dock panel: storage statistics of one collection. */
export function CollectionStatsDockPanel({ params }: IDockviewPanelProps<CollectionPanelParams>) {
  return (
    <Box h="100%" style={{ overflow: 'auto' }}>
      <CollectionStatsPanel
        connectionId={params.connectionId}
        database={params.database}
        collection={params.collection}
      />
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

/** Params of a GridFS bucket panel. The shell sets them when it opens the panel. */
export interface GridFsDockPanelParams {
  readonly connectionId: string;
  readonly database: string;
  readonly bucket: string;
}

/** Dock panel: the files of one GridFS bucket. */
export function GridFsDockPanel({ params }: IDockviewPanelProps<GridFsDockPanelParams>) {
  return (
    <Box h="100%" style={{ overflow: 'hidden' }}>
      <GridFsPanel {...params} />
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
