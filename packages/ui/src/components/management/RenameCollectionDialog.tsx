import { Alert, Button, Checkbox, Group, Modal, Stack, Text, TextInput } from '@mantine/core';
import { toAppError } from '@mongo-gui/core';
import { useState } from 'react';
import { useUiApi } from '../../api/ui-api';
import { collectionNameError } from '../../management/input-rules';

export interface RenameCollectionDialogProps {
  readonly connectionId: string;
  readonly database: string;
  readonly collection: string;
  readonly onClose: () => void;
}

/** Renames a collection. With the target box ticked, an existing collection of the new name is dropped first. */
export function RenameCollectionDialog({
  connectionId,
  database,
  collection,
  onClose,
}: RenameCollectionDialogProps) {
  const { rpc } = useUiApi();
  const [newName, setNewName] = useState(collection);
  const [dropTarget, setDropTarget] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const trimmed = newName.trim();
  const problem =
    trimmed === collection
      ? 'The new name must differ from the current name'
      : collectionNameError(trimmed);
  const valid = problem === undefined;

  async function submit() {
    setBusy(true);
    setError(undefined);
    try {
      await rpc.management.renameCollection({
        connectionId,
        database,
        name: collection,
        newName: trimmed,
        dropTarget,
      });
      onClose();
    } catch (failure) {
      setError(toAppError(failure).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal opened onClose={onClose} title={`Rename ${collection}`} centered size="sm">
      <Stack gap="sm">
        <TextInput
          label="New name"
          value={newName}
          onChange={(event) => setNewName(event.currentTarget.value)}
          error={trimmed === '' ? undefined : problem}
          autoFocus
          autoComplete="off"
        />
        <Checkbox
          label="Drop the target collection if it exists"
          checked={dropTarget}
          onChange={(event) => setDropTarget(event.currentTarget.checked)}
        />
        {dropTarget ? (
          <Text size="sm" c="red">
            A collection that already has the new name is deleted with its documents and indexes.
          </Text>
        ) : null}
        {error === undefined ? null : (
          <Alert color="red" variant="light">
            {error}
          </Alert>
        )}
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={!valid} loading={busy} onClick={() => void submit()}>
            Rename
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
