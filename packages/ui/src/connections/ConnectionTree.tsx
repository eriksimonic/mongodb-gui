import {
  ActionIcon,
  Alert,
  Button,
  CloseButton,
  Group,
  Loader,
  Stack,
  Text,
  Tooltip,
} from '@mantine/core';
import { IconPlus, IconRefresh, IconSearch } from '@tabler/icons-react';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react';
import type { ConnectionProfileSummary, ConnectionStatus } from '@mongo-gui/core';
import type { Selection } from '../state/app-store';
import { useAppStore, useAppStoreApi } from '../state/app-store-context';
import { usePanelOpener } from '../state/panel-opener';
import {
  GRIDFS_NODE_PREFIX,
  catalogKey,
  connectionNodeId,
  databaseNodeId,
} from '../state/node-ids';
import { useProfilerOpener } from '../profiler';
import { useGridFsOpener } from '../gridfs';
import { GridFsBucketContextMenu } from '../gridfs';
import { runReported } from '../kit/notify-error';
import { ConnectionContextMenu } from './ConnectionContextMenu';
import { DockerContainerContextMenu } from './DockerContainerContextMenu';
import { DockerLinkedContextMenu } from './DockerLinkedContextMenu';
import { DockerNodeContextMenu } from './DockerNodeContextMenu';
import { MemberContextMenu } from './MemberContextMenu';
import { CollectionContextMenu, DatabaseContextMenu } from './CatalogContextMenu';
import {
  FOCUS_TREE_SEARCH_EVENT,
  NAME_CATALOG_DEBOUNCE_MS,
  NAME_CATALOG_MAX_AGE_MS,
} from './search-constants';
import { TreeMessage, TreeRow } from './TreeRow';
import {
  buildTreeRows,
  edgeFocusKey,
  firstChildKey,
  indexTreeRows,
  SEARCH_RESULT_CAP,
  searchTreeIndex,
  searchTreeInput,
  type TreeInput,
  focusableRows,
  nextFocusKey,
  parentKeyOf,
  type TreeRow as TreeRowModel,
} from './tree-model';

const DISCONNECTED: ConnectionStatus = { state: 'disconnected' };

type MenuTarget =
  | { readonly kind: 'connection'; readonly connectionId: string }
  | { readonly kind: 'linked'; readonly connectionId: string }
  | { readonly kind: 'container'; readonly containerId: string }
  | { readonly kind: 'docker' }
  | { readonly kind: 'member'; readonly connectionId: string; readonly host: string }
  | { readonly kind: 'database'; readonly connectionId: string; readonly database: string }
  | {
      readonly kind: 'gridfsBucket';
      readonly connectionId: string;
      readonly database: string;
      readonly bucket: string;
    }
  | {
      readonly kind: 'collection';
      readonly connectionId: string;
      readonly database: string;
      readonly collection: string;
    };

interface MenuAnchor {
  readonly target: MenuTarget;
  readonly x: number;
  readonly y: number;
}

function selectionFor(row: TreeRowModel): Selection | undefined {
  if (row.kind !== 'connection' && row.kind !== 'database' && row.kind !== 'collection') {
    return undefined;
  }
  return {
    connectionId: row.connectionId,
    database: row.database,
    collection: row.collection,
  };
}

function isSelected(row: TreeRowModel, selection: Selection | undefined): boolean {
  if (selection === undefined || selection.connectionId !== row.connectionId) {
    return false;
  }
  if (row.kind === 'connection') {
    return selection.database === undefined;
  }
  if (row.kind === 'database') {
    return selection.database === row.database && selection.collection === undefined;
  }
  return row.kind === 'collection' && selection.collection === row.collection;
}

function isAncestor(row: TreeRowModel, selection: Selection | undefined): boolean {
  if (selection === undefined || selection.connectionId !== row.connectionId) {
    return false;
  }
  if (row.kind === 'connection') {
    return selection.database !== undefined;
  }
  return (
    row.kind === 'database' &&
    selection.database === row.database &&
    selection.collection !== undefined
  );
}

function canConnect(status: ConnectionStatus | undefined): boolean {
  return status === undefined || status.state === 'disconnected' || status.state === 'error';
}

