import { Button, Group, Modal, Stack, Text, Textarea, TextInput } from '@mantine/core';
import type { GridFsFile } from '@mongo-gui/core';
import { useState } from 'react';
import { useUiApi } from '../../api/ui-api';
import { useAppStore } from '../../state/app-store-context';
import { DestructiveDialog } from '../management/DestructiveDialog';
import { errorText } from '../notify-error';
import { filenameProblem, formatMetadata, parseMetadataDraft } from './gridfs-model';

/** The bucket a file dialog acts on. */
export interface FileTarget {
  readonly connectionId: string;
  readonly database: string;
  readonly bucket: string;
}

interface RenameFileDialogProps extends FileTarget {
  readonly file: GridFsFile;
  readonly onClose: () => void;
}

/** Renames one file. The name is checked with the same rules as the backend. */
export function RenameFileDialog({
  connectionId,
  database,
  bucket,
  file,
  onClose,
}: RenameFileDialogProps) {
  const { rpc } = useUiApi();
  const refreshGridFs = useAppStore((state) => state.refreshGridFs);
  const [name, setName] = useState(file.filename);
  const [failure, setFailure] = useState<string | undefined>(undefined);
  const problem = filenameProblem(name);
  const unchanged = name === file.filename;
  async function save() {
    setFailure(undefined);
    try {
      await rpc.gridfs.renameFile({
        connectionId,
        database,
        bucket,
        idEjson: file.idEjson,
        filename: name,
      });
      await refreshGridFs(connectionId, database);
      onClose();
    } catch (error) {
      setFailure(errorText(error));
    }
  }
  return (
    <Modal opened onClose={onClose} title={`Rename ${file.filename}`} centered size="sm">
      <Stack gap="sm">
        <TextInput
          label="File name"
          value={name}
          onChange={(event) => setName(event.currentTarget.value)}
          error={failure ?? (name === '' ? undefined : problem)}
          autoComplete="off"
          spellCheck={false}
          data-autofocus
        />
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={problem !== undefined || unchanged} onClick={() => void save()}>
            Rename
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

interface MetadataDialogProps extends FileTarget {
  readonly file: GridFsFile;
  readonly onClose: () => void;
}

/** Edits the metadata of one file as JSON. The text must be one object. An empty text clears it. */
export function MetadataDialog({
  connectionId,
  database,
  bucket,
  file,
  onClose,
}: MetadataDialogProps) {
  const { rpc } = useUiApi();
  const refreshGridFs = useAppStore((state) => state.refreshGridFs);
  const [text, setText] = useState(() => formatMetadata(file.metadataEjson));
  const [failure, setFailure] = useState<string | undefined>(undefined);
  const draft = parseMetadataDraft(text);
  async function save() {
    if (!draft.ok) {
      return;
    }
    setFailure(undefined);
    try {
      await rpc.gridfs.setMetadata({
        connectionId,
        database,
        bucket,
        idEjson: file.idEjson,
        metadataEjson: draft.metadataEjson,
      });
      await refreshGridFs(connectionId, database);
      onClose();
    } catch (error) {
      setFailure(errorText(error));
    }
  }
  return (
    <Modal opened onClose={onClose} title={`Metadata of ${file.filename}`} centered size="lg">
      <Stack gap="sm">
        <Textarea
          label="Metadata as JSON"
          value={text}
          onChange={(event) => setText(event.currentTarget.value)}
          minRows={8}
          autosize
          styles={{ input: { fontFamily: 'monospace' } }}
          error={failure ?? (draft.ok ? undefined : draft.message)}
          spellCheck={false}
          data-autofocus
        />
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={!draft.ok} onClick={() => void save()}>
            Save metadata
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

/** How many names the delete dialog lists before it says how many more there are. */
const LISTED_NAMES = 10;

interface DeleteFilesDialogProps extends FileTarget {
  readonly files: readonly GridFsFile[];
  readonly onDeleted: () => void;
  readonly onClose: () => void;
}

/** Deletes the files after a confirmation that names them and gives the count. */
export function DeleteFilesDialog({
  connectionId,
  database,
  bucket,
  files,
  onDeleted,
  onClose,
}: DeleteFilesDialogProps) {
  const { rpc } = useUiApi();
  const refreshGridFs = useAppStore((state) => state.refreshGridFs);
  const listed = files.slice(0, LISTED_NAMES);
  const more = files.length - listed.length;
  const count = files.length === 1 ? '1 file' : `${files.length} files`;
  return (
    <DestructiveDialog
      title={`Delete ${count}`}
      description={
        <Stack gap={4}>
          <Text size="sm">Delete these files and their chunks? This cannot be undone.</Text>
          {listed.map((file) => (
            <Text key={file.idEjson} size="sm" ff="monospace">
              {file.filename}
            </Text>
          ))}
          {more > 0 ? <Text size="sm">and {more} more</Text> : null}
        </Stack>
      }
      confirmLabel={`Delete ${count}`}
      onConfirm={async () => {
        await rpc.gridfs.deleteFiles({
          connectionId,
          database,
          bucket,
          idsEjson: files.map((file) => file.idEjson),
        });
        await refreshGridFs(connectionId, database);
        onDeleted();
      }}
      onClose={onClose}
    />
  );
}

interface OverwriteDialogProps {
  /** The file that already exists in the folder. */
  readonly filename: string;
  /** Files still waiting after this one. */
  readonly waiting: number;
  readonly onSkip: () => void;
  readonly onReplace: () => void;
  readonly onReplaceAll: () => void;
  readonly onStop: () => void;
}

/** Asks whether one file that exists in the chosen folder should be replaced. */
export function OverwriteDialog({
  filename,
  waiting,
  onSkip,
  onReplace,
  onReplaceAll,
  onStop,
}: OverwriteDialogProps) {
  return (
    <Modal opened onClose={onStop} title="Replace existing file?" centered size="sm">
      <Stack gap="sm">
        <Text size="sm" ff="monospace">
          {filename}
        </Text>
        <Text size="sm">
          A file with this name already exists in the folder. Replacing it cannot be undone.
          {waiting > 0
            ? ` ${waiting} more file${waiting === 1 ? '' : 's'} wait for an answer.`
            : ''}
        </Text>
        <Group justify="flex-end" wrap="wrap">
          <Button variant="default" onClick={onStop}>
            Stop
          </Button>
          <Button variant="default" onClick={onSkip}>
            Skip
          </Button>
          <Button variant="light" onClick={onReplaceAll}>
            Replace all
          </Button>
          <Button color="red" onClick={onReplace}>
            Replace
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
