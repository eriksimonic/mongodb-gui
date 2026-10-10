import { Alert, Badge, Button, Group, SegmentedControl, Stack, Text } from '@mantine/core';
import { modals } from '@mantine/modals';
import { IconCopy } from '@tabler/icons-react';
import { useEffect, useMemo, useState } from 'react';
import type { AppError } from '@mongo-gui/core';
import { errorText } from '../components/notify-error';
import { LOAD_ALL_LIMIT, type ResultSet, type ResultView, type RunState } from '../state/editors';
import { DocumentEditorDialog } from '../components/management/DocumentEditorDialog';
import { formatJson } from '../management/input-rules';
import { discoverColumns, formatCount, type JsonObject } from './result-model';
import { JsonView } from './JsonView';
import { jsonTextFor } from './json-text';
import type { ExportFormat } from './result-export';
import { TableView } from './TableView';
import { TreeView, type TreeEdit } from './TreeView';

const VIEW_LABELS: Readonly<Record<ResultView, string>> = {
  table: 'Table',
  tree: 'Tree',
  json: 'JSON',
};
const TICK_MS = 250;
const MILLIS_PER_SECOND = 1000;

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
  onSetField,
  onUnsetField,
  onExport,
}: ResultsPaneProps) {
  const [selected, setSelected] = useState<readonly number[]>([]);
  const [openIndex, setOpenIndex] = useState<number | undefined>(undefined);
  const elapsed = useElapsed(running);
  const isCursor = result !== undefined && result.printableEjson === undefined;
  const effectiveView: ResultView = isCursor ? view : 'json';
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
  const editable = isCursor && target !== undefined;
  const editabilityNote = editable
    ? ''
    : 'Only a plain find on one collection can be edited. This result does not come from one.';
  const count = result?.documents.length ?? 0;

  function copyJson(): void {
    if (result === undefined) {
      return;
    }
    const chosen =
      selected.length === 0
        ? result.documents
        : selected.map((index) => result.documents[index]).filter(isDocument);
    const text = jsonTextFor({ documents: chosen }, 'canonical');
    void navigator.clipboard.writeText(text);
  }

  return (
    <Stack gap={6} h="100%" style={{ minHeight: 0 }} data-testid="results-pane">
      <Group justify="space-between" wrap="nowrap" gap="xs">
        <Group gap="xs" wrap="nowrap">
          <SegmentedControl
            size="xs"
            aria-label="Result view"
            value={effectiveView}
            disabled={!isCursor}
            onChange={(value) => onView(value as ResultView)}
            data={(Object.keys(VIEW_LABELS) as ResultView[]).map((key) => ({
              value: key,
              label: VIEW_LABELS[key],
            }))}
          />
          {result === undefined || !isCursor ? null : (
            <Text size="xs" c="dimmed" aria-live="polite">
              {formatCount(count, result.hasMore)}
            </Text>
          )}
          {result?.summary === undefined ? null : (
            <Badge tt="none" size="sm" variant="light" color="teal" data-testid="result-summary">
              {result.summary}
            </Badge>
          )}
        </Group>
        <Group gap="xs" wrap="nowrap">
          {running !== undefined && elapsed !== undefined ? (
            <Text size="xs" c="dimmed">
              Running {seconds(elapsed)}
            </Text>
          ) : result === undefined ? null : (
            <Text size="xs" c="dimmed">
              {seconds(result.elapsedMs)}
            </Text>
          )}
          {result === undefined || !isCursor ? null : (
            <>
              <Button
                size="xs"
                variant="default"
                disabled={
                  !result.hasMore || result.loadingMore || result.cursorRequestId === undefined
                }
                onClick={onLoadMore}
              >
                Load more
              </Button>
              <Button
                size="xs"
                variant="default"
                disabled={
                  !result.hasMore || result.loadingMore || result.cursorRequestId === undefined
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
                onClick={copyJson}
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
      {error === undefined ? null : (
        <Alert color="red" variant="light" role="alert" p="xs">
          {errorText(error)}
        </Alert>
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
              editable={editable}
              editabilityNote={editabilityNote}
              onOpenDocument={setOpenIndex}
              onSelectionChange={setSelected}
            />
          ) : effectiveView === 'tree' ? (
            <TreeView
              documents={result.documents}
              editable={editable}
              editabilityNote={editabilityNote}
              onSetField={onSetField}
              onUnsetField={onUnsetField}
            />
          ) : (
            <JsonView source={jsonSource} label="Result as JSON" />
          )}
        </div>
      )}
      {target === undefined ||
      openIndex === undefined ||
      result?.documents[openIndex] === undefined ? null : (
        <DocumentEditorDialog
          connectionId={target.connectionId}
          database={target.database}
          collection={target.collection}
          mode="edit"
          initialText={formatJson(result.documents[openIndex])}
          idEjson={JSON.stringify(result.documents[openIndex]._id)}
          onClose={() => setOpenIndex(undefined)}
          onSaved={(documentEjson) => onDocumentSaved(openIndex, documentEjson)}
        />
      )}
    </Stack>
  );
}

function isDocument(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