function menuTargetFor(
  row: TreeRowModel,
  connections: readonly ConnectionProfileSummary[],
): MenuTarget | undefined {
  switch (row.kind) {
    case 'connection': {
      // A docker profile gets the combined menu: connection actions plus container details.
      const profile = connections.find((item) => item.id === row.connectionId);
      return profile?.source === 'docker'
        ? { kind: 'linked', connectionId: row.connectionId }
        : { kind: 'connection', connectionId: row.connectionId };
    }
    case 'container':
      return row.container === undefined
        ? undefined
        : { kind: 'container', containerId: row.container.id };
    case 'docker':
      return { kind: 'docker' };
    case 'member':
      return row.member === undefined
        ? undefined
        : { kind: 'member', connectionId: row.connectionId, host: row.member.name };
    case 'database':
      return row.database === undefined
        ? undefined
        : { kind: 'database', connectionId: row.connectionId, database: row.database };
    case 'collection':
      return row.database === undefined || row.collection === undefined
        ? undefined
        : {
            kind: 'collection',
            connectionId: row.connectionId,
            database: row.database,
            collection: row.collection,
          };
    case 'gridfs-bucket':
      return row.database === undefined || row.bucket === undefined
        ? undefined
        : {
            kind: 'gridfsBucket',
            connectionId: row.connectionId,
            database: row.database,
            bucket: row.bucket,
          };
    default:
      return undefined;
  }
}

/**
 * The Connections panel. A flat `role="tree"` with roving focus. Arrow keys move, Right and Left
 * expand and collapse, Enter opens, Shift+F10 or the menu key opens the context menu. The Docker
 * node at the bottom lists discovered containers. A click or Enter on one connects it.
 */
