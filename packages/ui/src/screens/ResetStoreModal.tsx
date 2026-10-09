import { Alert, Button, Group, Modal, Stack, Text, TextInput } from '@mantine/core';
import { toAppError } from '@mongo-gui/core';
import { useState } from 'react';
import { useAppStore } from '../state/app-store-context';

export interface ResetStoreModalProps {
  readonly opened: boolean;
  readonly onClose: () => void;
}

const CONFIRMATION = 'DELETE';

/** Deletes the whole store after the user types DELETE. There is no undo. */
export function ResetStoreModal({ opened, onClose }: ResetStoreModalProps) {
  const reset = useAppStore((state) => state.reset);
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | undefined>(undefined);

  async function handleReset() {
    setBusy(true);
    setFailure(undefined);
    try {
      await reset();
    } catch (error) {
      setFailure(toAppError(error).message);
      setBusy(false);
    }
  }

  return (
    <Modal opened={opened} onClose={onClose} title="Reset store" centered>
      <Stack gap="sm">
        <Text size="sm">
          This deletes every saved connection, history entry and favourite. It cannot be undone.
          Type {CONFIRMATION} to confirm.
        </Text>
        <TextInput
          label="Confirmation"
          placeholder={CONFIRMATION}
          value={typed}
          onChange={(event) => setTyped(event.currentTarget.value)}
          autoComplete="off"
        />
        {failure === undefined ? null : (
          <Alert color="red" variant="light">
            {failure}
          </Alert>
        )}
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            Cancel
          </Button>
          <Button
            color="red"
            disabled={typed !== CONFIRMATION}
            loading={busy}
            onClick={() => void handleReset()}
          >
            Delete store
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
