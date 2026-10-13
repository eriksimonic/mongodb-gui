import {
  ActionIcon,
  Badge,
  Button,
  Group,
  SegmentedControl,
  Select,
  Stack,
  Text,
  Tooltip,
} from '@mantine/core';
import { modals } from '@mantine/modals';
import { notifications } from '@mantine/notifications';
import {
  IconBookmark,
  IconChecklist,
  IconPlayerPlay,
  IconPlayerStop,
  IconRefresh,
  IconWand,
} from '@tabler/icons-react';
import { appError, type EditorLanguage, type ShellRuntimeState } from '@mongo-gui/core';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { useUiApi } from '../../api/ui-api';
import { MongoshEditor, type RunRequest } from '../../editor/MongoshEditor';
import { createCompletionSource } from '../../editor/completion-source';
import { formatMongoshCode } from '../../editor/format';
import { runTargetFor, type RunTarget } from '../../editor/statements';
import { formatSql } from '../../editor/sql-format';
import {
  prepareSqlRun,
  unsafeWriteQuestion,
  type SqlSampler,
  type UnsafeWrite,
} from '../../editor/sql-run';
import { sqlRunTargetFor } from '../../editor/sql-statements';
import { ResultsPane, type EditTarget } from '../../results/ResultsPane';
import type { TreeEdit } from '../../results/TreeView';
import { useAppStore, useAppStoreApi } from '../../state/app-store-context';
import { editorUiEvents } from '../../editor/editor-events';
import { BATCH_SIZES, type BatchSize, type EditorTab } from '../../state/editors';
import { notifyError } from '../notify-error';
import { SaveFavouriteDialog } from './SaveFavouriteDialog';
import { SqlPreview } from './SqlPreview';

const MIN_EDITOR_SHARE = 0.15;
const MAX_EDITOR_SHARE = 0.8;
const DEFAULT_EDITOR_SHARE = 0.3;
const SHARE_STEP = 0.05;

/** Stands in for the completion source while the tab has none. The run then has no type hints. */
const NO_SAMPLER: SqlSampler = { fieldsOf: () => Promise.resolve([]) };

const LANGUAGE_OPTIONS: readonly { readonly value: EditorLanguage; readonly label: string }[] = [
  { value: 'mongosh', label: 'Mongo' },
  { value: 'sql', label: 'SQL' },
];

