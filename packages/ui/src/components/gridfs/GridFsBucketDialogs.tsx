import { Button, Group, Modal, Stack, Text, TextInput } from '@mantine/core';
import { GridFsBucketNameSchema } from '@mongo-gui/core';
import { useState } from 'react';
import { useUiApi } from '../../api/ui-api';
import { useAppStore } from '../../state/app-store-context';
import type { GridFsDialogState } from '../../state/app-store';
import { DestructiveDialog } from '../management/DestructiveDialog';
import { runReported } from '../notify-error';
import { useGridFsOpener } from './gridfs-opener';

/** Shows the bucket dialog the store names, if one is open. The tree opens them. */
export function GridFsBucketDialogs() {
  const dialog = useAppStore((state) => state.gridfsDialog);
  const setGridFsDialog = useAppStore((state) => state.setGridFsDialog);
  if (dialog === undefined) {
    return null;
  }
  const onClose = () => setGridFsDialog(undefined);
  return dialog.kind === 'newBucket' ? (
    <NewBucketDialog dialog={dialog} onClose={onClose} />
  ) : (
    <DropBucketDialog dialog={dialog} onClose={onClose} />
  );
}

function bucketNameProblem(name: string): string | undefined {
  const result = GridFsBucketNameSchema.safeParse(name);
  return result.success ? undefined : (result.error.issues[0]?.message ?? 'Enter a bucket name');
}

interface NewBucketDialogProps {
  readonly dialog: Extract<GridFsDialogState, { kind: 'newBucket' }>;
  readonly onClose: () => void;
}

/**
 * Asks for a bucket name. A bucket exists once it holds a file, so the dialog goes straight on to
 * the file dialog for that name.
 */
function NewBucketDialog({ dialog, onClose }: NewBucketDialogProps) {
  const uploadGridFsFile = useAppStore((state) => state.uploadGridFsFile);
  const [name, setName] = useState('');
  const problem = name === '' ? undefined : bucketNameProblem(name);
  return (
    <Modal opened onClose={onClose} title="New GridFS bucket" centered size="sm">
      <Stack gap="sm">
        <Text size="sm">
          A bucket appears in {dialog.database} after its first upload. Choose the file to upload
          next.
        </Text>
        <TextInput
          label="Bucket name"
          value={name}
          onChange={(event) => setName(event.currentTarget.value)}
          error={problem}
          autoComplete="off"
          spellCheck={false}
          data-autofocus
        />
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={name === '' || problem !== undefined}
            onClick={() => {
              onClose();
              void runReported(() => uploadGridFsFile(dialog.connectionId, dialog.database, name));
            }}
          >
            Choose file
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

interface DropBucketDialogProps {
  readonly dialog: Extract<GridFsDialogState, { kind: 'dropBucket' }>;
  readonly onClose: () => void;
}

/** Drops a bucket's files and chunks after the user types its name. */
export function DropBucketDialog({ dialog, onClose }: DropBucketDialogProps) {
  const { rpc } = useUiApi();
  const refreshGridFs = useAppStore((state) => state.refreshGridFs);
  const opener = useGridFsOpener();
  const { connectionId, database, bucket } = dialog;
  return (
    <DestructiveDialog
      title={`Drop ${bucket}`}
      description={`Drop the bucket ${database}.${bucket}? Every file and chunk in it is deleted. This cannot be undone.`}
      confirmLabel="Drop bucket"
      typedConfirmation={bucket}
      onConfirm={async () => {
        await rpc.gridfs.dropBucket({ connectionId, database, bucket });
        opener?.close(connectionId, database, bucket);
        await refreshGridFs(connectionId, database);
      }}
      onClose={onClose}
    />
  );
}
