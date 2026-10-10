import { Alert, Button, Group, Modal, Stack, Text, TextInput } from '@mantine/core';
import { errorText } from '../notify-error';
import { useState, type ReactNode } from 'react';

export interface DestructiveDialogProps {
  readonly title: string;
  readonly description: ReactNode;
  readonly confirmLabel: string;
  /** When set, the confirm button stays disabled until the user types this text exactly. */
  readonly typedConfirmation?: string | undefined;
  /** Holds the confirm button, for example while a count is still loading. */
  readonly confirmDisabled?: boolean;
  /** The confirm button colour. Defaults to red for actions that destroy data. */
  readonly confirmColor?: string;
  readonly onConfirm: () => Promise<void>;
  readonly onClose: () => void;
}

/**
 * A confirmation for an action that destroys data. Drops type the name first. Other actions
 * need only the button press, and the description says what the action deletes.
 */
export function DestructiveDialog({
  title,
  description,
  confirmLabel,
  typedConfirmation,
  confirmDisabled = false,
  confirmColor = 'red',
  onConfirm,
  onClose,
}: DestructiveDialogProps) {
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const typedMatches = typedConfirmation === undefined || typed === typedConfirmation;
  const disabled = !typedMatches || confirmDisabled || busy;

  async function confirm() {
    setBusy(true);
    setError(undefined);
    try {
      await onConfirm();
      onClose();
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal opened onClose={onClose} title={title} centered size="sm">
      <Stack gap="sm">
        <Text size="sm">{description}</Text>
        {typedConfirmation === undefined ? null : (
          <TextInput
            label={`Type ${typedConfirmation} to confirm`}
            aria-label={`Type ${typedConfirmation} to confirm`}
            value={typed}
            onChange={(event) => setTyped(event.currentTarget.value)}
            autoComplete="off"
            spellCheck={false}
          />
        )}
        {error === undefined ? null : (
          <Alert color="red" variant="light">
            {error}
          </Alert>
        )}
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            Cancel
          </Button>
          <Button
            color={confirmColor}
            disabled={disabled}
            loading={busy}
            onClick={() => void confirm()}
          >
            {confirmLabel}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