const RUNTIME_COLORS: Readonly<Record<ShellRuntimeState, string>> = {
  stopped: 'gray',
  starting: 'yellow',
  ready: 'blue',
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

/** The offset of the run target in the editor text, so a SQL error span can be placed. */
function offsetOf(request: RunRequest, target: RunTarget): number {
  if (target.source === 'statement') {
    return target.start;
  }
  if (target.source === 'selection' && request.selection !== undefined) {
    const raw = request.code.slice(request.selection.start, request.selection.end);
    return request.selection.start + (raw.length - raw.trimStart().length);
  }
  return 0;
}

/** Asks before writes that touch every document of their collection. Resolves to the answer. */
function confirmUnsafeWrites(writes: readonly UnsafeWrite[]): Promise<boolean> {
  return new Promise((resolve) => {
    modals.openConfirmModal({
      title: 'Run a write without WHERE',
      centered: true,
      children: <Text size="sm">{unsafeWriteQuestion(writes)}</Text>,
      labels: { confirm: 'Run', cancel: 'Cancel' },
      confirmProps: { color: 'red' },
      onConfirm: () => resolve(true),
      onCancel: () => resolve(false),
      onClose: () => resolve(false),
    });
  });
}

/**
 * One editor tab: a toolbar, the mongosh or SQL editor, and the results of its last run. Run sends
 * the selection, or the statement under the cursor. Run all sends the whole text. A SQL tab
 * translates the text first and runs the mongosh, which the Output panel shows.
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

  const isSql = current.language === 'sql';

  /**
   * Translates SQL for a run. A failure underlines the clause and shows the message on the tab.
   * A write without WHERE asks first. Resolves to the mongosh, or undefined when nothing runs.
   */
  async function translateForRun(sql: string, offset: number): Promise<string | undefined> {
    const plan = await prepareSqlRun(sql, source ?? NO_SAMPLER);
    if (!plan.ok) {
      editorUiEvents.emit({
        type: 'editor:markers',
        tabId,
        markers: [
          { start: offset + plan.span.start, end: offset + plan.span.end, message: plan.message },
        ],
      });
      api.setEditorError(tabId, appError('VALIDATION', plan.message));
      api.reportLine('error', plan.message, tabId);
      return undefined;
    }
    if (plan.unsafe && !(await confirmUnsafeWrites(plan.unsafeWrites))) {
      return undefined;
    }
    return plan.mongosh;
  }

  async function runSql(sql: string, offset: number): Promise<void> {
    const mongosh = await translateForRun(sql, offset);
    if (mongosh !== undefined) {
      await api.runEditor(tabId, mongosh, { sql });
    }
  }

  function targetOf(request: RunRequest): RunTarget {
    return isSql
      ? sqlRunTargetFor(request.code, request.cursor, request.selection)
      : runTargetFor(request.code, request.cursor, request.selection);
  }

  function run(request: RunRequest) {
    const target = targetOf(request);
    if (target.source === 'empty') {
      return;
    }
    if (isSql) {
      void runSql(target.text, offsetOf(request, target));
    } else {
      void api.runEditor(tabId, target.text);
    }
  }

  function runAll(code: string) {
    if (code.trim() === '') {
      return;
    }
    if (isSql) {
      void runSql(code, 0);
    } else {
      void api.runEditor(tabId, code);
    }
  }

  function explain(request: RunRequest) {
    const target = targetOf(request);
    if (target.source === 'empty') {
      return;
    }
    const open = (code: string) =>
      api.openExplain({ connectionId: current.connectionId, database: current.database, code });
    if (!isSql) {
      void open(target.text);
      return;
    }
    void translateForRun(target.text, offsetOf(request, target)).then((mongosh) =>
      mongosh === undefined ? undefined : open(mongosh),
    );
  }

  function format() {
    api.setEditorText(tabId, isSql ? formatSql(current.text) : formatMongoshCode(current.text));
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
        gap={8}
        wrap="wrap"
        px="md"
        py={8}
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
        <Text size="sm" fw={600} truncate="end" maw={140}>
          {connectionName ?? 'Connection'}
        </Text>
        <Select
          size="xs"
          aria-label="Database"
          data={databaseOptions}
          value={current.database}
          allowDeselect={false}
          w={130}
          onChange={(value) => {
            if (value !== null) {
              api.setEditorDatabase(tabId, value);
            }
          }}
        />
        <SegmentedControl
          size="xs"
          aria-label="Query language"
          data={LANGUAGE_OPTIONS.map((option) => ({ ...option }))}
          value={current.language}
          disabled={busy}
          onChange={(value) => {
            const language = LANGUAGE_OPTIONS.find((option) => option.value === value)?.value;
            if (language !== undefined && language !== current.language) {
              // Each language keeps its own text. Nothing translates on the switch.
              void api.setEditorLanguage(tabId, language);
            }
          }}
        />
        {/* One button: Run while idle, Cancel while a run is going, so the toolbar keeps its layout. */}
        {busy ? (
          <Button
            size="xs"
            color="red"
            leftSection={<IconPlayerStop size={13} />}
            onClick={() =>
              void api.cancelEditor(tabId).catch((failure: unknown) => notifyError(failure))
            }
            title="Cancel the running statement"
            miw="calc(76px * var(--mg-font-scale, 1))"
          >
            Cancel
          </Button>
        ) : (
          <Button
            size="xs"
            leftSection={<IconPlayerPlay size={13} />}
            onClick={() => editorUiEvents.emit({ type: 'editor:command', tabId, command: 'run' })}
            title="Run the selection or the statement under the cursor (F5 or Ctrl+Enter)"
            miw="calc(76px * var(--mg-font-scale, 1))"
          >
            Run
          </Button>
        )}
        <Button
          size="xs"
          variant="default"
          disabled={busy || current.text.trim() === ''}
          onClick={() => editorUiEvents.emit({ type: 'editor:command', tabId, command: 'runAll' })}
          title="Run all (Ctrl+Shift+Enter)"
        >
          Run all
        </Button>
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
          w="calc(140px * var(--mg-font-scale, 1))"
          onChange={(value) => {
            const size = BATCH_SIZES.find((item) => String(item) === value);
            if (size !== undefined) {
              api.setEditorBatchSize(tabId, size as BatchSize);
            }
          }}
        />
        <Tooltip label="Format" withArrow>
          <ActionIcon size="input-xs" variant="default" aria-label="Format" onClick={format}>
            <IconWand size={14} />
          </ActionIcon>
        </Tooltip>
        <Tooltip label="Save as favourite" withArrow>
          <ActionIcon
            size="input-xs"
            variant="default"
            aria-label="Save as favourite"
            onClick={() => setSaveOpen(true)}
          >
            <IconBookmark size={14} />
          </ActionIcon>
        </Tooltip>
        <Tooltip label="Reload the collection names of this connection" withArrow>
          <ActionIcon
            size="input-xs"
            variant="default"
            aria-label="Refresh databases"
            onClick={() => {
              void api
                .loadDatabases(current.connectionId)
                .catch((failure: unknown) => notifyError(failure));
            }}
          >
            <IconRefresh size={14} />
          </ActionIcon>
        </Tooltip>
        <Tooltip label="Refresh field names from the sample" withArrow>
          <ActionIcon
            size="input-xs"
            variant="default"
            aria-label="Refresh field names"
            onClick={() => source?.refreshFields()}
          >
            <IconChecklist size={14} />
          </ActionIcon>
        </Tooltip>
        {unsaved ? (
          <Badge
            tt="none"
            size="sm"
            variant="dot"
            color="yellow"
            ml="auto"
            aria-label="Unsaved changes"
          >
            Unsaved
          </Badge>
        ) : null}
      </Group>
      <div ref={split} style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        <div style={{ height: `${share * 100}%`, minHeight: 80, padding: '8px 10px 0' }}>
          <div style={{ display: 'flex', gap: 8, height: '100%' }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <MongoshEditor
                tabId={tabId}
                language={current.language}
                label={`Query for ${current.database}`}
                value={current.text}
                source={source}
                onChange={(text) => api.setEditorText(tabId, text)}
                onRun={run}
                onRunAll={runAll}
                onExplain={explain}
              />
            </div>
            {isSql ? (
              <div style={{ flex: 1, minWidth: 0 }}>
                <SqlPreview
                  sql={current.text}
                  sampler={source ?? NO_SAMPLER}
                  onOpenInMongo={() => void api.openSqlAsMongo(tabId, source ?? NO_SAMPLER)}
                />
              </div>
            ) : null}
          </div>
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
        <div style={{ flex: 1, minHeight: 120, padding: '8px 10px 10px' }}>
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
            readFull={(ref) => api.readFullDocument(ref)}
            onExport={(format) =>
              void api
                .exportResult(tabId, format)
                .then(({ skipped }) => {
                  if (skipped > 0) {
                    notifications.show({
                      color: 'yellow',
                      title: 'Export finished',
                      message: `${skipped} ${skipped === 1 ? 'document was' : 'documents were'} left out because the full text was not kept.`,
                    });
                  }
                })
                .catch(notifyError)
            }
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
          language={current.language}
          tabId={tabId}
          onClose={() => setSaveOpen(false)}
        />
      ) : null}
    </Stack>
  );
}
