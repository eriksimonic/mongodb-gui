import { Alert, Button, Group, Modal, Stack, Text } from '@mantine/core';
import { errorText } from './notify-error';
import { TypedNameConfirm } from './TypedNameConfirm';
import { useState, type ReactNode } from 'react';

export interface ConfirmDialogProps {
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
export function ConfirmDialog({
  title,
  description,
  confirmLabel,
  typedConfirmation,
  confirmDisabled = false,
  confirmColor = 'red',
  onConfirm,
  onClose,
}: ConfirmDialogProps) {
  const [typedMatched, setTypedMatched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const typedMatches = typedConfirmation === undefined || typedMatched;
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
    <Modal opened onClose={onClose} title={title} centered size={440}>
      <Stack gap="sm">
        <Text size="sm">{description}</Text>
        {typedConfirmation === undefined ? null : (
          <TypedNameConfirm expected={typedConfirmation} onMatchChange={setTypedMatched} />
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