export function ConnectionTree() {
  const connections = useAppStore((state) => state.connections);
  const statuses = useAppStore((state) => state.statuses);
  const expanded = useAppStore((state) => state.expanded);
  const treeDensity = useAppStore((state) => state.settings?.treeDensity ?? 'compact');
  const databases = useAppStore((state) => state.databases);
  const collections = useAppStore((state) => state.collections);
  const selection = useAppStore((state) => state.selection);
  const docker = useAppStore((state) => state.docker);
  const setDialog = useAppStore((state) => state.setDialog);
  const setNodeExpanded = useAppStore((state) => state.setNodeExpanded);
  const expandConnection = useAppStore((state) => state.expandConnection);
  const connect = useAppStore((state) => state.connect);
  const loadDatabases = useAppStore((state) => state.loadDatabases);
  const loadCollections = useAppStore((state) => state.loadCollections);
  const gridfsBuckets = useAppStore((state) => state.gridfsBuckets);
  const loadGridFsBuckets = useAppStore((state) => state.loadGridFsBuckets);
  const replicaSets = useAppStore((state) => state.replicaSets);
  const loadReplicaSet = useAppStore((state) => state.loadReplicaSet);
  const connectDirectly = useAppStore((state) => state.connectDirectly);
  const gridfsOpener = useGridFsOpener();
  const select = useAppStore((state) => state.select);
  const loadDocker = useAppStore((state) => state.loadDocker);
  const watchDocker = useAppStore((state) => state.watchDocker);
  const connectContainer = useAppStore((state) => state.connectContainer);
  const openPanel = usePanelOpener();
  const profilerOpener = useProfilerOpener();
  const openEditor = useAppStore((state) => state.openEditor);
  const requestPanel = useAppStore((state) => state.requestPanel);
  const [focusKey, setFocusKey] = useState<string | undefined>(undefined);
  const [menu, setMenu] = useState<MenuAnchor | undefined>(undefined);
  const searchInput = useRef<HTMLInputElement>(null);
  const items = useRef(new Map<string, HTMLDivElement>());
  // A double click sends two clicks. This set keeps one connect call per container in flight.
  const connectingContainers = useRef(new Set<string>());
  const list = connections.state === 'ready' ? connections.data : undefined;

  useEffect(() => {
    void loadDocker();
    void watchDocker(true);
    return () => {
      void watchDocker(false);
    };
  }, [loadDocker, watchDocker]);

  const nameCatalogs = useAppStore((state) => state.nameCatalogs);
  const loadNameCatalog = useAppStore((state) => state.loadNameCatalog);
  const storeApi = useAppStoreApi();
  const baseInput = useMemo<TreeInput | undefined>(
    () =>
      list === undefined
        ? undefined
        : {
            connections: list,
            statuses,
            expanded,
            databases,
            collections,
            docker: { status: docker.status, containers: docker.containers },
            gridfs: gridfsBuckets,
            replicaSets,
          },
    [list, statuses, expanded, databases, collections, docker, gridfsBuckets, replicaSets],
  );
  const allRows = useMemo(
    () => (baseInput === undefined ? [] : buildTreeRows(baseInput)),
    [baseInput],
  );
  const [search, setSearch] = useState('');
  const [revealKey, setRevealKey] = useState<string | undefined>(undefined);
  const searching = search.trim() !== '';
  // Built once per catalog change, not per keystroke. Typing only runs one pass over the names.
  const searchIndex = useMemo(() => {
    if (!searching || baseInput === undefined) {
      return undefined;
    }
    const names = Object.fromEntries(
      Object.entries(nameCatalogs).flatMap(([id, catalog]) =>
        catalog.data === undefined ? [] : [[id, catalog.data] as const],
      ),
    );
    return indexTreeRows(buildTreeRows(searchTreeInput(baseInput, names)));
    // `searching` only flips when the first character is typed or the box is emptied.
  }, [searching, baseInput, nameCatalogs]);
  const found = useMemo(
    () => (searchIndex === undefined ? undefined : searchTreeIndex(searchIndex, search)),
    [searchIndex, search],
  );
  const connectedIds = (list ?? [])
    .filter((connection) => statuses[connection.id]?.state === 'connected')
    .map((connection) => connection.id);
  const connectedKey = connectedIds.join(',');
  const fetching = connectedIds.some((id) => nameCatalogs[id]?.status === 'loading');
  const catalogsLoading = connectedIds.some((id) => {
    const catalog = nameCatalogs[id];
    return catalog === undefined || (catalog.status === 'loading' && catalog.data === undefined);
  });
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!searching) {
      return undefined;
    }
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [searching]);
  const updatedAt = connectedIds
    .map((id) => nameCatalogs[id]?.fetchedAt)
    .filter((at): at is number => at !== undefined)
    .reduce<number | undefined>(
      (oldest, at) => (oldest === undefined ? at : Math.min(oldest, at)),
      undefined,
    );

  useEffect(() => {
    function focusSearch() {
      searchInput.current?.focus();
      searchInput.current?.select();
    }
    window.addEventListener(FOCUS_TREE_SEARCH_EVENT, focusSearch);
    return () => window.removeEventListener(FOCUS_TREE_SEARCH_EVENT, focusSearch);
  }, []);

  useEffect(() => {
    if (revealKey === undefined) {
      return;
    }
    const element = items.current.get(revealKey);
    if (element !== undefined) {
      setFocusKey(revealKey);
      element.focus();
      element.scrollIntoView?.({ block: 'nearest' });
      setRevealKey(undefined);
    }
  }, [revealKey, allRows, searching]);

  // A search fetches the names of a connected server the first time at once, and again after a
  // pause in typing when the cached names are older than the limit. Never two fetches at once.
  useEffect(() => {
    if (!searching) {
      return undefined;
    }
    const ids = connectedKey === '' ? [] : connectedKey.split(',');
    const stale = (id: string): boolean => {
      const catalog = storeApi.getState().nameCatalogs[id];
      return (
        catalog?.status !== 'loading' &&
        (catalog === undefined ||
          catalog.fetchedAt === undefined ||
          Date.now() - catalog.fetchedAt > NAME_CATALOG_MAX_AGE_MS)
      );
    };
    for (const id of ids) {
      if (storeApi.getState().nameCatalogs[id] === undefined) {
        void loadNameCatalog(id);
      }
    }
    const timer = setTimeout(() => {
      for (const id of ids) {
        if (stale(id)) {
          void loadNameCatalog(id);
        }
      }
    }, NAME_CATALOG_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [searching, search, connectedKey, loadNameCatalog, storeApi]);

  const rows = useMemo(() => (found !== undefined ? found.rows : allRows), [found, allRows]);

  // An open connection that reports a set name loads its members once, so the primary shows.
  useEffect(() => {
    if (list === undefined) {
      return;
    }
    for (const connection of list) {
      const status = statuses[connection.id];
      if (
        expanded[connectionNodeId(connection.id)] === true &&
        status?.state === 'connected' &&
        status.setName !== undefined &&
        replicaSets[connection.id] === undefined
      ) {
        void loadReplicaSet(connection.id);
      }
    }
  }, [list, statuses, expanded, replicaSets, loadReplicaSet]);

  useEffect(() => {
    if (list === undefined) {
      return;
    }
    for (const connection of list) {
      if (expanded[connectionNodeId(connection.id)] !== true) {
        continue;
      }
      if (statuses[connection.id]?.state !== 'connected') {
        continue;
      }
      const loaded = databases[connection.id];
      if (loaded === undefined) {
        void loadDatabases(connection.id);
      }
      if (loaded?.state !== 'ready') {
        continue;
      }
      for (const database of loaded.data) {
        const open = expanded[databaseNodeId(connection.id, database.name)] === true;
        if (open && collections[catalogKey(connection.id, database.name)] === undefined) {
          void loadCollections(connection.id, database.name);
        }
      }
    }
  }, [list, statuses, expanded, databases, collections, loadDatabases, loadCollections]);

  // An open GridFS node loads the buckets of its database, once per connected database.
  useEffect(() => {
    for (const [key, open] of Object.entries(expanded)) {
      if (!open || !key.startsWith(GRIDFS_NODE_PREFIX)) {
        continue;
      }
      const catalog = key.slice(GRIDFS_NODE_PREFIX.length);
      const separator = catalog.indexOf('/');
      const connectionId = catalog.slice(0, separator);
      if (statuses[connectionId]?.state !== 'connected' || gridfsBuckets[catalog] !== undefined) {
        continue;
      }
      void loadGridFsBuckets(connectionId, catalog.slice(separator + 1));
    }
  }, [expanded, statuses, gridfsBuckets, loadGridFsBuckets]);

  if (connections.state === 'loading') {
    return <Loader size="xs" aria-label="Loading connections" />;
  }
  if (connections.state === 'error') {
    return (
      <Alert color="red" variant="light" p="xs">
        {connections.error.message}
      </Alert>
    );
  }

  const readyConnections = connections.data;
  const focusable = focusableRows(rows);
  const activeKey = focusable.some((row) => row.key === focusKey) ? focusKey : focusable[0]?.key;

  function focusRow(key: string) {
    setFocusKey(key);
    items.current.get(key)?.focus();
  }

  function expandRow(row: TreeRowModel) {
    if (row.kind === 'connection') {
      void expandConnection(row.connectionId);
    } else {
      setNodeExpanded(row.key, true);
    }
  }

  function toggleRow(row: TreeRowModel) {
    if (row.expanded) {
      setNodeExpanded(row.key, false);
    } else {
      expandRow(row);
    }
  }

  /**
   * A search result may sit in a database the tree never opened. Opens the connection and the
   * database, loads its collections with stats, selects the row and leaves the search so the
   * real row shows. The effect below focuses it once it is rendered.
   */
  function revealRow(row: TreeRowModel) {
    setNodeExpanded(connectionNodeId(row.connectionId), true);
    if (row.database !== undefined) {
      setNodeExpanded(databaseNodeId(row.connectionId, row.database), true);
      void loadCollections(row.connectionId, row.database);
    }
    selectRow(row);
    setSearch('');
    setRevealKey(row.key);
  }

  function selectRow(row: TreeRowModel) {
    const next = selectionFor(row);
    if (next !== undefined) {
      select(next);
    }
  }

  function connectRow(row: TreeRowModel) {
    const container = row.container;
    if (container === undefined || connectingContainers.current.has(container.id)) {
      return;
    }
    connectingContainers.current.add(container.id);
    void runReported(() => connectContainer(container.id)).finally(() => {
      connectingContainers.current.delete(container.id);
    });
  }

  /** Monitoring, Operations and the replica set node open their panel in the centre group. */
  function openToolRow(row: TreeRowModel) {
    if (row.kind === 'member') {
      openMemberRow(row);
      return;
    }
    if (row.kind !== 'monitor' && row.kind !== 'operations' && row.kind !== 'replica-set') {
      return;
    }
    const connectionName =
      readyConnections.find((item) => item.id === row.connectionId)?.name ?? '';
    const kind =
      row.kind === 'monitor' ? 'monitor' : row.kind === 'operations' ? 'operations' : 'replication';
    openPanel({ kind, connectionId: row.connectionId, connectionName });
  }

  /** A member opens a direct connection to that host, unless the connection is already that. */
  function openMemberRow(row: TreeRowModel) {
    if (row.member === undefined || isSelfDirect(row)) {
      return;
    }
    void runReported(() => connectDirectly(row.connectionId, row.member?.name ?? ''));
  }

  /** True when the row's connection already talks to this member only. */
  function isSelfDirect(row: TreeRowModel): boolean {
    const status = statuses[row.connectionId];
    return (
      row.member?.self === true && status?.state === 'connected' && status.directConnection === true
    );
  }

  /** A database opens a query editor on it, or focuses the one already open there. */
  function openDatabaseEditor(row: TreeRowModel) {
    if (row.database !== undefined) {
      openEditor({ connectionId: row.connectionId, database: row.database });
    }
  }

  /** A collection opens a query tab that lists its documents. */
  function openCollectionRow(row: TreeRowModel) {
    if (row.database !== undefined && row.collection !== undefined) {
      requestPanel({
        panel: 'documents',
        connectionId: row.connectionId,
        database: row.database,
        collection: row.collection,
      });
    }
  }

  /** A bucket opens its file panel in the centre group. */
  function openGridFsBucket(row: TreeRowModel) {
    if (row.database !== undefined && row.bucket !== undefined) {
      gridfsOpener?.open(row.connectionId, row.database, row.bucket);
    }
  }

  /** The profiler of a database opens its panel in the centre group. */
  function openProfiler(row: TreeRowModel) {
    if (row.database !== undefined) {
      profilerOpener?.open(row.connectionId, row.database);
    }
  }

  /** Enter opens a collapsed connection, which also connects it. On an open one it connects if needed. */
  function openRow(row: TreeRowModel) {
    if (row.kind === 'docker') {
      toggleRow(row);
      return;
    }
    if (row.kind === 'container') {
      connectRow(row);
      return;
    }
    selectRow(row);
    if (row.kind === 'gridfs-bucket') {
      openGridFsBucket(row);
      return;
    }
    if (row.kind === 'profiler') {
      openProfiler(row);
      return;
    }
    if (row.kind === 'database') {
      openDatabaseEditor(row);
      return;
    }
    if (row.kind === 'collection') {
      openCollectionRow(row);
      return;
    }
    if (row.kind !== 'connection') {
      openToolRow(row);
      return;
    }
    if (!row.expanded) {
      expandRow(row);
    } else if (canConnect(statuses[row.connectionId])) {
      void connect(row.connectionId);
    }
  }

  function openMenuFor(row: TreeRowModel) {
    const rect = items.current.get(row.key)?.getBoundingClientRect();
    const x = rect === undefined ? 0 : rect.left + 12;
    const y = rect === undefined ? 0 : rect.bottom;
    const target = menuTargetFor(row, readyConnections);
    if (target === undefined) {
      return;
    }
    setMenu({ target, x, y });
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    // The key event belongs to the row that has focus, so that row is the one to act on.
    const targetKey =
      event.target instanceof Element
        ? event.target.closest('[data-key]')?.getAttribute('data-key')
        : undefined;
    const row = rows.find((item) => item.key === (targetKey ?? activeKey));
    if (row === undefined) {
      return;
    }
    let target: string | undefined;
    if (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) {
      openMenuFor(row);
    } else if (event.key === 'ArrowDown') {
      target = nextFocusKey(rows, row.key, 1);
    } else if (event.key === 'ArrowUp') {
      target = nextFocusKey(rows, row.key, -1);
    } else if (event.key === 'Home') {
      target = edgeFocusKey(rows, 'first');
    } else if (event.key === 'End') {
      target = edgeFocusKey(rows, 'last');
    } else if (event.key === 'ArrowRight') {
      if (row.kind === 'connection' && canConnect(statuses[row.connectionId])) {
        void connect(row.connectionId);
      } else if (row.expandable && !row.expanded) {
        expandRow(row);
      } else {
        target = firstChildKey(rows, row.key);
      }
    } else if (event.key === 'ArrowLeft') {
      if (row.expandable && row.expanded) {
        setNodeExpanded(row.key, false);
      } else {
        target = parentKeyOf(rows, row.key);
      }
    } else if (event.key === 'Enter') {
      if (found !== undefined && (row.kind === 'database' || row.kind === 'collection')) {
        revealRow(row);
      }
      openRow(row);
    } else {
      return;
    }
    event.preventDefault();
    if (target !== undefined) {
      focusRow(target);
    }
  }

  function handleContextMenu(row: TreeRowModel, event: MouseEvent<HTMLDivElement>) {
    event.preventDefault();
    const target = menuTargetFor(row, readyConnections);
    if (target !== undefined) {
      setMenu({ target, x: event.clientX, y: event.clientY });
    }
  }

  function closeMenu() {
    setMenu(undefined);
  }

  function renderMenu(anchor: MenuAnchor) {
    const position = { x: anchor.x, y: anchor.y };
    const target = anchor.target;
    if (target.kind === 'connection') {
      const connection = readyConnections.find((item) => item.id === target.connectionId);
      if (connection === undefined) {
        return null;
      }
      return (
        <ConnectionContextMenu
          connection={connection}
          status={statuses[connection.id] ?? DISCONNECTED}
          position={position}
          onClose={closeMenu}
        />
      );
    }
    if (target.kind === 'linked') {
      const connection = readyConnections.find((item) => item.id === target.connectionId);
      if (connection === undefined) {
        return null;
      }
      const container =
        docker.containers.state === 'ready'
          ? docker.containers.data.find((item) => item.id === connection.dockerContainerId)
          : undefined;
      return (
        <DockerLinkedContextMenu
          connection={connection}
          container={container}
          status={statuses[connection.id] ?? DISCONNECTED}
          position={position}
          onClose={closeMenu}
        />
      );
    }
    if (target.kind === 'member') {
      const connection = readyConnections.find((item) => item.id === target.connectionId);
      const row = rows.find((item) => item.kind === 'member' && item.member?.name === target.host);
      return (
        <MemberContextMenu
          connectionId={target.connectionId}
          connectionName={connection?.name ?? ''}
          host={target.host}
          isSelfDirect={row === undefined ? false : isSelfDirect(row)}
          position={position}
          onClose={closeMenu}
        />
      );
    }
    if (target.kind === 'docker') {
      return (
        <DockerNodeContextMenu
          autoConnect={docker.autoConnect}
          position={position}
          onClose={closeMenu}
        />
      );
    }
    if (target.kind === 'database') {
      return (
        <DatabaseContextMenu
          connectionId={target.connectionId}
          database={target.database}
          position={position}
          onClose={closeMenu}
        />
      );
    }
    if (target.kind === 'gridfsBucket') {
      return (
        <GridFsBucketContextMenu
          connectionId={target.connectionId}
          database={target.database}
          bucket={target.bucket}
          position={position}
          onClose={closeMenu}
        />
      );
    }
    if (target.kind === 'collection') {
      return (
        <CollectionContextMenu
          connectionId={target.connectionId}
          database={target.database}
          collection={target.collection}
          position={position}
          onClose={closeMenu}
        />
      );
    }
    const container =
      docker.containers.state === 'ready'
        ? docker.containers.data.find((item) => item.id === target.containerId)
        : undefined;
    if (container === undefined) {
      return null;
    }
    const profile = readyConnections.find((item) => item.dockerContainerId === container.id);
    return (
      <DockerContainerContextMenu
        container={container}
        profile={profile}
        status={profile === undefined ? undefined : statuses[profile.id]}
        position={position}
        onClose={closeMenu}
      />
    );
  }

  const hasConnections = readyConnections.length > 0;

  return (
    <div className="mg-tree-panel">
      <div className="mg-tree-top">
        {hasConnections ? null : (
          <Stack gap="xs" align="flex-start" mb="xs">
            <Text size="sm" c="dimmed">
              No connections yet.
            </Text>
            <Button
              size="xs"
              variant="light"
              leftSection={<IconPlus size={14} />}
              onClick={() => setDialog({ kind: 'create' })}
            >
              New connection
            </Button>
          </Stack>
        )}
        <div className="mg-tree-search" data-searching={searching ? 'true' : undefined}>
          <IconSearch size={14} aria-hidden="true" />
          <input
            ref={searchInput}
            type="text"
            aria-label="Search databases and collections"
            placeholder="Search databases and collections"
            value={search}
            onChange={(event) => setSearch(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                setSearch('');
                const first = focusableRows(rows)[0];
                if (first !== undefined) {
                  focusRow(activeKey ?? first.key);
                }
              } else if (event.key === 'Enter' && found !== undefined) {
                const first = found.rows.find(
                  (row) => row.kind === 'database' || row.kind === 'collection',
                );
                if (first !== undefined) {
                  revealRow(first);
                  openRow(first);
                }
              } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                const list = focusableRows(rows);
                const target = event.key === 'ArrowDown' ? list[0] : list[list.length - 1];
                if (target !== undefined) {
                  event.preventDefault();
                  focusRow(target.key);
                }
              }
            }}
          />
          {searching ? (
            <>
              <Tooltip label="Reload names from the servers" withinPortal>
                <ActionIcon
                  size="xs"
                  variant="subtle"
                  aria-label="Reload names from the servers"
                  disabled={fetching || connectedIds.length === 0}
                  onClick={() => {
                    for (const id of connectedIds) {
                      void loadNameCatalog(id);
                    }
                  }}
                >
                  {fetching ? <Loader size={10} /> : <IconRefresh size={12} />}
                </ActionIcon>
              </Tooltip>
              <CloseButton size="xs" aria-label="Clear the search" onClick={() => setSearch('')} />
            </>
          ) : null}
        </div>
        {found === undefined ? null : (
          <Group gap={6} wrap="wrap" className="mg-tree-search-scope">
            <Text size="xs" c="dimmed">
              In connected servers
            </Text>
            {(list ?? [])
              .filter((connection) => statuses[connection.id]?.state === 'connected')
              .map((connection) => (
                <span key={connection.id} className="mg-tree-chip">
                  {connection.name}
                </span>
              ))}
          </Group>
        )}
      </div>
      <div className="mg-tree-scroll">
        <div
          role="tree"
          aria-label="Connections"
          className="mg-tree"
          data-density={treeDensity}
          onKeyDown={handleKeyDown}
        >
          {rows.map((row) =>
            row.kind === 'message' ? (
              <TreeMessage key={row.key} row={row} />
            ) : (
              <TreeRow
                key={row.key}
                row={row}
                focused={row.key === activeKey}
                selected={isSelected(row, selection)}
                ancestor={isAncestor(row, selection)}
                highlight={searching ? search.trim() : undefined}
                setRef={(key, element) => {
                  if (element === null) {
                    items.current.delete(key);
                  } else {
                    items.current.set(key, element);
                  }
                }}
                onFocusRow={setFocusKey}
                onToggle={() => toggleRow(row)}
                onSelect={() => {
                  if (row.kind === 'container') {
                    connectRow(row);
                  } else if (
                    found !== undefined &&
                    (row.kind === 'database' || row.kind === 'collection')
                  ) {
                    revealRow(row);
                  } else {
                    selectRow(row);
                  }
                }}
                onDoubleClick={() => {
                  if (row.kind === 'profiler') {
                    openProfiler(row);
                  } else if (row.kind === 'database') {
                    openDatabaseEditor(row);
                  } else if (row.kind === 'gridfs-bucket') {
                    openGridFsBucket(row);
                  } else if (row.kind === 'collection') {
                    openCollectionRow(row);
                  } else if (row.kind !== 'connection') {
                    openToolRow(row);
                  } else if (canConnect(statuses[row.connectionId])) {
                    void connect(row.connectionId);
                  }
                }}
                onContextMenu={(event) => handleContextMenu(row, event)}
              />
            ),
          )}
          {menu === undefined ? null : renderMenu(menu)}
        </div>
      </div>
      {found === undefined ? null : (
        <div className="mg-tree-footer">
          {found.matches === 0 ? (
            <Text size="xs" c="dimmed" className="mg-tree-search-count">
              {!Object.values(statuses).some((status) => status.state === 'connected')
                ? 'Connect a server to search'
                : catalogsLoading
                  ? 'Searching...'
                  : 'No matches'}
            </Text>
          ) : null}
          {found === undefined || found.matches === 0 ? null : (
            <Text size="xs" c="dimmed" className="mg-tree-search-count">
              {found.matches} {found.matches === 1 ? 'match' : 'matches'} in {found.databases}{' '}
              {found.databases === 1 ? 'database' : 'databases'}
            </Text>
          )}
          {found !== undefined && found.capped ? (
            <Text size="xs" c="dimmed" className="mg-tree-search-count">
              Showing first {SEARCH_RESULT_CAP} of {found.matches}, refine the search
            </Text>
          ) : null}
          {found === undefined || connectedIds.length === 0 ? null : (
            <Text size="xs" c="dimmed" className="mg-tree-search-count" data-testid="names-updated">
              {fetching || updatedAt === undefined
                ? 'Loading...'
                : `Updated ${Math.max(0, Math.round((now - updatedAt) / 1000))} s ago`}
            </Text>
          )}
        </div>
      )}
    </div>
  );
}
