/// <reference types="vite/client" />
import 'dockview/dist/styles/dockview.css';
import '../theme/dockview-theme.css';
import { Box, Button, Flex, Group, Menu, Text } from '@mantine/core';
import { useHotkeys } from '@mantine/hooks';
import {
  IconDatabase,
  IconHelp,
  IconKeyboard,
  IconLock,
  IconPlus,
  IconServer,
  IconSettings,
} from '@tabler/icons-react';
import type { ChangeTarget, RpcClient } from '@mongo-gui/core';
import { targetLabelOf } from '../changes/changes-model';
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
import { useUiApi } from '../api/ui-api';
import { ManagementDialogs } from '../components/management/ManagementDialogs';
import { runReported } from '../components/notify-error';
import { SettingsModal } from '../components/settings/SettingsModal';
import { ShortcutsModal } from '../shortcuts/ShortcutsModal';
import { shellHotkeys } from '../shortcuts/shortcuts';
import { TransferModals } from '../components/transfers/TransferModals';
import { UpdateBanner } from '../components/updates/UpdateBanner';
import { ProfilerOpenerContext, type ProfilerOpener } from '../profiler/profiler-opener';
import type { AppData, PanelRequest } from '../state/app-store';
import { useAppStore, useAppStoreApi } from '../state/app-store-context';
import {
  PanelOpenerContext,
  type ConnectionPanelKind,
  type CollectionStatsRequest,
  type ConnectionPanelRequest,
  type DatabaseStatsRequest,
  type DiagnosticsPanelRequest,
  type OpenPanel,
  type UsersPanelRequest,
} from '../state/panel-opener';
import {
  changesPanelId,
  collectionStatsPanelId,
  databaseStatsPanelId,
  diagnosticsPanelId,
  gridfsPanelId,
  profilerPanelId,
  usersPanelId,
} from '../state/node-ids';
import { GridFsBucketDialogs } from '../components/gridfs/GridFsBucketDialogs';
import { GridFsOpenerContext, type GridFsOpener } from '../components/gridfs/gridfs-opener';
import { ChangesOpenerContext, type ChangesOpener } from '../changes/changes-opener';
import { databasePanelIds, restoredCollectionRequest, stalePanelIds } from './collection-panels';
import { createLayoutSaver, loadDockLayout, restoreDockLayout } from './dock-layout';
import { OUTPUT_SHARE, toggleOutputPanel } from './output-collapse';
import {
  ChangesDockPanel,
  ConnectionsPanel,
  DocumentsDockPanel,
  EditorDockPanel,
  ExplainDockPanel,
  ClosableTab,
  GroupHeaderActions,
  FixedTab,
  GridFsDockPanel,
  IndexesDockPanel,
  MonitorPanel,
  OperationsPanelView,
  OutputPanel,
  ProfilerDockPanel,
  ReplicationDockPanel,
  SchemaDockPanel,
  ShardingDockPanel,
  UsersDockPanel,
  DiagnosticsDockPanel,
  DatabaseStatsDockPanel,
  CollectionStatsDockPanel,
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
  sharding: ShardingDockPanel,
  replication: ReplicationDockPanel,
  indexes: IndexesDockPanel,
  validation: ValidationDockPanel,
  documents: DocumentsDockPanel,
  editor: EditorDockPanel,
  explain: ExplainDockPanel,
  schema: SchemaDockPanel,
  users: UsersDockPanel,
  gridfs: GridFsDockPanel,
  changes: ChangesDockPanel,
  diagnostics: DiagnosticsDockPanel,
  dbStats: DatabaseStatsDockPanel,
  collStats: CollectionStatsDockPanel,
};

const TAB_COMPONENTS = { fixed: FixedTab };

/**
 * Dockview's default theme is the navy "abyss" theme. This one keeps the dark structure and
 * takes its colours from theme/dockview-theme.css, which uses Mantine tokens.
 */
const MONGO_THEME: DockviewTheme = { ...themeDark, name: 'mongo-gui', className: 'mg-dockview' };

type ConnectionsState = AppData['connections'];

