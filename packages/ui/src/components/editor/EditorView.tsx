import { Badge, Button, Group, Select, Stack, Text, Tooltip } from '@mantine/core';
import {
  IconBookmark,
  IconChecklist,
  IconPlayerPlay,
  IconPlayerStop,
  IconRefresh,
  IconWand,
} from '@tabler/icons-react';
import type { ShellRuntimeState } from '@mongo-gui/core';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { useUiApi } from '../../api/ui-api';
import { MongoshEditor, type RunRequest } from '../../editor/MongoshEditor';
import { createCompletionSource } from '../../editor/completion-source';
import { formatMongoshCode } from '../../editor/format';
import { runTargetFor } from '../../editor/statements';
import { ResultsPane, type EditTarget } from '../../results/ResultsPane';
import type { TreeEdit } from '../../results/TreeView';
import { useAppStore, useAppStoreApi } from '../../state/app-store-context';
import { editorUiEvents } from '../../editor/editor-events';
import { BATCH_SIZES, type BatchSize, type EditorTab } from '../../state/editors';
import { notifyError } from '../notify-error';
import { SaveFavouriteDialog } from './SaveFavouriteDialog';

const MIN_EDITOR_SHARE = 0.15;
const MAX_EDITOR_SHARE = 0.8;
const DEFAULT_EDITOR_SHARE = 0.3;
const SHARE_STEP = 0.05;

const RUNTIME_COLORS: Readonly<Record<ShellRuntimeState, string>> = {
  stopped: 'gray',
  starting: 'blue',
  ready: 'teal',
  busy: 'yellow',
  crashed: 'red',
};

const RUNTIME_LABELS: Readonly<Record<ShellRuntimeState, string>> = {
  stopped: 'Runtime stopped',
  starting: 'Runtime starting',
  ready: 'Runtime ready',
  busy: 'Runtime busy',
  crashed: 'Runtime crashed. Restart the connection.',
};

export interface EditorViewProps {
  readonly tabId: string;
}

/**
 * One editor tab: a toolbar, the mongosh editor, and the results of its last run. Run sends the
 * selection, or the statement under the cursor. Run all sends the whole text.
 */
