/// <reference types="vite/client" />
import 'dockview/dist/styles/dockview.css';
import '../theme/dockview-theme.css';
import { Box, Button, Flex, Group, Text } from '@mantine/core';
import { IconDatabase, IconLock, IconPlus, IconServer, IconSettings } from '@tabler/icons-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  DockviewReact,
  themeDark,
  type DockviewApi,
  type DockviewReadyEvent,
  type DockviewTheme,
} from 'dockview-react';
import { ConnectionDialog } from '../components/connections/ConnectionDialog';
import { ConnectionManager } from '../components/connections/ConnectionManager';
import { ManagementDialogs } from '../components/management/ManagementDialogs';
import { runReported } from '../components/notify-error';
import { SettingsModal } from '../components/settings/SettingsModal';
import { TransferModals } from '../components/transfers/TransferModals';
import { UpdateBanner } from '../components/updates/UpdateBanner';
import { ProfilerOpenerContext, type ProfilerOpener } from '../profiler/profiler-opener';
import type { PanelRequest } from '../state/app-store';
import { useAppStore } from '../state/app-store-context';
import { PanelOpenerContext, type OpenPanel } from '../state/panel-opener';
import { profilerPanelId } from '../state/node-ids';
import { databasePanelIds, stalePanelIds } from './collection-panels';
import {
  ConnectionsPanel,
  DocumentsDockPanel,
  FixedTab,
  IndexesDockPanel,
  MonitorPanel,
  OperationsPanelView,
  OutputPanel,
  ProfilerDockPanel,
  SchemaDockPanel,
  ValidationDockPanel,
  WelcomePanel,
} from './ShellPanels';

const PANEL_COMPONENTS = {
  connections: ConnectionsPanel,
  welcome: WelcomePanel,
  output: OutputPanel,
  profiler: ProfilerDockPanel,
  monitor: MonitorPanel,
  operations: OperationsPanelView,
  indexes: IndexesDockPanel,
  validation: ValidationDockPanel,
  documents: DocumentsDockPanel,
  schema: SchemaDockPanel,
};

const TAB_COMPONENTS = { fixed: FixedTab };

/**
 * Dockview's default theme is the navy "abyss" theme. This one keeps the dark structure and
 * takes its colours from theme/dockview-theme.css, which uses Mantine tokens.
 */
const MONGO_THEME: DockviewTheme = { ...themeDark, name: 'mongo-gui', className: 'mg-dockview' };

const SIDEBAR_WIDTH_PX = 280;
const OUTPUT_SHARE = 0.3;
const PANEL_TITLE_SUFFIX: Readonly<Record<PanelRequest['panel'], string>> = {
  indexes: 'indexes',
  validation: 'validation',
  documents: 'documents',
  schema: 'schema',
};

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
 * Adds the profiler panel of a database next to the welcome panel, or focuses it when it is open.
 * One panel per database, titled "<database> profiler".
 */
