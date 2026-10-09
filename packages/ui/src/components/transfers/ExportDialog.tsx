import {
  Alert,
  Button,
  Group,
  Modal,
  SegmentedControl,
  Select,
  Stack,
  TagsInput,
  Text,
  TextInput,
  Title,
  Tooltip,
} from '@mantine/core';
import {
  toAppError,
  type AppError,
  type CsvDelimiter,
  type ExportFormat,
  type TransferProgress,
} from '@mongo-gui/core';
import { useState } from 'react';
import { useUiApi } from '../../api/ui-api';
import { useAppStore } from '../../state/app-store-context';
import { errorText } from '../notify-error';
import { TransferProgressView } from './TransferProgressView';
import {
  DEFAULT_EXPORT_DRAFT,
  exportOptionsFor,
  exportProblemsOf,
  type ExportDraft,
} from './export-model';
import {
  DELIMITER_LABELS,
  DELIMITERS,
  defaultExportFileName,
  EXPORT_FORMAT_LABELS,
  filterFor,
} from './transfer-model';

export interface ExportDialogProps {
  readonly connectionId: string;
  readonly database: string;
  readonly collection: string;
  readonly onClose: () => void;
}

/** Modal that exports a collection, or a query result, to a file. */
export function ExportDialog(props: ExportDialogProps) {
  return (
    <Modal opened onClose={props.onClose} title="Export data" size="lg" centered>
      <ExportDialogBody {...props} />
    </Modal>
  );
}

/** The dialog without its modal, so the form and the progress can be shown on their own. */
export function ExportDialogBody({
  connectionId,
  database,
  collection,
  onClose,
}: ExportDialogProps) {
  const { rpc } = useUiApi();
  const startTransferExport = useAppStore((state) => state.startTransferExport);
  const cancelTransfer = useAppStore((state) => state.cancelTransfer);
  const [draft, setDraft] = useState<ExportDraft>({ ...DEFAULT_EXPORT_DRAFT });
  const [error, setError] = useState<AppError | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [transferId, setTransferId] = useState<string | undefined>(undefined);
  const view = useAppStore((state) =>
    transferId === undefined ? undefined : state.transfers[transferId],
  );
  const [showFolderError, setShowFolderError] = useState<AppError | undefined>(undefined);

  const problems = exportProblemsOf(draft);

  function patch(next: Partial<ExportDraft>) {
    setDraft((current) => ({ ...current, ...next }));
  }

  async function saveAs() {
    setError(undefined);
    try {
      const picked = await rpc.app.showSaveDialog({
        title: 'Save export as',
        defaultPath: defaultExportFileName(database, collection, draft.format),
        filters: [filterFor(draft.format)],
      });
      if (picked.path !== undefined) {
        patch({ path: picked.path });
      }
    } catch (failure) {
      setError(toAppError(failure));
    }
  }

  async function start() {
    setError(undefined);
    setBusy(true);
    try {
      const started = await startTransferExport({
        connectionId,
        database,
        collection,
        path: draft.path,
        options: exportOptionsFor(draft),
      });
      setTransferId(started);
    } catch (failure) {
      setError(toAppError(failure));
    } finally {
      setBusy(false);
    }
  }

  async function cancel() {
    if (transferId === undefined) {
      return;
    }
    try {
      await cancelTransfer(transferId);
    } catch (failure) {
      setError(toAppError(failure));
    }
  }

  async function showInFolder(path: string) {
    setShowFolderError(undefined);
    try {
      await rpc.app.showItemInFolder({ path });
    } catch (failure) {
      setShowFolderError(toAppError(failure));
    }
  }

  if (transferId !== undefined) {
    const progress = view?.progress;
    return (
      <Stack gap="md">
        <Title order={5}>
          Exporting {database}.{collection}
        </Title>
        {progress === undefined ? (
          <Text size="sm" c="dimmed">
            Starting the export
          </Text>
        ) : (
          <TransferProgressView
            kind="export"
            progress={progress}
            onCancel={() => {
              void cancel();
            }}
          />
        )}
        {progress?.done === true ? (
          <ExportSummary
            progress={progress}
            path={draft.path}
            onShow={() => {
              void showInFolder(draft.path);
            }}
            onClose={onClose}
            folderError={showFolderError}
          />
        ) : null}
        {error === undefined ? null : (
          <Alert color="red" role="alert">
            {errorText(error)}
          </Alert>
        )}
      </Stack>
    );
  }

  return (
    <Stack gap="md">
      <Text size="sm" c="dimmed">
        {database}.{collection}
      </Text>
      <Select
        label="Format"
        data={(['json-array', 'ndjson', 'csv'] as ExportFormat[]).map((value) => ({
          value,
          label: EXPORT_FORMAT_LABELS[value],
        }))}
        value={draft.format}
        allowDeselect={false}
        onChange={(value) => {
          if (value !== null) {
            patch({ format: value as ExportFormat });
          }
        }}
      />
      {draft.format === 'csv' ? null : (
        <SegmentedControl
          aria-label="EJSON mode"
          data={[
            { value: 'canonical', label: 'Canonical EJSON' },
            { value: 'relaxed', label: 'Relaxed EJSON' },
          ]}
          value={draft.ejsonMode}
          onChange={(value) => patch({ ejsonMode: value as ExportDraft['ejsonMode'] })}
        />
      )}
      <TextInput
        label="Filter"
        placeholder='{"status": "paid"}'
        description="Extended JSON. Empty exports every document."
        value={draft.filter}
        error={fieldError(problems, 'filter')}
        onChange={(event) => patch({ filter: event.currentTarget.value })}
      />
      <TextInput
        label="Projection"
        placeholder='{"customer": 1, "total": 1}'
        value={draft.projection}
        error={fieldError(problems, 'projection')}
        onChange={(event) => patch({ projection: event.currentTarget.value })}
      />
      <TextInput
        label="Sort"
        placeholder='{"createdAt": -1}'
        value={draft.sort}
        error={fieldError(problems, 'sort')}
        onChange={(event) => patch({ sort: event.currentTarget.value })}
      />
      <TextInput
        label="Limit"
        placeholder="No limit"
        value={draft.limit}
        error={fieldError(problems, 'limit')}
        onChange={(event) => patch({ limit: event.currentTarget.value })}
      />
      {draft.format === 'csv' ? (
        <Stack gap="xs" aria-label="CSV options">
          <Select
            label="Delimiter"
            data={DELIMITERS.map((value) => ({ value, label: DELIMITER_LABELS[value] }))}
            value={draft.delimiter}
            allowDeselect={false}
            onChange={(value) => {
              if (value !== null) {
                patch({ delimiter: value as CsvDelimiter });
              }
            }}
          />
          <Select
            label="Arrays and objects"
            data={[
              { value: 'json', label: 'Write as JSON text' },
              { value: 'join', label: 'Join scalar items with a comma' },
            ]}
            value={draft.flattenArrays}
            allowDeselect={false}
            onChange={(value) => {
              if (value !== null) {
                patch({ flattenArrays: value as ExportDraft['flattenArrays'] });
              }
            }}
          />
          <TagsInput
            size="sm"
            label="Columns"
            description="In this order. Empty writes every field found in the first 1,000 documents."
            placeholder="Add a field name"
            value={[...draft.columns]}
            onChange={(columns) => patch({ columns })}
          />
        </Stack>
      ) : null}
      <Group align="flex-end" wrap="nowrap">
        <TextInput
          label="File"
          placeholder="/home/you/orders.ndjson"
          value={draft.path}
          onChange={(event) => patch({ path: event.currentTarget.value })}
          style={{ flex: 1 }}
        />
        <Button variant="default" onClick={() => void saveAs()}>
          Save as
        </Button>
      </Group>
      {error === undefined ? null : (
        <Alert color="red" role="alert">
          {errorText(error)}
        </Alert>
      )}
      <Group justify="space-between">
        <Button variant="default" onClick={onClose}>
          Cancel
        </Button>
        <Tooltip label={problems[0]?.message} disabled={problems.length === 0}>
          <Button disabled={problems.length > 0} loading={busy} onClick={() => void start()}>
            Start export
          </Button>
        </Tooltip>
      </Group>
    </Stack>
  );
}

