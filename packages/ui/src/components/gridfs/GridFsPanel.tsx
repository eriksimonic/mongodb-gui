import { Alert, Button, Group, Loader, Select, Stack, Text, TextInput } from '@mantine/core';
import {
  IconCopy,
  IconDownload,
  IconPencil,
  IconRefresh,
  IconTrash,
  IconUpload,
} from '@tabler/icons-react';
import type { GridFsFile, GridFsStartDownloadCall } from '@mongo-gui/core';
import { useEffect, useState } from 'react';
import { useUiApi } from '../../api/ui-api';
import { toAppError } from '@mongo-gui/core';
import { useAppStore } from '../../state/app-store-context';
import type { Loadable } from '../../state/app-store';
import { isRunning, listTransfers } from '../../state/transfer-state';
import { TransferLine, TransferSummaryLine } from '../transfers/TransfersPanel';
import { errorText, runReported } from '../notify-error';
import {
  DeleteFilesDialog,
  MetadataDialog,
  OverwriteDialog,
  RenameFileDialog,
} from './GridFsFileDialogs';
import { GridFsFileDrawer } from './GridFsFileDrawer';
import { GridFsFileTable } from './GridFsFileTable';
import {
  LIMIT_OPTIONS,
  SORT_OPTIONS,
  downloadFileName,
  joinFolderPath,
  selectedFiles,
  toggleSelected,
  type SortValue,
} from './gridfs-model';

const FILTER_DEBOUNCE_MS = 200;
const DEFAULT_LIMIT = 200;
/** Newest first for uploads and sizes, A to Z for names. */
const SORT_DIRECTION: Readonly<Record<SortValue, 'asc' | 'desc'>> = {
  uploadDate: 'desc',
  filename: 'asc',
  length: 'desc',
};

export interface GridFsPanelProps {
  readonly connectionId: string;
  readonly database: string;
  readonly bucket: string;
}

type PanelDialog =
  | { readonly kind: 'rename' | 'metadata'; readonly file: GridFsFile }
  | { readonly kind: 'delete'; readonly files: readonly GridFsFile[] };

/** Files that exist in the chosen folder and wait for a replace answer, in order. */
interface PendingOverwrite {
  readonly items: readonly { readonly file: GridFsFile; readonly path: string }[];
}

/** Whether a call failed because the target file exists. The router sends this code. */
function isAlreadyExists(error: unknown): boolean {
  return toAppError(error).code === 'ALREADY_EXISTS';
}

/**
 * The files of one bucket. Toolbar with upload, refresh, a filename filter, sort and limit. A table
 * with multi-select and row actions, the transfers of this bucket, a detail drawer and the dialogs.
 */
