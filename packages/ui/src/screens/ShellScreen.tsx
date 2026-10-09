/// <reference types="vite/client" />
import 'dockview/dist/styles/dockview.css';
import '../theme/dockview-theme.css';
import { Box, Button, Flex, Group, Text } from '@mantine/core';
import { IconDatabase, IconLock, IconPlus, IconServer } from '@tabler/icons-react';
import { useCallback, useRef } from 'react';
import {
  DockviewReact,
  themeDark,
  type DockviewApi,
  type DockviewReadyEvent,
  type DockviewTheme,
} from 'dockview-react';
import { ConnectionDialog } from '../components/connections/ConnectionDialog';
import { ConnectionManager } from '../components/connections/ConnectionManager';
import { runReported } from '../components/notify-error';
import { useAppStore } from '../state/app-store-context';
import { PanelOpenerContext, type OpenPanel } from '../state/panel-opener';
import {
  ConnectionsPanel,
  FixedTab,
  MonitorPanel,
  OperationsPanelView,
  OutputPanel,
  WelcomePanel,
} from './ShellPanels';

const PANEL_COMPONENTS = {
  connections: ConnectionsPanel,
  welcome: WelcomePanel,
  output: OutputPanel,
  monitor: MonitorPanel,
  operations: OperationsPanelView,
};

const TAB_COMPONENTS = { fixed: FixedTab };

/**
 * Dockview's default theme is the navy "abyss" theme. This one keeps the dark structure and
 * takes its colours from theme/dockview-theme.css, which uses Mantine tokens.
 */
const MONGO_THEME: DockviewTheme = { ...themeDark, name: 'mongo-gui', className: 'mg-dockview' };

const SIDEBAR_WIDTH_PX = 280;
const OUTPUT_SHARE = 0.3;

/**
 * Lays out the three default panels: connections on the left, welcome in the centre, and output
 * below at about 30% of the height. The panels are fixed, so their tabs have no close button.
 */
function handleDockReady({ api }: DockviewReadyEvent) {
  const height = api.height > 0 ? api.height : window.innerHeight;
  api.addPanel({
    id: 'connections',
    component: 'connections',
    tabComponent: 'fixed',
    title: 'Connections',
    position: { direction: 'left' },
  });
  api.addPanel({
    id: 'welcome',
    component: 'welcome',
    tabComponent: 'fixed',
    title: 'Welcome',
    position: { referencePanel: 'connections', direction: 'right' },
  });
  api.addPanel({
    id: 'output',
    component: 'output',
    tabComponent: 'fixed',
    title: 'Output',
    position: { referencePanel: 'welcome', direction: 'below' },
  });
  // The initial sizes are set on the groups, because the panel options do not size the first split.
  api.getPanel('connections')?.group.api.setSize({ width: SIDEBAR_WIDTH_PX });
  api.getPanel('output')?.group.api.setSize({ height: Math.round(height * OUTPUT_SHARE) });
}

/**
 * Opens a connection's monitor or operations panel in the centre group. A panel that is already
 * open is brought to the front, so each connection has at most one of each.
 */
function openConnectionPanel(api: DockviewApi, request: Parameters<OpenPanel>[0]): void {
  const id = `${request.kind}:${request.connectionId}`;
  const existing = api.getPanel(id);
  if (existing !== undefined) {
    existing.api.setActive();
    return;
  }
  const suffix = request.kind === 'monitor' ? 'monitor' : 'operations';
  const centre = api.getPanel('welcome') === undefined ? undefined : 'welcome';
  api.addPanel({
    id,
    component: request.kind,
    title: `${request.connectionName} ${suffix}`,
    params: { connectionId: request.connectionId },
    ...(centre === undefined
      ? {}
      : { position: { referencePanel: centre, direction: 'within' as const } }),
  });
}

/** The unlocked main window: toolbar, dockable panels, connection dialog and manager. */
export function ShellScreen() {
  const lock = useAppStore((state) => state.lock);
  const dialog = useAppStore((state) => state.dialog);
  const setDialog = useAppStore((state) => state.setDialog);
  const setManagerOpen = useAppStore((state) => state.setManagerOpen);
  const dockApi = useRef<DockviewApi | undefined>(undefined);
  const openPanel = useCallback<OpenPanel>((request) => {
    if (dockApi.current !== undefined) {
      openConnectionPanel(dockApi.current, request);
    }
  }, []);

  return (
    <PanelOpenerContext.Provider value={openPanel}>
      <Flex direction="column" h="100vh" style={{ overflow: 'hidden' }}>
        <Group
          h={40}
          px={8}
          justify="space-between"
          wrap="nowrap"
          gap={8}
          style={{ borderBottom: '1px solid var(--mantine-color-dark-4)', flex: '0 0 auto' }}
        >
          <Group gap={8} wrap="nowrap">
            <IconDatabase size={18} color="var(--mantine-color-blue-5)" aria-hidden="true" />
            <Text fw={600} size="sm">
              Mongo GUI
            </Text>
            <Button
              variant="light"
              leftSection={<IconPlus size={14} />}
              onClick={() => setDialog({ kind: 'create' })}
            >
              New connection
            </Button>
            <Button
              variant="default"
              leftSection={<IconServer size={14} />}
              onClick={() => setManagerOpen(true)}
            >
              Connections
            </Button>
          </Group>
          <Button
            variant="default"
            leftSection={<IconLock size={14} />}
            onClick={() => void runReported(() => lock())}
          >
            Lock
          </Button>
        </Group>
        <Box style={{ flex: 1, minHeight: 0 }}>
          <div style={{ height: '100%' }}>
            <DockviewReact
              theme={MONGO_THEME}
              components={PANEL_COMPONENTS}
              tabComponents={TAB_COMPONENTS}
              onReady={(event) => {
                dockApi.current = event.api;
                handleDockReady(event);
              }}
            />
          </div>
        </Box>
        {dialog.kind === 'closed' ? null : (
          <ConnectionDialog
            key={dialog.kind === 'edit' ? dialog.connectionId : 'create'}
            connectionId={dialog.kind === 'edit' ? dialog.connectionId : undefined}
            onClose={() => setDialog({ kind: 'closed' })}
          />
        )}
        <ConnectionManager />
      </Flex>
    </PanelOpenerContext.Provider>
  );
}
