/// <reference types="vite/client" />
import 'dockview/dist/styles/dockview.css';
import { Box, Button, Flex, Group, Text } from '@mantine/core';
import { IconLock, IconPlus, IconServer } from '@tabler/icons-react';
import { DockviewReact, type DockviewReadyEvent } from 'dockview-react';
import { ConnectionDialog } from '../components/connections/ConnectionDialog';
import { ConnectionManager } from '../components/connections/ConnectionManager';
import { runReported } from '../components/notify-error';
import { useAppStore } from '../state/app-store-context';
import { OutputPanel, ConnectionsPanel, WelcomePanel } from './ShellPanels';

const PANEL_COMPONENTS = {
  connections: ConnectionsPanel,
  welcome: WelcomePanel,
  output: OutputPanel,
};

/** Lays out the three default panels: connections on the left, welcome in the centre, output below. */
function handleDockReady({ api }: DockviewReadyEvent) {
  api.addPanel({
    id: 'connections',
    component: 'connections',
    title: 'Connections',
    position: { direction: 'left' },
  });
  api.addPanel({
    id: 'welcome',
    component: 'welcome',
    title: 'Welcome',
    position: { referencePanel: 'connections', direction: 'right' },
  });
  api.addPanel({
    id: 'output',
    component: 'output',
    title: 'Output',
    position: { referencePanel: 'welcome', direction: 'below' },
  });
}

/** The unlocked main window: toolbar, dockable panels, connection dialog and manager. */
export function ShellScreen() {
  const lock = useAppStore((state) => state.lock);
  const dialog = useAppStore((state) => state.dialog);
  const setDialog = useAppStore((state) => state.setDialog);
  const setManagerOpen = useAppStore((state) => state.setManagerOpen);

  return (
    <Flex direction="column" h="100vh" style={{ overflow: 'hidden' }}>
      <Group
        h={44}
        px="sm"
        justify="space-between"
        wrap="nowrap"
        style={{ borderBottom: '1px solid var(--mantine-color-default-border)', flex: '0 0 auto' }}
      >
        <Group gap="xs" wrap="nowrap">
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
        <div className="dockview-theme-dark" style={{ height: '100%' }}>
          <DockviewReact components={PANEL_COMPONENTS} onReady={handleDockReady} />
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
  );
}