export function EditorView({ tabId }: EditorViewProps) {
  const { rpc } = useUiApi();
  const store = useAppStoreApi();
  const tab = useAppStore((state) => state.editors.tabs[tabId]);
  const runtime = useAppStore((state) =>
    tab === undefined ? undefined : state.editors.runtime[tab.connectionId],
  );
  const databases = useAppStore((state) =>
    tab === undefined ? undefined : state.databases[tab.connectionId],
  );
  const connectionName = useAppStore((state) => {
    if (tab === undefined || state.connections.state !== 'ready') {
      return undefined;
    }
    return state.connections.data.find((connection) => connection.id === tab.connectionId)?.name;
  });
  const [saveOpen, setSaveOpen] = useState(false);
  const [share, setShare] = useState(DEFAULT_EDITOR_SHARE);
  const split = useRef<HTMLDivElement>(null);
  const connectionId = tab?.connectionId;

  useEffect(() => {
    if (connectionId !== undefined && databases === undefined) {
      store
        .getState()
        .loadDatabases(connectionId)
        .catch(() => undefined);
    }
  }, [store, connectionId, databases]);

  const source = useMemo(
    () =>
      connectionId === undefined
        ? undefined
        : createCompletionSource({
            rpc,
            connectionId,
            database: () => store.getState().editors.tabs[tabId]?.database ?? '',
            isBusy: () => store.getState().editors.runtime[connectionId] === 'busy',
          }),
    [rpc, store, tabId, connectionId],
  );

  if (tab === undefined) {
    return (
      <Text size="sm" c="dimmed" p="sm">
        This editor is closed.
      </Text>
    );
  }

  const current: EditorTab = tab;
  const api = store.getState();
  const unsaved = current.text !== current.savedText;
  const busy = current.running !== undefined;
  const editTarget: EditTarget | undefined =
    current.result?.collection === undefined
      ? undefined
      : {
          connectionId: current.connectionId,
          database: current.result.database,
          collection: current.result.collection,
        };

  function run(request: RunRequest) {
    const target = runTargetFor(request.code, request.cursor, request.selection);
    if (target.source !== 'empty') {
      void api.runEditor(tabId, target.text);
    }
  }

  function runAll(code: string) {
    if (code.trim() !== '') {
      void api.runEditor(tabId, code);
    }
  }

  function explain(request: RunRequest) {
    const target = runTargetFor(request.code, request.cursor, request.selection);
    if (target.source !== 'empty') {
      void api.openExplain({
        connectionId: current.connectionId,
        database: current.database,
        code: target.text,
      });
    }
  }

  function format() {
    api.setEditorText(tabId, formatMongoshCode(current.text));
  }

  function resizeWithKeys(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'ArrowUp') {
      setShare((value) => Math.max(MIN_EDITOR_SHARE, value - SHARE_STEP));
    } else if (event.key === 'ArrowDown') {
      setShare((value) => Math.min(MAX_EDITOR_SHARE, value + SHARE_STEP));
    } else {
      return;
    }
    event.preventDefault();
  }

  function dragSplit(event: PointerEvent<HTMLDivElement>) {
    const box = split.current?.getBoundingClientRect();
    if (box === undefined || box.height === 0) {
      return;
    }
    const next = (event.clientY - box.top) / box.height;
    setShare(Math.min(MAX_EDITOR_SHARE, Math.max(MIN_EDITOR_SHARE, next)));
  }

  const databaseOptions = (
    databases?.state === 'ready' ? databases.data.map((item) => item.name) : []
  )
    .concat(current.database)
    .filter((name, index, all) => all.indexOf(name) === index)
    .map((name) => ({ value: name, label: name }));
  const runtimeState: ShellRuntimeState = runtime ?? 'stopped';

  return (
    <Stack gap={0} h="100%" style={{ minHeight: 0 }} data-testid="editor-view">
      <Group
        className="mg-editor-toolbar"
        gap="xs"
        wrap="nowrap"
        px={8}
        py={6}
        style={{ borderBottom: '1px solid var(--mantine-color-dark-4)' }}
      >
        <Tooltip label={RUNTIME_LABELS[runtimeState]} withArrow>
          <span
            role="status"
            aria-label={RUNTIME_LABELS[runtimeState]}
            data-runtime={runtimeState}
            style={{
              width: 8,
              height: 8,
              borderRadius: 4,
              display: 'inline-block',
              background: `var(--mantine-color-${RUNTIME_COLORS[runtimeState]}-6)`,
            }}
          />
        </Tooltip>
        <Text size="sm" fw={600} truncate="end" maw={200}>
          {connectionName ?? 'Connection'} · {current.database}
        </Text>
        <Select
          size="xs"
          aria-label="Database"
          data={databaseOptions}
          value={current.database}
          allowDeselect={false}
          w={160}
          onChange={(value) => {
            if (value !== null) {
              api.setEditorDatabase(tabId, value);
            }
          }}
        />
        <Button
          size="xs"
          leftSection={<IconPlayerPlay size={13} />}
          disabled={busy}
          onClick={() => editorUiEvents.emit({ type: 'editor:command', tabId, command: 'run' })}
          title="Run the selection or the statement under the cursor (Ctrl+Enter)"
        >
          Run
        </Button>
        <Button
          size="xs"
          variant="default"
          disabled={busy || current.text.trim() === ''}
          onClick={() => editorUiEvents.emit({ type: 'editor:command', tabId, command: 'runAll' })}
          title="Run all (Ctrl+Shift+Enter)"
        >
          Run all
        </Button>
        {busy ? (
          <Button
            size="xs"
            color="red"
            variant="light"
            leftSection={<IconPlayerStop size={13} />}
            onClick={() =>
              void api.cancelEditor(tabId).catch((failure: unknown) => notifyError(failure))
            }
          >
            Cancel
          </Button>
        ) : null}
        <Button
          size="xs"
          variant="default"
          onClick={() => editorUiEvents.emit({ type: 'editor:command', tabId, command: 'explain' })}
        >
          Explain
        </Button>
        <Select
          size="xs"
          aria-label="Batch size"
          data={BATCH_SIZES.map((size) => ({ value: String(size), label: `${size} per batch` }))}
          value={String(current.batchSize)}
          allowDeselect={false}
          w={130}
          onChange={(value) => {
            const size = BATCH_SIZES.find((item) => String(item) === value);
            if (size !== undefined) {
              api.setEditorBatchSize(tabId, size as BatchSize);
            }
          }}
        />
        <Button size="xs" variant="default" leftSection={<IconWand size={13} />} onClick={format}>
          Format
        </Button>
        <Button
          size="xs"
          variant="default"
          leftSection={<IconBookmark size={13} />}
          onClick={() => setSaveOpen(true)}
        >
          Save as favourite
        </Button>
        <Tooltip label="Reload the collection names of this connection" withArrow>
          <Button
            size="xs"
            variant="subtle"
            aria-label="Refresh databases"
            onClick={() => {
              void api
                .loadDatabases(current.connectionId)
                .catch((failure: unknown) => notifyError(failure));
            }}
          >
            <IconRefresh size={14} />
          </Button>
        </Tooltip>
        <Tooltip label="Refresh field names from the sample" withArrow>
          <Button
            size="xs"
            variant="subtle"
            aria-label="Refresh field names"
            onClick={() => source?.refreshFields()}
          >
            <IconChecklist size={14} />
          </Button>
        </Tooltip>
        <span style={{ flex: 1 }} />
        {unsaved ? (
          <Badge tt="none" size="sm" variant="dot" color="yellow" aria-label="Unsaved changes">
            Unsaved
          </Badge>
        ) : null}
      </Group>
      <div ref={split} style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        <div style={{ height: `${share * 100}%`, minHeight: 80, padding: '6px 8px 0' }}>
          <MongoshEditor
            tabId={tabId}
            label={`Query for ${current.database}`}
            value={current.text}
            source={source}
            onChange={(text) => api.setEditorText(tabId, text)}
            onRun={run}
            onRunAll={runAll}
            onExplain={explain}
          />
        </div>
        <div
          role="separator"
          aria-orientation="horizontal"
          aria-label="Resize the results"
          aria-valuemin={Math.round(MIN_EDITOR_SHARE * 100)}
          aria-valuemax={Math.round(MAX_EDITOR_SHARE * 100)}
          aria-valuenow={Math.round(share * 100)}
          tabIndex={0}
          onKeyDown={resizeWithKeys}
          onPointerDown={(event) => {
            event.currentTarget.setPointerCapture(event.pointerId);
            dragSplit(event);
          }}
          onPointerMove={(event) => {
            if (event.currentTarget.hasPointerCapture(event.pointerId)) {
              dragSplit(event);
            }
          }}
          style={{
            height: 8,
            cursor: 'row-resize',
            background: 'var(--mantine-color-dark-5)',
            flex: '0 0 auto',
          }}
        />
        <div style={{ flex: 1, minHeight: 120, padding: '6px 8px 8px' }}>
          <ResultsPane
            target={editTarget}
            onDocumentSaved={(index, documentEjson) =>
              api.replaceLoadedDocument(tabId, index, documentEjson)
            }
            result={current.result}
            error={current.error}
            running={current.running}
            view={current.view}
            onView={(view) => api.setEditorView(tabId, view)}
            onLoadMore={() => void api.loadMoreEditor(tabId)}
            onLoadAll={() => void api.loadAllEditor(tabId)}
            onExport={(format) => void api.exportResult(tabId, format).catch(notifyError)}
            onSetField={(edit: TreeEdit) =>
              api.editField({
                tabId,
                documentIndex: edit.documentIndex,
                path: edit.path,
                value: edit.value,
              })
            }
            onUnsetField={(documentIndex, path) =>
              api.editField({ tabId, documentIndex, path, unset: true })
            }
          />
        </div>
      </div>
      {saveOpen ? (
        <SaveFavouriteDialog
          code={current.text}
          connectionId={current.connectionId}
          database={current.database}
          tabId={tabId}
          onClose={() => setSaveOpen(false)}
        />
      ) : null}
    </Stack>
  );
}
