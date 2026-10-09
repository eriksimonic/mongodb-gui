import { Alert, Button, Group, Modal, Stack, Text, TextInput } from '@mantine/core';
import { toAppError } from '@mongo-gui/core';
import { useState } from 'react';
import { useUiApi } from '../../api/ui-api';
import { collectionNameError, databaseNameError } from '../../management/input-rules';

export interface CreateDatabaseDialogProps {
  readonly connectionId: string;
  readonly onClose: () => void;
}

/**
 * New database. MongoDB has no separate create step, so the dialog makes the database with its
 * first collection.
 */
export function CreateDatabaseDialog({ connectionId, onClose }: CreateDatabaseDialogProps) {
  const { rpc } = useUiApi();
  const [database, setDatabase] = useState('');
  const [collection, setCollection] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const databaseProblem = databaseNameError(database);
  const collectionProblem = collectionNameError(collection);
  const valid = databaseProblem === undefined && collectionProblem === undefined;

  async function submit() {
    setBusy(true);
    setError(undefined);
    try {
      await rpc.management.createDatabase({
        connectionId,
        database,
        initialCollection: collection,
      });
      onClose();
    } catch (failure) {
      setError(toAppError(failure).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal opened onClose={onClose} title="New database" centered size="sm">
      <Stack gap="sm">
        <Text size="sm" c="dimmed">
          MongoDB creates a database when it first holds a collection, so the first collection is
          created with it.
        </Text>
        <TextInput
          label="Database name"
          value={database}
          onChange={(event) => setDatabase(event.currentTarget.value)}
          error={database === '' ? undefined : databaseProblem}
          autoFocus
          autoComplete="off"
        />
        <TextInput
          label="Initial collection name"
          value={collection}
          onChange={(event) => setCollection(event.currentTarget.value)}
          error={collection === '' ? undefined : collectionProblem}
          autoComplete="off"
        />
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
            Create database
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
