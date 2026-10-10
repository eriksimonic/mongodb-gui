import { ActionIcon, Stack, Text, Tooltip } from '@mantine/core';
import { useVirtualizer } from '@tanstack/react-virtual';
import { IconPlayerPlay, IconTrash } from '@tabler/icons-react';
import type { Favourite } from '@mongo-gui/core';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useUiApi } from '../../api/ui-api';
import { useAppStore, useAppStoreApi } from '../../state/app-store-context';
import { errorText, notifyError } from '../notify-error';
import { firstLine } from './labels';

const ROW_HEIGHT_PX = 44;
const HEADER_HEIGHT_PX = 26;
const UNFILED = 'Unfiled';

type Row =
  | { readonly kind: 'folder'; readonly key: string; readonly folder: string }
  | { readonly kind: 'favourite'; readonly key: string; readonly favourite: Favourite };

/** Folder headers and their favourites, in one flat list for the virtualiser. Folders sort by name. */
function favouriteRows(favourites: readonly Favourite[]): Row[] {
  const groups = new Map<string, Favourite[]>();
  for (const favourite of favourites) {
    const folder = favourite.folder ?? UNFILED;
    groups.set(folder, [...(groups.get(folder) ?? []), favourite]);
  }
  const rows: Row[] = [];
  for (const folder of [...groups.keys()].sort((a, b) => a.localeCompare(b))) {
    rows.push({ kind: 'folder', key: `folder:${folder}`, folder });
    for (const favourite of groups.get(folder) ?? []) {
      rows.push({ kind: 'favourite', key: `fav:${favourite.id}`, favourite });
    }
  }
  return rows;
}

/** Saved statements grouped by folder. A click inserts the statement into the active editor. */
export function FavouritesPanel() {
  const { rpc } = useUiApi();
  const store = useAppStoreApi();
  const revision = useAppStore((state) => state.editors.listRevision);
  const connectionsState = useAppStore((state) => state.connections);
  const connections = useMemo(
    () => (connectionsState.state === 'ready' ? connectionsState.data : []),
    [connectionsState],
  );
  const [favourites, setFavourites] = useState<Favourite[]>([]);
  const [loadError, setLoadError] = useState<string | undefined>(undefined);
  const scroller = useRef<HTMLDivElement>(null);
  const rows = useMemo(() => favouriteRows(favourites), [favourites]);

  useEffect(() => {
    let active = true;
    rpc.favourites.list().then(
      (items) => {
        if (active) {
          setFavourites(items);
          setLoadError(undefined);
        }
      },
      (failure: unknown) => {
        if (active) {
          setLoadError(errorText(failure));
        }
      },
    );
    return () => {
      active = false;
    };
  }, [rpc, revision]);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scroller.current,
    estimateSize: (index) => (rows[index]?.kind === 'folder' ? HEADER_HEIGHT_PX : ROW_HEIGHT_PX),
    overscan: 8,
  });

  async function remove(favourite: Favourite) {
    try {
      await rpc.favourites.remove({ id: favourite.id });
      store.getState().refreshLists();
    } catch (failure) {
      notifyError(failure);
    }
  }

  function nameOf(connectionId: string | undefined): string {
    return connections.find((item) => item.id === connectionId)?.name ?? '';
  }

  if (favourites.length === 0 && loadError === undefined) {
    return (
      <Text size="sm" c="dimmed" data-testid="favourites-panel">
        No favourites yet. Use Save as favourite in an editor or in the history.
      </Text>
    );
  }

  return (
    <Stack gap={6} h="100%" style={{ minHeight: 0 }} data-testid="favourites-panel">
      {loadError === undefined ? null : (
        <Text size="xs" c="red" role="alert">
          {loadError}
        </Text>
      )}
      <div
        ref={scroller}
        className="mg-virtual-scroll"
        style={{ flex: 1, minHeight: 0, overflow: 'auto', position: 'relative' }}
      >
        <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
          {virtualizer.getVirtualItems().map((item) => {
            const row = rows[item.index];
            if (row === undefined) {
              return null;
            }
            if (row.kind === 'folder') {
              return (
                <div
                  key={row.key}
                  role="heading"
                  aria-level={3}
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    width: '100%',
                    height: HEADER_HEIGHT_PX,
                    transform: `translateY(${item.start}px)`,
                    display: 'flex',
                    alignItems: 'center',
                  }}
                >
                  <Text size="xs" fw={600} c="dimmed" tt="none">
                    {row.folder}
                  </Text>
                </div>
              );
            }
            const favourite = row.favourite;
            return (
              <div
                key={row.key}
                role="listitem"
                data-favourite-id={favourite.id}
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width: '100%',
                  height: ROW_HEIGHT_PX,
                  transform: `translateY(${item.start}px)`,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '4px 6px',
                  borderBottom: '1px solid var(--mantine-color-dark-5)',
                }}
              >
                <button
                  type="button"
                  title="Insert into the active editor"
                  onClick={() =>
                    store.getState().insertCode({
                      connectionId: favourite.connectionId ?? '',
                      database: favourite.database ?? '',
                      code: favourite.code,
                    })
                  }
                  disabled={
                    favourite.connectionId === undefined || favourite.database === undefined
                  }
                  style={{
                    flex: 1,
                    minWidth: 0,
                    textAlign: 'left',
                    background: 'transparent',
                    border: 0,
                    color: 'inherit',
                    cursor: 'pointer',
                    padding: 0,
                  }}
                >
                  <Text size="sm" fw={500} truncate="end">
                    {favourite.name}
                  </Text>
                  <Text size="xs" c="dimmed" ff="monospace" truncate="end">
                    {firstLine(favourite.code)}
                  </Text>
                </button>
                <Text size="xs" c="dimmed" truncate="end" maw={120}>
                  {nameOf(favourite.connectionId)}
                </Text>
                {favourite.connectionId === undefined || favourite.database === undefined ? null : (
                  <Tooltip label="Re-run" withArrow>
                    <ActionIcon
                      aria-label={`Re-run ${favourite.name}`}
                      variant="subtle"
                      onClick={() =>
                        void store
                          .getState()
                          .rerunStatement({
                            connectionId: favourite.connectionId ?? '',
                            database: favourite.database ?? '',
                            code: favourite.code,
                          })
                          .catch((failure: unknown) => notifyError(failure))
                      }
                    >
                      <IconPlayerPlay size={14} />
                    </ActionIcon>
                  </Tooltip>
                )}
                <Tooltip label="Delete favourite" withArrow>
                  <ActionIcon
                    aria-label={`Delete ${favourite.name}`}
                    variant="subtle"
                    color="red"
                    onClick={() => void remove(favourite)}
                  >
                    <IconTrash size={14} />
                  </ActionIcon>
                </Tooltip>
              </div>
            );
          })}
        </div>
      </div>
    </Stack>
  );
}