const SIDEBAR_WIDTH_PX = 280;
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
function handleDockReady({ api }: { readonly api: DockviewApi }) {
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
 * Registers the collection panels that a saved layout restored, so the stale-panel cleanup sees them.
 */
function registerRestoredPanels(api: DockviewApi, open: Map<string, PanelRequest>): void {
  for (const panel of api.panels) {
    const request = restoredCollectionRequest(panel.api.component, panel.params);
    if (request !== undefined) {
      open.set(panel.id, request);
    }
  }
}

/**
 * Restores the saved layout, or builds the default one when nothing is saved or the saved one does
 * not load. Layout changes are written from then on. Returns false when the dock was replaced
 * before the read finished, so the caller leaves it alone.
 */
async function initialiseLayout(
  event: DockviewReadyEvent,
  rpc: RpcClient,
  saver: ReturnType<typeof createLayoutSaver>,
  isCurrent: () => boolean,
  open: Map<string, PanelRequest>,
): Promise<void> {
  const saved = await loadDockLayout(rpc);
  if (!isCurrent()) {
    return;
  }
  if (!restoreDockLayout(event.api, saved)) {
    handleDockReady(event);
  }
  registerRestoredPanels(event.api, open);
  event.api.onDidLayoutChange(() => {
    saver.call(event.api.toJSON());
  });
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

const SUFFIX_BY_KIND: Readonly<Record<ConnectionPanelKind, string>> = {
  monitor: 'monitor',
  operations: 'operations',
  replication: 'replica set',
  sharding: 'sharding',
};

/**
 * Opens a connection's monitor or operations panel in the centre group. A panel that is already
 * open is brought to the front, so each connection has at most one of each.
 */
function openConnectionPanel(api: DockviewApi, request: ConnectionPanelRequest): void {
  const id = `${request.kind}:${request.connectionId}`;
  const existing = api.getPanel(id);
  if (existing !== undefined) {
    existing.api.setActive();
    return;
  }
  const suffix = SUFFIX_BY_KIND[request.kind];
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

/** Title of an editor tab: the connection and the database it runs against. */
function editorTitle(
  connections: ConnectionsState,
  connectionId: string,
  database: string,
): string {
  const name =
    connections.state === 'ready'
      ? connections.data.find((item) => item.id === connectionId)?.name
      : undefined;
  return `${name ?? 'Connection'} · ${database}`;
}

/**
 * Opens the users and roles panel of one database, or focuses it when it is open. One panel per
 * database, titled "<database> users and roles".
 */
function openUsersPanel(api: DockviewApi, request: UsersPanelRequest): void {
  const id = usersPanelId(request.connectionId, request.database);
  const existing = api.getPanel(id);
  if (existing !== undefined) {
    existing.api.setActive();
    return;
  }
  const centre = api.getPanel('welcome') === undefined ? undefined : 'welcome';
  api.addPanel({
    id,
    component: 'users',
    title: `${request.database} users and roles`,
    params: { connectionId: request.connectionId, database: request.database },
    ...(centre === undefined
      ? {}
      : { position: { referencePanel: centre, direction: 'within' as const } }),
  });
}

/**
 * Opens a connection's server diagnostics panel, or focuses it when it is open. One panel per
 * connection, titled "<connection> diagnostics".
 */
function openDiagnosticsPanel(api: DockviewApi, request: DiagnosticsPanelRequest): void {
  const id = diagnosticsPanelId(request.connectionId);
  const existing = api.getPanel(id);
  if (existing !== undefined) {
    existing.api.setActive();
    return;
  }
  const centre = api.getPanel('welcome') === undefined ? undefined : 'welcome';
  api.addPanel({
    id,
    component: 'diagnostics',
    title: `${request.connectionName} diagnostics`,
    params: { connectionId: request.connectionId },
    ...(centre === undefined
      ? {}
      : { position: { referencePanel: centre, direction: 'within' as const } }),
  });
}

/**
 * Opens the storage statistics panel of a database or a collection, or focuses it when it is
 * open. One panel per database or collection.
 */
function openStatsPanel(
  api: DockviewApi,
  request: DatabaseStatsRequest | CollectionStatsRequest,
): void {
  const isCollection = request.kind === 'collectionStats';
  const id = isCollection
    ? collectionStatsPanelId(request.connectionId, request.database, request.collection)
    : databaseStatsPanelId(request.connectionId, request.database);
  const existing = api.getPanel(id);
  if (existing !== undefined) {
    existing.api.setActive();
    return;
  }
  const centre = api.getPanel('welcome') === undefined ? undefined : 'welcome';
  const title = isCollection ? `${request.collection} stats` : `${request.database} stats`;
  api.addPanel({
    id,
    component: isCollection ? 'collStats' : 'dbStats',
    title,
    params: isCollection
      ? {
          connectionId: request.connectionId,
          database: request.database,
          collection: request.collection,
        }
      : { connectionId: request.connectionId, database: request.database },
    ...(centre === undefined
      ? {}
      : { position: { referencePanel: centre, direction: 'within' as const } }),
  });
}

/**
 * Adds the explain panel of the store to the centre group, or focuses it when it is open. The
 * panel reads its request and result from the store.
 */
function openExplainPanel(api: DockviewApi, id: string, title: string): void {
  if (api.getPanel(id) !== undefined) {
    return;
  }
  api.addPanel({
    id,
    component: 'explain',
    title,
    params: { panelId: id },
    position: { referencePanel: 'welcome', direction: 'within' },
  });
}

/**
 * Adds the change stream panel of a deployment, database or collection next to the welcome panel,
 * or focuses it when it is open.
 */
function openChangesPanel(api: DockviewApi, connectionId: string, target: ChangeTarget): void {
  const id = changesPanelId(connectionId, target);
  const existing = api.getPanel(id);
  if (existing !== undefined) {
    existing.api.setActive();
    return;
  }
  api.addPanel({
    id,
    component: 'changes',
    title: `${targetLabelOf(target)} changes`,
    params: { panelId: id, connectionId, target },
    position: { referencePanel: 'welcome', direction: 'within' },
  });
}

/**
 * Adds the file panel of a GridFS bucket next to the welcome panel, or focuses it when it is open.
 * One panel per bucket, titled "<database> · <bucket>".
 */
function openGridFsPanel(
  api: DockviewApi,
  connectionId: string,
  database: string,
  bucket: string,
): void {
  const id = gridfsPanelId(connectionId, database, bucket);
  const existing = api.getPanel(id);
  if (existing !== undefined) {
    existing.api.setActive();
    return;
  }
  api.addPanel({
    id,
    component: 'gridfs',
    title: `${database} · ${bucket}`,
    params: { connectionId, database, bucket },
    position: { referencePanel: 'welcome', direction: 'within' },
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
  const store = useAppStoreApi();
  const connections = useAppStore((state) => state.connections);
  const editorOrder = useAppStore((state) => state.editors.order);
  const editorTabs = useAppStore((state) => state.editors.tabs);
  const activeEditor = useAppStore((state) => state.editors.activeId);
  // The editor panels this shell opened, by tab id. Their state lives in the store.
  const editorPanels = useRef(new Set<string>());
  const explainPanels = useAppStore((state) => state.explainPanels);
  const explainFocus = useAppStore((state) => state.explainFocus);
  const closeExplainPanel = useAppStore((state) => state.closeExplainPanel);
  const dockApi = useRef<DockviewApi | undefined>(undefined);
  const [dock, setDock] = useState<DockviewApi | undefined>(undefined);
  // The collection panels this shell opened, by panel id.
  const collectionPanels = useRef(new Map<string, PanelRequest>());
  const { rpc } = useUiApi();
  const saver = useMemo(() => createLayoutSaver(rpc), [rpc]);
  useEffect(() => () => saver.cancel(), [saver]);
  const setShortcutsOpen = useAppStore((state) => state.setShortcutsOpen);
  const layoutRevision = useAppStore((state) => state.layoutRevision);
  // The revision seen at mount. Only a later change rebuilds the panels, so a remount keeps the layout.
  const seenRevision = useRef(layoutRevision);
  const openPanel = useCallback<OpenPanel>((request) => {
    if (dockApi.current === undefined) {
      return;
    }
    switch (request.kind) {
      case 'users':
        openUsersPanel(dockApi.current, request);
        return;
      case 'diagnostics':
        openDiagnosticsPanel(dockApi.current, request);
        return;
      case 'databaseStats':
        openStatsPanel(dockApi.current, request);
        return;
      case 'collectionStats':
        openStatsPanel(dockApi.current, request);
        return;
      default:
        openConnectionPanel(dockApi.current, request);
    }
  }, []);
  const changesOpener = useMemo<ChangesOpener>(
    () => ({
      open(connectionId, target) {
        if (dockApi.current !== undefined) {
          openChangesPanel(dockApi.current, connectionId, target);
        }
      },
    }),
    [],
  );
  const gridfsOpener = useMemo<GridFsOpener>(
    () => ({
      open(connectionId, database, bucket) {
        if (dockApi.current !== undefined) {
          openGridFsPanel(dockApi.current, connectionId, database, bucket);
        }
      },
      close(connectionId, database, bucket) {
        if (dockApi.current !== undefined) {
          removePanelById(dockApi.current, gridfsPanelId(connectionId, database, bucket));
        }
      },
    }),
    [],
  );
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

  // A reset from settings clears the dock and rebuilds the default panels.
  useEffect(() => {
    if (dock === undefined || seenRevision.current === layoutRevision) {
      return;
    }
    seenRevision.current = layoutRevision;
    dock.clear();
    collectionPanels.current.clear();
    handleDockReady({ api: dock });
  }, [dock, layoutRevision]);

  useHotkeys(
    shellHotkeys({
      openSettings: () => setSettingsOpen(true),
      lock: () => void runReported(() => lock()),
      openHelp: () => setShortcutsOpen(true),
      toggleOutput: () => {
        if (dock !== undefined) {
          toggleOutputPanel(dock);
        }
      },
    }),
  );

  // Adds the explain panels the store holds, then shows the one a request asked for.
  useEffect(() => {
    if (dock === undefined) {
      return;
    }
    for (const panel of Object.values(explainPanels)) {
      openExplainPanel(dock, panel.id, panel.title);
    }
  }, [dock, explainPanels]);

  useEffect(() => {
    if (dock === undefined || explainFocus === undefined) {
      return;
    }
    dock.getPanel(explainFocus.id)?.api.setActive();
  }, [dock, explainFocus]);

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

  // Adds a panel for each open tab and removes the panels of closed tabs. Titles follow the tab.
  useEffect(() => {
    if (dock === undefined) {
      return;
    }
    const open = new Set(editorOrder);
    for (const id of [...editorPanels.current]) {
      if (!open.has(id)) {
        editorPanels.current.delete(id);
        removePanelById(dock, id);
      }
    }
    for (const id of editorOrder) {
      const tab = editorTabs[id];
      if (tab === undefined) {
        continue;
      }
      const title = editorTitle(connections, tab.connectionId, tab.database);
      const panel = dock.getPanel(id);
      if (panel === undefined) {
        dock.addPanel({
          id,
          component: 'editor',
          title,
          params: { tabId: id },
          position: { referencePanel: 'welcome' },
        });
        editorPanels.current.add(id);
      } else if (panel.title !== title) {
        panel.api.setTitle(title);
      }
    }
  }, [dock, editorOrder, editorTabs, connections]);

  // Brings the active tab's panel to the front when the store changes the active tab.
  useEffect(() => {
    if (dock !== undefined && activeEditor !== undefined) {
      dock.getPanel(activeEditor)?.api.setActive();
    }
  }, [dock, activeEditor]);

  // Ctrl+N opens a new editor on the selected connection, and on the selected database when there is one.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (
        event.key.toLowerCase() !== 'n' ||
        !(event.ctrlKey || event.metaKey) ||
        event.shiftKey ||
        event.altKey
      ) {
        return;
      }
      const state = store.getState();
      const selection = state.selection;
      if (selection === undefined) {
        return;
      }
      event.preventDefault();
      const loaded = state.databases[selection.connectionId];
      const first = loaded?.state === 'ready' ? loaded.data[0]?.name : undefined;
      state.openEditor({
        connectionId: selection.connectionId,
        database: selection.database ?? first ?? 'admin',
        newTab: true,
      });
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [store]);

  return (
    <PanelOpenerContext.Provider value={openPanel}>
      <ProfilerOpenerContext.Provider value={profilerOpener}>
        <GridFsOpenerContext.Provider value={gridfsOpener}>
          <ChangesOpenerContext.Provider value={changesOpener}>
            <Flex direction="column" h="100vh" style={{ overflow: 'hidden' }}>
              <Group
                h={40}
                px={8}
                justify="space-between"
                wrap="nowrap"
                gap={8}
                style={{ borderBottom: '1px solid var(--mg-border)', flex: '0 0 auto' }}
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
                  <Menu position="bottom-end" withinPortal>
                    <Menu.Target>
                      <Button variant="default" leftSection={<IconHelp size={14} />}>
                        Help
                      </Button>
                    </Menu.Target>
                    <Menu.Dropdown>
                      <Menu.Item
                        leftSection={<IconKeyboard size={14} />}
                        onClick={() => setShortcutsOpen(true)}
                      >
                        Keyboard shortcuts
                      </Menu.Item>
                    </Menu.Dropdown>
                  </Menu>
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
                    defaultTabComponent={ClosableTab}
                    rightHeaderActionsComponent={GroupHeaderActions}
                    onReady={(event) => {
                      dockApi.current = event.api;
                      setDock(event.api);
                      event.api.onDidRemovePanel((panel) => {
                        collectionPanels.current.delete(panel.id);
                        stopSamplerWhenUnused(event.api, panel.id, stopMonitor);
                        // Closing an editor tab removes it from the store, which the sync effect then sees.
                        if (editorPanels.current.delete(panel.id)) {
                          store.getState().closeEditor(panel.id);
                        }
                        if (panel.id.startsWith('explain:')) {
                          closeExplainPanel(panel.id);
                        }
                      });
                      void initialiseLayout(
                        event,
                        rpc,
                        saver,
                        () => dockApi.current === event.api,
                        collectionPanels.current,
                      );
                      event.api.onDidActivePanelChange(({ panel }) => {
                        if (panel !== undefined && editorPanels.current.has(panel.id)) {
                          store.getState().activateEditor(panel.id);
                        }
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
              <GridFsBucketDialogs />
              <ConnectionManager />
              <SettingsModal />
              <ShortcutsModal />
              <TransferModals />
            </Flex>
          </ChangesOpenerContext.Provider>
        </GridFsOpenerContext.Provider>
      </ProfilerOpenerContext.Provider>
    </PanelOpenerContext.Provider>
  );
}