function fieldError(
  problems: readonly { field: string; message: string }[],
  field: string,
): string | undefined {
  return problems.find((problem) => problem.field === field)?.message;
}

export interface ExportSummaryProps {
  readonly progress: TransferProgress;
  readonly path: string;
  readonly onShow: () => void;
  readonly onClose: () => void;
  readonly folderError: AppError | undefined;
}

/** The result of a finished export. The file can be shown only when the export wrote it. */
export function ExportSummary({
  progress,
  path,
  onShow,
  onClose,
  folderError,
}: ExportSummaryProps) {
  const cancelled = progress.error?.code === 'CANCELLED';
  const written = progress.error === undefined;
  return (
    <Stack gap="sm" data-testid="export-summary">
      <Alert
        color={written ? 'green' : cancelled ? 'yellow' : 'red'}
        title={written ? 'Export finished' : cancelled ? 'Cancelled' : 'The export failed'}
      >
        {written
          ? `Exported ${progress.processed.toLocaleString('en-US')} documents to ${path}.`
          : cancelled
            ? 'The export was cancelled and the partial file was removed.'
            : errorText(progress.error)}
      </Alert>
      {folderError === undefined ? null : (
        <Alert color="red" role="alert">
          {errorText(folderError)}
        </Alert>
      )}
      <Group justify="flex-end">
        {written ? (
          <Button variant="default" onClick={onShow}>
            Show in folder
          </Button>
        ) : null}
        <Button onClick={onClose}>Close</Button>
      </Group>
    </Stack>
  );
}
