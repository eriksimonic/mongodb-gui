import { Alert, Button, Group, Modal, Stack, Text, TextInput } from '@mantine/core';
import { useState } from 'react';
import { errorText } from '../notify-error';
import { useAppStoreApi } from '../../state/app-store-context';

export interface SaveFavouriteDialogProps {
  readonly code: string;
  readonly connectionId: string;
  readonly database: string;
  /** The tab the code came from. Saving marks it saved. */
  readonly tabId?: string | undefined;
  readonly onClose: () => void;
}

/** Asks for a name and an optional folder, then saves the code as a favourite. */
export function SaveFavouriteDialog({
  code,
  connectionId,
  database,
  tabId,
  onClose,
}: SaveFavouriteDialogProps) {
  const store = useAppStoreApi();
  const [name, setName] = useState('');
  const [folder, setFolder] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const trimmed = name.trim();

  async function save() {
    if (trimmed === '') {
      setError('Give the favourite a name.');
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      await store.getState().saveFavourite({
        name: trimmed,
        folder,
        code,
        connectionId,
        database,
        tabId,
      });
      onClose();
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal opened onClose={onClose} title="Save as favourite" centered size="sm">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <Stack gap="sm">
          <TextInput
            label="Name"
            value={name}
            required
            data-autofocus
            onChange={(event) => setName(event.currentTarget.value)}
          />
          <TextInput
            label="Folder"
            description="Optional. Favourites group under their folder."
            value={folder}
            onChange={(event) => setFolder(event.currentTarget.value)}
          />
          <Text size="xs" c="dimmed" lineClamp={2}>
            {code}
          </Text>
          {error === undefined ? null : (
            <Alert color="red" variant="light">
              {error}
            </Alert>
          )}
          <Group justify="flex-end">
            <Button variant="default" onClick={onClose}>
              Cancel
            </Button>
            <Button type="button" loading={busy} onClick={() => void save()}>
              Save
            </Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  );
}