export function GridFsPanel({ connectionId, database, bucket }: GridFsPanelProps) {
  const { rpc } = useUiApi();
  const revision = useAppStore((state) => state.gridfsRevision);
  const transfers = useAppStore((state) => state.transfers);
  const uploadGridFsFile = useAppStore((state) => state.uploadGridFsFile);
  const startGridFsDownload = useAppStore((state) => state.startGridFsDownload);
  const refreshGridFs = useAppStore((state) => state.refreshGridFs);
  const refreshTransfers = useAppStore((state) => state.refreshTransfers);
  const [filterInput, setFilterInput] = useState('');
  const [filter, setFilter] = useState('');
  const [sort, setSort] = useState<SortValue>('uploadDate');
  const [limit, setLimit] = useState<number>(DEFAULT_LIMIT);
  const [files, setFiles] = useState<Loadable<readonly GridFsFile[]>>({ state: 'loading' });
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  const [drawerId, setDrawerId] = useState<string | undefined>(undefined);
  const [dialog, setDialog] = useState<PanelDialog | undefined>(undefined);
  const [overwrite, setOverwrite] = useState<PendingOverwrite | undefined>(undefined);
  const [notice, setNotice] = useState<string | undefined>(undefined);

  // A job that started before this panel opened, or before a reload, is listed from the backend.
  useEffect(() => {
    void runReported(refreshTransfers);
  }, [refreshTransfers]);

  // The filter waits a moment after the last key, so each pause makes one list call.
  useEffect(() => {
    const timer = setTimeout(() => {
      setFilter(filterInput);
    }, FILTER_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [filterInput]);

  useEffect(() => {
    let active = true;
    rpc.gridfs
      .listFiles({
        connectionId,
        database,
        bucket,
        ...(filter === '' ? {} : { filter: { filenameContains: filter } }),
        sort,
        direction: SORT_DIRECTION[sort],
        limit,
      })
      .then(
        (data) => {
          if (active) {
            setFiles({ state: 'ready', data });
            // A reload can remove files, so the selection keeps only the ids that are still listed.
            setSelected((previous) => keepListed(previous, data));
          }
        },
        (error: unknown) => {
          if (active) {
            setFiles({ state: 'error', error: toAppError(error) });
          }
        },
      );
    return () => {
      active = false;
    };
  }, [rpc, connectionId, database, bucket, filter, sort, limit, revision]);

  const rows = files.state === 'ready' ? files.data : [];

  const chosen = selectedFiles(rows, selected);
  const drawerFile = rows.find((file) => file.idEjson === drawerId);
  // Running jobs sit above the table. Finished ones are single lines below it, so they do not push
  // the file list down.
  const jobs = listTransfers(transfers).filter(
    (view) =>
      (view.kind === 'gridfs-upload' || view.kind === 'gridfs-download') &&
      view.database === database &&
      view.collection === bucket &&
      (view.connectionId === undefined || view.connectionId === connectionId),
  );
  const runningJobs = jobs.filter(isRunning);
  const finishedJobs = jobs.filter((view) => !isRunning(view));

  async function download(list: readonly GridFsFile[]): Promise<void> {
    const [single] = list;
    if (single !== undefined && list.length === 1) {
      const picked = await rpc.app.showSaveDialog({
        title: 'Save file',
        filters: [{ name: 'File', extensions: [extensionOf(single.filename)] }],
        defaultPath: single.filename,
      });
      if (picked.path !== undefined) {
        // The user chose this path in the save dialog, so the existing file may be replaced.
        await startGridFsDownload({
          connectionId,
          database,
          bucket,
          idEjson: single.idEjson,
          path: picked.path,
          overwrite: true,
        });
      }
      return;
    }
    const folder = await rpc.app.showOpenDialog({
      title: 'Choose a folder',
      filters: [],
      directory: true,
    });
    if (folder.path === undefined) {
      return;
    }
    const existing: { file: GridFsFile; path: string }[] = [];
    for (const file of list) {
      const path = joinFolderPath(folder.path, downloadFileName(file.filename, file.idEjson));
      try {
        await startGridFsDownload({ connectionId, database, bucket, idEjson: file.idEjson, path });
      } catch (error) {
        if (isAlreadyExists(error)) {
          existing.push({ file, path });
        } else {
          setNotice(errorText(error));
        }
      }
    }
    if (existing.length > 0) {
      setOverwrite({ items: existing });
    }
  }

  async function replace(item: { readonly file: GridFsFile; readonly path: string }) {
    const request: GridFsStartDownloadCall = {
      connectionId,
      database,
      bucket,
      idEjson: item.file.idEjson,
      path: item.path,
      overwrite: true,
    };
    try {
      await startGridFsDownload(request);
    } catch (error) {
      setNotice(errorText(error));
    }
  }

  async function answerOverwrite(answer: 'skip' | 'replace' | 'replaceAll' | 'stop') {
    const pending = overwrite;
    const [current, ...rest] = pending?.items ?? [];
    if (pending === undefined || current === undefined || answer === 'stop') {
      setOverwrite(undefined);
      return;
    }
    if (answer === 'replaceAll') {
      setOverwrite(undefined);
      for (const item of pending.items) {
        await replace(item);
      }
      return;
    }
    if (answer === 'replace') {
      await replace(current);
    }
    setOverwrite(rest.length === 0 ? undefined : { items: rest });
  }

  function deleteFiles(list: readonly GridFsFile[]) {
    if (list.length > 0) {
      setDialog({ kind: 'delete', files: list });
    }
  }

  function copyId(file: GridFsFile) {
    void navigator.clipboard?.writeText(file.idEjson).catch(() => undefined);
  }

  const onDone = () => {
    setSelected(new Set());
    setDrawerId(undefined);
  };
  const current = overwrite?.items[0];

  return (
    <Stack h="100%" gap="xs" p="sm" style={{ minHeight: 0 }}>
      <Group gap="xs" wrap="wrap">
        <Button
          size="xs"
          leftSection={<IconUpload size={14} />}
          onClick={() => void runReported(() => uploadGridFsFile(connectionId, database, bucket))}
        >
          Upload
        </Button>
        <Button
          size="xs"
          variant="default"
          leftSection={<IconRefresh size={14} />}
          onClick={() => void runReported(() => refreshGridFs(connectionId, database))}
        >
          Refresh
        </Button>
        <TextInput
          size="xs"
          placeholder="Filename contains"
          aria-label="Filename contains"
          value={filterInput}
          onChange={(event) => setFilterInput(event.currentTarget.value)}
          w={200}
        />
        <Select
          size="xs"
          aria-label="Sort by"
          allowDeselect={false}
          value={sort}
          data={SORT_OPTIONS.map((option) => ({ value: option.value, label: option.label }))}
          onChange={(value) => {
            if (value !== null) {
              setSort(value as SortValue);
            }
          }}
          w={150}
        />
        <Select
          size="xs"
          aria-label="Limit"
          allowDeselect={false}
          value={String(limit)}
          data={LIMIT_OPTIONS.map((option) => ({
            value: String(option),
            label: `${option} files`,
          }))}
          onChange={(value) => {
            if (value !== null) {
              setLimit(Number(value));
            }
          }}
          w={120}
        />
      </Group>
      <Group gap="xs" wrap="wrap" aria-label="Selection actions">
        <Text size="xs" c="dimmed">
          {chosen.length} selected
        </Text>
        <Button
          size="xs"
          variant="default"
          leftSection={<IconDownload size={14} />}
          disabled={chosen.length === 0}
          onClick={() => void runReported(() => download(chosen))}
        >
          Download
        </Button>
        <Button
          size="xs"
          variant="default"
          leftSection={<IconPencil size={14} />}
          disabled={chosen.length !== 1}
          onClick={() => {
            const [file] = chosen;
            if (file !== undefined) {
              setDialog({ kind: 'rename', file });
            }
          }}
        >
          Rename
        </Button>
        <Button
          size="xs"
          variant="default"
          leftSection={<IconCopy size={14} />}
          disabled={chosen.length !== 1}
          onClick={() => {
            const [file] = chosen;
            if (file !== undefined) {
              copyId(file);
            }
          }}
        >
          Copy id
        </Button>
        <Button
          size="xs"
          color="red"
          variant="light"
          leftSection={<IconTrash size={14} />}
          disabled={chosen.length === 0}
          onClick={() => deleteFiles(chosen)}
        >
          Delete
        </Button>
      </Group>
      {notice === undefined ? null : (
        <Alert color="red" variant="light" onClose={() => setNotice(undefined)} withCloseButton>
          {notice}
        </Alert>
      )}
      {runningJobs.length === 0 ? null : (
        <Stack gap="xs" aria-label="Transfers of this bucket">
          {runningJobs.map((view) => (
            <TransferLine key={view.transferId} view={view} />
          ))}
        </Stack>
      )}
      {files.state === 'loading' ? <Loader size="sm" aria-label="Loading files" /> : null}
      {files.state === 'error' ? (
        <Alert color="red" variant="light">
          {errorText(files.error)}
        </Alert>
      ) : null}
      {files.state === 'ready' && files.data.length === 0 ? (
        <Text size="sm" c="dimmed">
          {filter === ''
            ? 'This bucket has no files yet. Upload a file to start.'
            : 'No file matches the filter.'}
        </Text>
      ) : null}
      {files.state === 'ready' && files.data.length > 0 ? (
        <GridFsFileTable
          files={files.data}
          selected={selected}
          onToggle={(id) => setSelected((previous) => toggleSelected(previous, id))}
          onToggleAll={() =>
            setSelected((previous) =>
              previous.size === files.data.length
                ? new Set()
                : new Set(files.data.map((f) => f.idEjson)),
            )
          }
          onOpen={setDrawerId}
          onDownload={(file) => void runReported(() => download([file]))}
          onRename={(file) => setDialog({ kind: 'rename', file })}
          onEditMetadata={(file) => setDialog({ kind: 'metadata', file })}
          onDelete={(file) => deleteFiles([file])}
        />
      ) : null}
      {finishedJobs.length === 0 ? null : (
        <Stack gap={2} aria-label="Finished transfers of this bucket">
          {finishedJobs.map((view) => (
            <TransferSummaryLine key={view.transferId} view={view} />
          ))}
        </Stack>
      )}
      {drawerFile === undefined ? null : (
        <GridFsFileDrawer
          file={drawerFile}
          onClose={() => setDrawerId(undefined)}
          onDownload={() => void runReported(() => download([drawerFile]))}
          onRename={() => setDialog({ kind: 'rename', file: drawerFile })}
          onEditMetadata={() => setDialog({ kind: 'metadata', file: drawerFile })}
          onDelete={() => deleteFiles([drawerFile])}
        />
      )}
      {dialog === undefined || dialog.kind === 'delete' ? null : dialog.kind === 'rename' ? (
        <RenameFileDialog
          connectionId={connectionId}
          database={database}
          bucket={bucket}
          file={dialog.file}
          onClose={() => setDialog(undefined)}
        />
      ) : (
        <MetadataDialog
          connectionId={connectionId}
          database={database}
          bucket={bucket}
          file={dialog.file}
          onClose={() => setDialog(undefined)}
        />
      )}
      {dialog?.kind === 'delete' ? (
        <DeleteFilesDialog
          connectionId={connectionId}
          database={database}
          bucket={bucket}
          files={dialog.files}
          onDeleted={onDone}
          onClose={() => setDialog(undefined)}
        />
      ) : null}
      {current === undefined || overwrite === undefined ? null : (
        <OverwriteDialog
          filename={current.file.filename}
          waiting={overwrite.items.length - 1}
          onSkip={() => void answerOverwrite('skip')}
          onReplace={() => void answerOverwrite('replace')}
          onReplaceAll={() => void answerOverwrite('replaceAll')}
          onStop={() => void answerOverwrite('stop')}
        />
      )}
    </Stack>
  );
}

/** The selected ids that are still in the list. The same set comes back when nothing changed. */
function keepListed(
  previous: ReadonlySet<string>,
  files: readonly GridFsFile[],
): ReadonlySet<string> {
  const listed = new Set(files.map((file) => file.idEjson));
  const kept = new Set([...previous].filter((id) => listed.has(id)));
  return kept.size === previous.size ? previous : kept;
}

/** The extension a save dialog filters on. Names without a plain extension use "bin". */
function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf('.');
  const extension = dot > 0 ? filename.slice(dot + 1) : '';
  return /^[A-Za-z0-9]+$/.test(extension) ? extension : 'bin';
}
