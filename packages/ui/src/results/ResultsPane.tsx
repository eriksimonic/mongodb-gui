import { Alert, Badge, Button, Group, Modal, SegmentedControl, Stack, Text } from '@mantine/core';
import { modals } from '@mantine/modals';
import { IconCopy } from '@tabler/icons-react';
import { useEffect, useMemo, useState } from 'react';
import { editableValue, isUnkeptPreview, previewInfo, type AppError } from '@mongo-gui/core';
import { errorText, notifyError } from '../kit/notify-error';
import { LOAD_ALL_LIMIT, type ResultSet, type ResultView, type RunState } from '../state/editors';
import { DocumentEditorDialog } from '../management';
import { formatJson } from '../kit/input-rules';
import { COPY_MAX_CHARS, OPEN_MAX_CHARS, fullDocumentText, fullDocuments } from './full-documents';
import { discoverColumns, formatCount, type JsonObject } from './result-model';
import { JsonView } from './JsonView';
import { jsonTextFor } from './json-text';
import type { ExportFormat } from './result-export';
import { ColumnChooser, ReadOnlyBadge, TableView } from './TableView';
import { TreeView, type TreeEdit } from './TreeView';

const VIEW_LABELS: Readonly<Record<ResultView, string>> = {
  table: 'Table',
  tree: 'Tree',
};
const TICK_MS = 250;
const MILLIS_PER_SECOND = 1000;
const BYTES_PER_MB = 1024 * 1024;

/** The document the user opened, as text from the full document and never from a preview. */
type OpenedDocument =
  | { readonly index: number; readonly full: string }
  | { readonly index: number; readonly initialText: string; readonly idEjson: string };

/** The collection a document edit writes to. Set only for a plain find on one collection. */
export interface EditTarget {
  readonly connectionId: string;
  readonly database: string;
  readonly collection: string;
}

export interface ResultsPaneProps {
  /** Where a row edit writes. Undefined when the result cannot be edited. */
  readonly target: EditTarget | undefined;
  /** Called with the saved EJSON after a document is replaced, so the loaded copy follows. */
  readonly onDocumentSaved: (documentIndex: number, documentEjson: string) => void;
  readonly result: ResultSet | undefined;
  readonly error: AppError | undefined;
  readonly running: RunState | undefined;
  readonly view: ResultView;
  readonly onView: (view: ResultView) => void;
  readonly onLoadMore: () => void;
  readonly onLoadAll: () => void;
  /** Reads the full canonical EJSON text of a previewed document. */
  readonly readFull: (ref: string) => Promise<string>;
  readonly onSetField: (edit: TreeEdit) => Promise<void>;
  readonly onUnsetField: (documentIndex: number, path: string) => Promise<void>;
  readonly onExport: (format: ExportFormat) => void;
}

/** The time since a run started, redrawn every quarter second while it runs. */
function useElapsed(running: RunState | undefined): number | undefined {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (running === undefined) {
      return undefined;
    }
    const timer = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(timer);
  }, [running]);
  return running === undefined ? undefined : Math.max(0, now - running.startedAt);
}

function seconds(millis: number): string {
  return `${(millis / MILLIS_PER_SECOND).toFixed(2)} s`;
}

/**
 * The results of the last run: the view switch, paging, counts, the summary of a write, and copy.
 * A cursor result shows its documents in the chosen view. A value shows as JSON.
 */
