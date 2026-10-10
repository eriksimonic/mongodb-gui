import {
  ActionIcon,
  Badge,
  Button,
  Group,
  Select,
  Stack,
  Text,
  TextInput,
  Tooltip,
} from '@mantine/core';
import { useVirtualizer } from '@tanstack/react-virtual';
import { IconBookmarkPlus, IconPlayerPlay } from '@tabler/icons-react';
import type { HistoryEntry } from '@mongo-gui/core';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useUiApi } from '../../api/ui-api';
import { errorText, notifyError } from '../notify-error';
import { useAppStore, useAppStoreApi } from '../../state/app-store-context';
import { SaveFavouriteDialog } from './SaveFavouriteDialog';
import { countOf, firstLine, formatRunTime } from './labels';

const ROW_HEIGHT_PX = 52;
const SEARCH_DEBOUNCE_MS = 200;
const HISTORY_LIMIT = 500;

/**
 * Past runs, newest first. A click inserts the statement into the active editor. Re-run runs it
 * again in its own tab, and Save keeps it as a favourite.
 */
export function HistoryPanel() {
  const { rpc } = useUiApi();
  const store = useAppStoreApi();
  const revision = useAppStore((state) => state.editors.listRevision);
  const connectionsState = useAppStore((state) => state.connections);
  const connections = useMemo(
    () => (connectionsState.state === 'ready' ? connectionsState.data : []),
    [connectionsState],
  );
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [connectionId, setConnectionId] = useState<string | null>(null);
  const [database, setDatabase] = useState<string | null>(null);
  const [entries, setEntries] = useState<HistoryEntry[]>([]);
  const [loadError, setLoadError] = useState<string | undefined>(undefined);
  const [saving, setSaving] = useState<HistoryEntry | undefined>(undefined);
  const scroller = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(search), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [search]);

  useEffect(() => {
    let active = true;
    rpc.history
      .list({
        ...(connectionId === null ? {} : { connectionId }),
        ...(debounced.trim() === '' ? {} : { search: debounced.trim() }),
        limit: HISTORY_LIMIT,
      })
      .then(
        (rows) => {
          if (active) {
            setEntries(rows);
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
  }, [rpc, connectionId, debounced, revision]);

  const databases = useMemo(
    () => [...new Set(entries.map((entry) => entry.database))].sort(),
    [entries],
  );
  const visible = useMemo(
    () => entries.filter((entry) => database === null || entry.database === database),
    [entries, database],
  );
  const virtualizer = useVirtualizer({
    count: visible.length,
    getScrollElement: () => scroller.current,
    estimateSize: () => ROW_HEIGHT_PX,
    overscan: 8,
  });
  const nameOf = (id: string): string =>
    connections.find((item) => item.id === id)?.name ?? 'Unknown connection';

  function insert(entry: HistoryEntry) {
    store
      .getState()
      .insertCode({ connectionId: entry.connectionId, database: entry.database, code: entry.code });
  }

  function rerun(entry: HistoryEntry) {
    void store
      .getState()
      .rerunStatement({
        connectionId: entry.connectionId,
        database: entry.database,
        code: entry.code,
      })
      .catch((failure: unknown) => notifyError(failure));
  }

  return (
    <Stack gap={6} h="100%" style={{ minHeight: 0 }} data-testid="history-panel">
      <Group gap="xs" wrap="nowrap">
        <TextInput
          size="xs"
          aria-label="Search history"
          placeholder="Search statements"
          value={search}
          onChange={(event) => setSearch(event.currentTarget.value)}
          style={{ flex: 1 }}
        />
        <Select
          size="xs"
          aria-label="Filter history by connection"
          placeholder="All connections"
          clearable
          data={connections.map((connection) => ({ value: connection.id, label: connection.name }))}
          value={connectionId}
          onChange={setConnectionId}
          w={180}
        />
        <Select
          size="xs"
          aria-label="Filter history by database"
          placeholder="All databases"
          clearable
          data={databases}
          value={database}
          onChange={setDatabase}
          w={160}
        />
      </Group>
      {loadError === undefined ? null : (
        <Text size="xs" c="red" role="alert">
          {loadError}
        </Text>
      )}
      {visible.length === 0 && loadError === undefined ? (
        <Text size="sm" c="dimmed">
          No runs match. Run a statement in an editor to record it here.
        </Text>
      ) : null}
      <div
        ref={scroller}
        className="mg-virtual-scroll"
        style={{ flex: 1, minHeight: 0, overflow: 'auto', position: 'relative' }}
      >
        <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
          {virtualizer.getVirtualItems().map((item) => {
            const entry = visible[item.index];
            if (entry === undefined) {
              return null;
            }
            return (
              <div
                key={entry.id}
                role="listitem"
                data-entry-id={entry.id}
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
                  onClick={() => insert(entry)}
                  title="Insert into the active editor"
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
                  <Text size="sm" ff="monospace" truncate="end">
                    {firstLine(entry.code)}
                  </Text>
                  <Text size="xs" c="dimmed" truncate="end">
                    {nameOf(entry.connectionId)} · {entry.database} ·{' '}
                    {formatRunTime(entry.startedAt)} · {entry.durationMs.toFixed(0)} ms
                    {entry.resultCount === undefined
                      ? ''
                      : ` · ${countOf(entry.resultCount, 'document')}`}
                  </Text>
                </button>
                {entry.error === undefined ? null : (
                  <Badge tt="none" size="xs" color="red" variant="light">
                    Error
                  </Badge>
                )}
                <Tooltip label="Re-run" withArrow>
                  <ActionIcon aria-label="Re-run" variant="subtle" onClick={() => rerun(entry)}>
                    <IconPlayerPlay size={14} />
                  </ActionIcon>
                </Tooltip>
                <Tooltip label="Save as favourite" withArrow>
                  <ActionIcon
                    aria-label="Save as favourite"
                    variant="subtle"
                    onClick={() => setSaving(entry)}
                  >
                    <IconBookmarkPlus size={14} />
                  </ActionIcon>
                </Tooltip>
              </div>
            );
          })}
        </div>
      </div>
      <Group justify="flex-end">
        <Button size="xs" variant="subtle" color="red" onClick={() => void clearHistory()}>
          Clear history
        </Button>
      </Group>
      {saving === undefined ? null : (
        <SaveFavouriteDialog
          code={saving.code}
          connectionId={saving.connectionId}
          database={saving.database}
          onClose={() => setSaving(undefined)}
        />
      )}
    </Stack>
  );

  async function clearHistory() {
    try {
      await rpc.history.clear();
      store.getState().refreshLists();
    } catch (failure) {
      notifyError(failure);
    }
  }
}