function openProfilerPanel(api: DockviewApi, connectionId: string, database: string): void {
  const id = profilerPanelId(connectionId, database);
  const existing = api.getPanel(id);
  if (existing !== undefined) {
    existing.api.setActive();
    return;
  }
  api.addPanel({
    id,
    component: 'profiler',
    title: `${database} profiler`,
    params: { connectionId, database },
    position: { referencePanel: 'welcome', direction: 'within' },
  });
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

function panelId(request: PanelRequest): string {
  return `${request.panel}:${request.connectionId}:${request.database}.${request.collection}`;
}

/**
 * Focuses the panel for the request, or adds it. One panel exists per collection and kind. The
 * shell remembers the request, so a rename or a drop can close the panel later.
 */
function openCollectionPanel(
  api: DockviewApi,
  request: PanelRequest,
  open: Map<string, PanelRequest>,
): void {
  const id = panelId(request);
  const existing = api.getPanel(id);
  if (existing !== undefined) {
    existing.api.setActive();
    return;
  }
  open.set(id, request);
  // Collection panels open as tabs of the centre group. The active group could be the tree's, and a
  // dockview group hides the tree's content while another of its tabs is active.
  api.addPanel({
    id,
    component: request.panel,
    title: `${request.database}.${request.collection} ${PANEL_TITLE_SUFFIX[request.panel]}`,
    params: {
      connectionId: request.connectionId,
      database: request.database,
      collection: request.collection,
    },
    position: { referencePanel: 'welcome' },
  });
}

function removePanelById(api: DockviewApi, id: string): void {
  const panel = api.getPanel(id);
  if (panel !== undefined) {
    api.removePanel(panel);
  }
}

/** Closes every collection and profiler panel of one database. Runs when the database is dropped. */
function closeDatabasePanels(
  api: DockviewApi,
  open: Map<string, PanelRequest>,
  connectionId: string,
  database: string,
): void {
  for (const id of databasePanelIds(open, connectionId, database)) {
    removePanelById(api, id);
    open.delete(id);
  }
  removePanelById(api, profilerPanelId(connectionId, database));
}

/**
 * Stops a connection's sampler when its last monitor panel closes. A reload of the
 * renderer also removes the panels, but no stop is sent then. The main process stops every sampler
 * on disconnect and on lock, so nothing keeps sampling after the window is gone.
 */
function stopSamplerWhenUnused(
  api: DockviewApi,
  removedId: string,
  stop: (connectionId: string) => Promise<void>,
): void {
  // Only monitor panels read samples. An operations panel does not keep the sampler alive.
  const match = /^monitor:(.+)$/.exec(removedId);
  if (match === null) {
    return;
  }
  const connectionId = match[1] ?? '';
  const stillOpen = api.panels.some(
    (panel) => panel.id !== removedId && panel.id === `monitor:${connectionId}`,
  );
  if (!stillOpen) {
    void runReported(() => stop(connectionId));
  }
}

/** The unlocked main window: toolbar, dockable panels, connection dialog and manager. */
export function ShellScreen() {
  const lock = useAppStore((state) => state.lock);
  const stopMonitor = useAppStore((state) => state.stopMonitor);
  const dialog = useAppStore((state) => state.dialog);
  const setDialog = useAppStore((state) => state.setDialog);
  const setManagerOpen = useAppStore((state) => state.setManagerOpen);
  const setSettingsOpen = useAppStore((state) => state.setSettingsOpen);
  const panelRequest = useAppStore((state) => state.panelRequest);
  const clearPanelRequest = useAppStore((state) => state.clearPanelRequest);
  const databases = useAppStore((state) => state.databases);
  const collections = useAppStore((state) => state.collections);
  const dockApi = useRef<DockviewApi | undefined>(undefined);
  const [dock, setDock] = useState<DockviewApi | undefined>(undefined);
  // The collection panels this shell opened, by panel id.
  const collectionPanels = useRef(new Map<string, PanelRequest>());
  const openPanel = useCallback<OpenPanel>((request) => {
    if (dockApi.current !== undefined) {
      openConnectionPanel(dockApi.current, request);
    }
  }, []);
  const profilerOpener = useMemo<ProfilerOpener>(
    () => ({
      open(connectionId, database) {
        if (dockApi.current !== undefined) {
          openProfilerPanel(dockApi.current, connectionId, database);
        }
      },
    }),
    [],
  );

  // A request can arrive before the dock is ready, so the effect also runs when the dock appears.
  useEffect(() => {
    if (dock === undefined || panelRequest === undefined) {
      return;
    }
    openCollectionPanel(dock, panelRequest, collectionPanels.current);
    clearPanelRequest();
  }, [dock, panelRequest, clearPanelRequest]);

  // Closes a collection panel once its database or collection is gone from a loaded list. A
  // database that was never expanded still counts, because the database list is loaded first.
  useEffect(() => {
    if (dock === undefined) {
      return;
    }
    for (const id of stalePanelIds(collectionPanels.current, databases, collections)) {
      removePanelById(dock, id);
      collectionPanels.current.delete(id);
    }
  }, [dock, databases, collections]);

  return (
    <PanelOpenerContext.Provider value={openPanel}>
      <ProfilerOpenerContext.Provider value={profilerOpener}>
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
              <UpdateBanner />
            </Group>
            <Group gap={8} wrap="nowrap">
              <Button
                variant="default"
                leftSection={<IconSettings size={14} />}
                onClick={() => setSettingsOpen(true)}
              >
                Settings
              </Button>
              <Button
                variant="default"
                leftSection={<IconLock size={14} />}
                onClick={() => void runReported(() => lock())}
              >
                Lock
              </Button>
            </Group>
          </Group>
          <Box style={{ flex: 1, minHeight: 0 }}>
            <div style={{ height: '100%' }}>
              <DockviewReact
                theme={MONGO_THEME}
                components={PANEL_COMPONENTS}
                tabComponents={TAB_COMPONENTS}
                onReady={(event) => {
                  dockApi.current = event.api;
                  setDock(event.api);
                  handleDockReady(event);
                  event.api.onDidRemovePanel((panel) => {
                    collectionPanels.current.delete(panel.id);
                    stopSamplerWhenUnused(event.api, panel.id, stopMonitor);
                  });
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
          <ManagementDialogs
            onDatabaseDropped={(connectionId, database) => {
              if (dockApi.current !== undefined) {
                closeDatabasePanels(
                  dockApi.current,
                  collectionPanels.current,
                  connectionId,
                  database,
                );
              }
            }}
          />
          <ConnectionManager />
          <SettingsModal />
          <TransferModals />
        </Flex>
      </ProfilerOpenerContext.Provider>
    </PanelOpenerContext.Provider>
  );
}