export function ResultsPane({
  target,
  onDocumentSaved,
  result,
  error,
  running,
  view,
  onView,
  onLoadMore,
  onLoadAll,
  readFull,
  onSetField,
  onUnsetField,
  onExport,
}: ResultsPaneProps) {
  const [hidden, setHidden] = useState<readonly string[]>([]);
  const [selected, setSelected] = useState<readonly number[]>([]);
  const [opened, setOpened] = useState<OpenedDocument | undefined>(undefined);
  const [opening, setOpening] = useState(false);
  const [notice, setNotice] = useState<string | undefined>(undefined);
  const elapsed = useElapsed(running);
  const isCursor = result !== undefined && result.printableEjson === undefined;
  const effectiveView: ResultView | 'json' = isCursor ? view : 'json';
  const documents = result?.documents;
  const columns = useMemo(() => discoverColumns(documents ?? []), [documents]);
  const jsonSource = useMemo(() => {
    if (result === undefined) {
      return undefined;
    }
    return result.printableEjson === undefined
      ? { documents: result.documents }
      : { printableEjson: result.printableEjson };
  }, [result]);
  // Previews whose full text was not stored. They can be neither opened, copied nor exported.
  const unkept = useMemo(
    () => documents?.filter((document) => isUnkeptPreview(document)).length ?? 0,
    [documents],
  );
  const editable = isCursor && target !== undefined;
  const editabilityNote = editable
    ? ''
    : 'Only a plain find on one collection can be edited. This result does not come from one.';
  const count = result?.documents.length ?? 0;
  const canLoadMore =
    result !== undefined &&
    result.hasMore &&
    !result.capped &&
    !result.loadingMore &&
    result.cursorRequestId !== undefined;
  const loadMoreOnScroll = canLoadMore ? onLoadMore : undefined;

  async function copyJson(): Promise<void> {
    if (result === undefined) {
      return;
    }
    const chosen =
      selected.length === 0
        ? result.documents
        : selected.map((index) => result.documents[index]).filter(isDocument);
    try {
      const full = await fullDocuments(chosen, readFull, COPY_MAX_CHARS);
      await navigator.clipboard.writeText(jsonTextFor({ documents: full }, 'canonical'));
    } catch (failure) {
      notifyError(failure, 'Copy failed');
    }
  }

  /**
   * Opens one document. A previewed one is read in full first, and one that is too large for the
   * dialog gets a notice. The edit dialog starts from the full text, so a preview is never saved.
   */
  async function openDocument(index: number): Promise<void> {
    const document = result?.documents[index];
    if (document === undefined || opening) {
      return;
    }
    setNotice(undefined);
    const info = previewInfo(document);
    if (info !== undefined && info.chars > OPEN_MAX_CHARS) {
      setNotice(
        `This document is ${(info.chars / BYTES_PER_MB).toFixed(1)} MB. Open it in the shell, or Export.`,
      );
      return;
    }
    setOpening(true);
    try {
      const full = await fullDocumentText(document, readFull);
      if (target === undefined) {
        setOpened({ index, full });
      } else {
        const parsed = JSON.parse(full) as JsonObject;
        setOpened({
          index,
          initialText: formatJson(editableValue(parsed)),
          idEjson: JSON.stringify(parsed._id),
        });
      }
    } catch (failure) {
      setNotice(errorText(failure));
    } finally {
      setOpening(false);
    }
  }

  const viewSwitch = (
    <SegmentedControl
      size="xs"
      aria-label="Result view"
      value={view}
      disabled={!isCursor}
      onChange={(value) => onView(value as ResultView)}
      data={(Object.keys(VIEW_LABELS) as ResultView[]).map((key) => ({
        value: key,
        label: VIEW_LABELS[key],
      }))}
    />
  );

  return (
    <Stack gap={8} h="100%" style={{ minHeight: 0 }} data-testid="results-pane">
      {effectiveView === 'tree' ? null : (
        <Group justify="space-between" wrap="nowrap" gap={8}>
          <Group gap={8} wrap="nowrap">
            {viewSwitch}
            {result === undefined || !isCursor ? null : (
              <Text size="xs" c="var(--mg-text-muted)" aria-live="polite">
                {formatCount(count, result.hasMore)}
              </Text>
            )}
            {effectiveView !== 'table' || result === undefined || !isCursor ? null : (
              <>
                <ColumnChooser columns={columns} hidden={hidden} onHiddenChange={setHidden} />
                {editable ? null : <ReadOnlyBadge note={editabilityNote} />}
              </>
            )}
            {opening ? (
              <Text size="xs" c="dimmed" aria-live="polite">
                Opening document…
              </Text>
            ) : null}
            {result?.summary === undefined ? null : (
              <Badge tt="none" size="sm" variant="light" color="blue" data-testid="result-summary">
                {result.summary}
              </Badge>
            )}
          </Group>
          <Group gap={8} wrap="nowrap">
            {running !== undefined && elapsed !== undefined ? (
              <Text size="xs" c="dimmed">
                Running {seconds(elapsed)}
              </Text>
            ) : result === undefined ? null : (
              <Text size="xs" c="var(--mg-text-muted)" ff="var(--mantine-font-family-monospace)">
                {seconds(result.elapsedMs)}
              </Text>
            )}
            {result === undefined || !isCursor ? null : (
              <>
                <Button
                  size="xs"
                  variant="default"
                  disabled={
                    !result.hasMore ||
                    result.capped ||
                    result.loadingMore ||
                    result.cursorRequestId === undefined
                  }
                  onClick={() =>
                    modals.openConfirmModal({
                      title: 'Load documents',
                      centered: true,
                      children: (
                        <Text size="sm">
                          Load up to {LOAD_ALL_LIMIT.toLocaleString('en-US')} documents into memory?
                          Large results take a while and use memory.
                        </Text>
                      ),
                      labels: { confirm: 'Load', cancel: 'Cancel' },
                      onConfirm: onLoadAll,
                    })
                  }
                >
                  Load all up to {LOAD_ALL_LIMIT.toLocaleString('en-US')}
                </Button>
                <Button
                  size="xs"
                  variant="default"
                  disabled={
                    !result.hasMore ||
                    result.capped ||
                    result.loadingMore ||
                    result.cursorRequestId === undefined
                  }
                  onClick={() =>
                    modals.openConfirmModal({
                      title: 'Load documents',
                      centered: true,
                      children: (
                        <Text size="sm">
                          Load up to {LOAD_ALL_LIMIT.toLocaleString('en-US')} documents into memory?
                          Large results take a while and use memory.
                        </Text>
                      ),
                      labels: { confirm: 'Load', cancel: 'Cancel' },
                      onConfirm: onLoadAll,
                    })
                  }
                >
                  Load all up to {LOAD_ALL_LIMIT.toLocaleString('en-US')}
                </Button>
                <Button
                  size="xs"
                  variant="default"
                  leftSection={<IconCopy size={13} />}
                  disabled={count === 0}
                  onClick={() => void copyJson()}
                >
                  {selected.length === 0 ? 'Copy JSON' : `Copy ${selected.length} as JSON`}
                </Button>
                <Button
                  size="xs"
                  variant="default"
                  disabled={count === 0}
                  onClick={() => onExport('json')}
                >
                  Export JSON
                </Button>
                <Button
                  size="xs"
                  variant="default"
                  disabled={count === 0}
                  onClick={() => onExport('csv')}
                >
                  Export CSV
                </Button>
              </>
            )}
          </Group>
        </Group>
      )}
      {error === undefined ? null : (
        <Alert color="red" variant="light" role="alert" p="xs">
          {errorText(error)}
        </Alert>
      )}
      {notice === undefined ? null : (
        <Alert
          color="yellow"
          variant="light"
          role="alert"
          p="xs"
          withCloseButton
          onClose={() => setNotice(undefined)}
        >
          {notice}
        </Alert>
      )}
      {unkept === 0 ? null : (
        <Text size="xs" c="dimmed" data-testid="result-unkept">
          {unkept} {unkept === 1 ? 'document was' : 'documents were'} too large to keep in full, so{' '}
          {unkept === 1 ? 'it shows' : 'they show'} a preview only. Export and Copy leave{' '}
          {unkept === 1 ? 'it' : 'them'} out, and no more is loaded. Run the query again with a
          narrower filter or a projection.
        </Text>
      )}
      {result?.capped !== true || !result.hasMore || unkept > 0 ? null : (
        <Text size="xs" c="dimmed" data-testid="result-capped">
          Memory limit reached for this result. The query has more documents than the {count} shown,
          and Export writes only those. Narrow the query to reach the rest.
        </Text>
      )}
      {result === undefined || jsonSource === undefined ? (
        running === undefined && error === undefined ? (
          <Text size="sm" c="dimmed">
            Run a statement to see its result here.
          </Text>
        ) : null
      ) : (
        <div style={{ flex: 1, minHeight: 0 }}>
          {effectiveView === 'table' ? (
            <TableView
              documents={result.documents}
              columns={columns}
              hidden={hidden}
              editable={editable}
              onOpenDocument={(index) => void openDocument(index)}
              onSetField={onSetField}
              readFull={readFull}
              onSelectionChange={setSelected}
              onNearEnd={loadMoreOnScroll}
            />
          ) : effectiveView === 'tree' ? (
            <TreeView
              documents={result.documents}
              editable={editable}
              editabilityNote={editabilityNote}
              onOpenDocument={(index) => void openDocument(index)}
              readFull={readFull}
              onSetField={onSetField}
              onUnsetField={onUnsetField}
              onNearEnd={loadMoreOnScroll}
              hasMore={result.hasMore}
              onExport={() => onExport('json')}
              leading={
                <>
                  {viewSwitch}
                  {target === undefined ? null : (
                    <Text size="xs" ff="var(--mantine-font-family-monospace)">
                      {target.database}.{target.collection}
                    </Text>
                  )}
                </>
              }
            />
          ) : (
            <JsonView source={jsonSource} label="Result as JSON" />
          )}
        </div>
      )}
      {opened === undefined ? null : 'full' in opened ? (
        <DocumentModal full={opened.full} onClose={() => setOpened(undefined)} />
      ) : target === undefined ? null : (
        <DocumentEditorDialog
          connectionId={target.connectionId}
          database={target.database}
          collection={target.collection}
          initialText={opened.initialText}
          idEjson={opened.idEjson}
          onClose={() => setOpened(undefined)}
          onSaved={(documentEjson) => onDocumentSaved(opened.index, documentEjson)}
        />
      )}
    </Stack>
  );
}

function isDocument(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** One document of a result that cannot be edited. It opens read-only, with a copy action. */
function DocumentModal({ full, onClose }: { readonly full: string; readonly onClose: () => void }) {
  const source = useMemo(() => ({ printableEjson: full }), [full]);
  return (
    <Modal opened onClose={onClose} title="Document" centered size="xl">
      <Stack gap="sm">
        <div style={{ height: 420 }}>
          <JsonView source={source} label="Document as JSON" />
        </div>
        <Group justify="flex-end">
          <Button
            variant="default"
            leftSection={<IconCopy size={13} />}
            onClick={() => void navigator.clipboard.writeText(jsonTextFor(source, 'canonical'))}
          >
            Copy
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
